import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb, getDb } from './lib/db.mjs';
import { handleRequest } from './lib/routes.mjs';
import { createAuth } from './lib/auth.mjs';
import { handleMcp } from './lib/mcp-server.mjs';
import { runAs } from './lib/identity.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
function notifyComment({book_id,from_who,content}){
  const command=process.env.COREAD_NOTIFY_CMD;
  if(!command || ((process.env.COREAD_NOTIFY_FROM||'human')!=='*' && from_who!==(process.env.COREAD_NOTIFY_FROM||'human')))return;
  const db=getDb(true);let title;try{title=db.prepare('SELECT title FROM books WHERE id=?').get(book_id)?.title||String(book_id);}finally{db.close();}
  execFile('/bin/sh',['-c',command],{timeout:15000,env:{...process.env,COREAD_BOOK_ID:String(book_id),COREAD_BOOK_TITLE:title,COREAD_FROM:from_who,COREAD_COMMENT:content||''}},error=>{if(error)console.error('Comment notification failed');});
}
export async function startServer(options={}){
  const dbPath=options.dbPath||process.env.COREAD_DB||path.join(process.cwd(),'data/coread.db');
  initDb(dbPath);
  const auth=createAuth({publicUrl:options.publicUrl||process.env.COREAD_PUBLIC_URL,
    passwordDigest:options.passwordDigest||process.env.COREAD_PASSWORD_HASH,
    dbPath:dbPath+'.auth',allowLoopback:options.allowLoopback===true});
  const app=express();app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(auth.base.protocol==='https:')res.setHeader('Strict-Transport-Security','max-age=31536000');
    res.setHeader('Cache-Control','no-store');
    // 跨源拦截：非浏览器端点一律要求 Origin 与本站一致。
    // 浏览器表单端点（登录/同意/批准）放行到各自端点，由 CSRF token、一次性票据
    // 或密码校验把关；明确第三方 Origin 仍会在端点内部被拒。
    const browserFormPaths=['/auth/consent','/auth/consent/login','/auth/approve','/auth/logout','/auth/revoke-all'];
    if(req.headers.origin && req.headers.origin!==auth.base.origin && !['/token','/register','/revoke'].includes(req.path) && !browserFormPaths.includes(req.path)){
      console.error('[security] cross-origin blocked method=%s path=%s origin=%j secFetchSite=%j',
        req.method,req.path,req.headers.origin,req.headers['sec-fetch-site']||null);
      return res.sendStatus(403);
    }
    next();
  });
  // 访问日志：只记录方法/路径/状态与请求头元数据，绝不记录 cookie、csrf 或正文。
  // 健康检查每次心跳都打，会淹没日志，这里排除。
  app.use((req,res,next)=>{
    if(req.path!=='/healthz')res.on('finish',()=>{
      console.error('[access] %s %s status=%s origin=%j secFetchSite=%j secFetchMode=%j',
        req.method,req.originalUrl||req.path,res.statusCode,
        req.headers.origin||null,req.headers['sec-fetch-site']||null,req.headers['sec-fetch-mode']||null);
    });
    next();
  });
  app.use(auth.router);
  app.get('/healthz',(_req,res)=>res.json({status:'ok',service:'zhilan-coread',version:'0.2.0'}));
  app.all('/mcp',async(req,res,next)=>{
    try{
      const match=/^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization||''));
      if(!match)return auth.unauthorized(res);
      let token;try{token=await auth.provider.verifyAccessToken(match[1]);}catch{return auth.unauthorized(res);}
      req.auth=token;
      if(req.method!=='POST')return res.status(405).set('Allow','POST').json({error:'Use Streamable HTTP POST'});
      express.json({limit:'32mb'})(req,res,error=>{if(error)return next(error);void handleMcp(req,res,{role:'ai',scopes:token.scopes}).catch(next);});
    }catch(error){next(error);}
  });
  app.use('/v1',async(req,res,next)=>{
    const owner=auth.human(req);
    if(!owner)return auth.unauthorized(res);
    if(!['GET','HEAD','OPTIONS'].includes(req.method) && !auth.requireCsrf(req,res))return;
    req.actor=owner;
    req.publicOrigin=auth.base.origin;
    const original=req.url;req.url='/v1'+req.url;
    try{const handled=await runAs(owner,()=>handleRequest(req,res,{onComment:notifyComment}));if(!handled)res.sendStatus(404);}
    catch(error){next(error);}finally{req.url=original;}
  });
  app.use('/sse',(_req,res)=>res.status(410).json({error:'Use /mcp with OAuth'}));
  app.use('/messages',(_req,res)=>res.status(410).json({error:'Use /mcp with OAuth'}));
  app.use(express.static(path.join(directory,'public'),{index:'index.html',setHeaders:res=>res.setHeader('Cache-Control','no-store')}));
  app.use((req,res)=>{if(req.method==='GET' && !path.extname(req.path))res.sendFile(path.join(directory,'public/index.html'));else res.sendStatus(404);});
  app.use((error,_req,res,_next)=>{if(res.headersSent){res.end();return;}res.status(error.status||500).json({error:error.status===413?'Request too large':'Request failed'});});
  const server=http.createServer(app);server.requestTimeout=60000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port??Number(process.env.COREAD_PORT||3000),options.host||process.env.COREAD_HOST||'127.0.0.1',resolve);});
  server.on('close',()=>auth.close());
  return {server,auth};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startServer().then(({server})=>console.error('共读室已启动，端口 '+server.address().port+'；网页 /，MCP /mcp')).catch(error=>{console.error(error.message);process.exitCode=1;});
}
