import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError, InvalidScopeError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { HUMAN } from './identity.mjs';

const Database=createRequire(import.meta.url)('better-sqlite3');
const scrypt=promisify(crypto.scrypt);
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const random=()=>crypto.randomBytes(32).toString('base64url');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SCOPES=['reading:read','reading:write'];
export async function passwordHash(password){const salt=random();return `scrypt:${salt}:${Buffer.from(await scrypt(password,salt,64)).toString('hex')}`;}
async function passwordMatches(password,encoded){
  if(typeof password!=='string' || password.length>1024) return false;
  const [kind,salt,value]=encoded.split(':');
  if(kind!=='scrypt' || !salt || !/^[a-f0-9]{128}$/.test(value||'')) return false;
  return crypto.timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(await scrypt(password,salt,64)));
}
const page=(title,body)=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.7 system-ui;background:#f5f2eb;color:#302d27;max-width:440px;margin:12vh auto;padding:24px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin:8px 0}button{cursor:pointer}small{overflow-wrap:anywhere}</style><h1>${title}</h1>${body}</html>`;

export function createAuth({publicUrl,passwordDigest,dbPath,allowLoopback=false}){
  const base=new URL(publicUrl);
  if(base.username || base.password || base.pathname!=='/' || base.search || base.hash ||
    (base.protocol!=='https:' && !(allowLoopback && ['localhost','127.0.0.1'].includes(base.hostname)))) throw Error('A root HTTPS COREAD_PUBLIC_URL is required');
  if(!/^scrypt:[A-Za-z0-9_-]+:[a-f0-9]{128}$/.test(passwordDigest||'')) throw Error('Configure COREAD_PASSWORD_HASH before starting');
  const resource=new URL('/mcp',base).href;
  const authdb=new Database(dbPath);
  try{fs.chmodSync(dbPath,0o600);}catch{}
  authdb.pragma('journal_mode=WAL');
  authdb.exec('CREATE TABLE IF NOT EXISTS entries(kind TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(kind,key));');
  const fingerprint=hash(passwordDigest);
  const previous=authdb.prepare("SELECT data FROM entries WHERE kind='credential' AND key='owner'").get();
  if(previous && previous.data!==fingerprint)authdb.prepare("DELETE FROM entries WHERE kind!='client'").run();
  authdb.prepare("INSERT OR REPLACE INTO entries VALUES('credential','owner',?,0)").run(fingerprint);
  const clean=()=>authdb.prepare('DELETE FROM entries WHERE expires>0 AND expires<?').run(Date.now());
  const put=(kind,key,data,ttl)=>{clean();authdb.prepare('INSERT OR REPLACE INTO entries VALUES(?,?,?,?)').run(kind,hash(key),JSON.stringify(data),ttl===0?0:Date.now()+ttl);};
  const get=(kind,key)=>{const r=authdb.prepare('SELECT data,expires FROM entries WHERE kind=? AND key=?').get(kind,hash(key));return r && (!r.expires || r.expires>Date.now())?JSON.parse(r.data):null;};
  const del=(kind,key)=>authdb.prepare('DELETE FROM entries WHERE kind=? AND key=?').run(kind,hash(key));
  const secure=base.protocol==='https:';
  const cookieName=secure?'__Host-coread-session':'coread-session';
  const cookie=(token,age)=>`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
  const session=req=>{
    const token=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    return token?get('session',token):null;
  };
  const crossSite=req=>req.headers['sec-fetch-site']==='cross-site';
  const sameOrigin=req=>req.headers.origin===base.origin && !crossSite(req);
  // 不透明来源（Origin 缺失或 "null"）：典型是第三方客户端把授权页放进 sandbox iframe，
  // 浏览器此时无法给出可校验的 Origin。这类请求不放行，除非另外握有服务端签发的凭据。
  const opaqueOrigin=req=>{const o=String(req.headers.origin||'');return o===''||o==='null';};
  // 同源，或"不透明来源 + 浏览器声明非跨站"——凭据仍需 CSRF token / 票据把关。
  const trustedSource=req=>sameOrigin(req)||(opaqueOrigin(req)&&!crossSite(req));
  const requireCsrf=(req,res)=>{
    const s=session(req);
    const provided=req.headers['x-csrf-token']||req.body?.csrf;
    const originOk=trustedSource(req);
    const csrfOk=!!s && provided===s.csrf;
    if(!s || !originOk || !csrfOk){
      // 安全审计日志：只记录路径与布尔判断，绝不记录 csrf/cookie 的具体值。
      console.error('[security] csrf denied path=%s method=%s originOk=%s csrfOk=%s hasSession=%s',
        req.path,req.method,originOk,csrfOk,!!s);
      res.status(403).json({error:'Owner session and same-origin CSRF token required'});return null;
    }
    return s;
  };
  const login=async(req,res,password,{allowOpaque=false}={})=>{
    const originOk=allowOpaque?trustedSource(req):sameOrigin(req);
    if(!originOk || !(await passwordMatches(password,passwordDigest))) return false;
    const old=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(old)del('session',old);
    const token=random(),s={csrf:random(),id:random()};put('session',token,s,7*86400000);res.setHeader('Set-Cookie',cookie(token,7*86400));return true;
  };
  const scoped=scopes=>{if(scopes.some(s=>!SCOPES.includes(s)) || (scopes.includes('reading:write')&&!scopes.includes('reading:read')))throw new InvalidScopeError('Writing requires shared reading access');return scopes.length?scopes:SCOPES;};
  const targeted=value=>{if(value && value.href!==resource)throw new InvalidTargetError('Wrong resource');return resource;};
  const issue=(clientId,scopes,family=random())=>{
    const access=random(),refresh=random();
    put('family',family,{active:true},31*86400000);
    const data={clientId,scopes,family,resource,expiresAt:Math.floor(Date.now()/1000)+3600};
    put('access',access,data,3600000);put('refresh',refresh,data,30*86400000);
    return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:scopes.join(' ')};
  };
  const provider={
    clientsStore:{
      getClient:async id=>get('client',id),
      registerClient:async info=>{
        if((info.redirect_uris?.length||0)<1 || info.redirect_uris.length>5 || info.redirect_uris.some(uri=>{
          try{const u=new URL(uri);return u.username||u.password||u.hash||u.href.length>2048 ||
            !(u.protocol==='https:' || (u.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)));}catch{return true;}
        }))throw new InvalidClientMetadataError('HTTPS or loopback redirect URIs are required');
        if(!['none','client_secret_post',undefined].includes(info.token_endpoint_auth_method))throw new InvalidClientMetadataError('Unsupported client authentication');
        clean();if(authdb.prepare("SELECT COUNT(*) n FROM entries WHERE kind='client'").get().n>=1000)throw new InvalidClientMetadataError('Registration limit reached');
        const client={...info,client_id:info.client_id||random(),client_id_issued_at:Math.floor(Date.now()/1000)};
        put('client',client.client_id,client,86400000);return client;
      }
    },
    authorize:async(client,params,res)=>{
      targeted(params.resource);const scopes=scoped(params.scopes||[]);
      if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))throw new InvalidGrantError('Invalid S256 challenge');
      const id=random();put('pending',id,{clientId:client.client_id,...params,resource,scopes},10*60000);
      res.redirect('/auth/consent?request='+id);
    },
    challengeForAuthorizationCode:async(client,code)=>{
      const c=get('code',code);if(!c || c.clientId!==client.client_id)throw new InvalidGrantError('Invalid authorization code');return c.codeChallenge;
    },
    exchangeAuthorizationCode:async(client,code,_verifier,redirectUri,target)=>authdb.transaction(()=>{
      const c=get('code',code);
      if(!c || c.clientId!==client.client_id || redirectUri!==c.redirectUri)throw new InvalidGrantError('Invalid authorization code');
      targeted(target);del('code',code);return issue(client.client_id,c.scopes);
    }).immediate(),
    exchangeRefreshToken:async(client,token,requested,target)=>authdb.transaction(()=>{
      if(get('spent',token)) {const r=get('spent',token);if(r.clientId!==client.client_id)throw new InvalidGrantError('Wrong client');del('family',r.family);return {error:'replay'};}
      const r=get('refresh',token);
      if(!r || r.clientId!==client.client_id || !get('family',r.family))throw new InvalidGrantError('Invalid refresh token');
      targeted(target);const scopes=requested||r.scopes;if(scopes.some(s=>!r.scopes.includes(s)))throw new InvalidScopeError('Cannot expand scopes');
      del('refresh',token);put('spent',token,{family:r.family,clientId:r.clientId},30*86400000);return issue(client.client_id,scopes,r.family);
    }).immediate(),
    verifyAccessToken:async token=>{
      const r=get('access',token);
      if(!r || r.resource!==resource || !get('family',r.family))throw new InvalidTokenError('Invalid or expired access token');
      return {token,clientId:r.clientId,scopes:r.scopes,expiresAt:r.expiresAt,resource:new URL(r.resource)};
    },
    revokeToken:async(client,request)=>{
      const r=get('access',request.token)||get('refresh',request.token);
      if(r && r.clientId===client.client_id)del('family',r.family);
    }
  };
  const rotate=provider.exchangeRefreshToken;
  provider.exchangeRefreshToken=async(...args)=>{const t=await rotate(...args);if(t.error)throw new InvalidGrantError('Refresh token replay');return t;};
  const router=express.Router();
  const limited=rateLimit({windowMs:15*60000,limit:15,standardHeaders:true,legacyHeaders:false,validate:{xForwardedForHeader:false}});
  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/auth/session',(req,res)=>{const s=session(req);res.json(s?{authenticated:true,csrf:s.csrf,cache_namespace:s.id}:{authenticated:false});});
  router.post('/auth/login',limited,express.json({limit:'4kb'}),async(req,res)=>{
    if(await login(req,res,req.body?.password))res.json({ok:true});else res.status(401).json({error:'登录失败，请核对密码或稍后重试'});
  });
  router.post('/auth/logout',express.json({limit:'4kb'}),(req,res)=>{
    if(!requireCsrf(req,res))return;
    const t=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(t)del('session',t);res.setHeader('Set-Cookie',cookie('',0));res.json({ok:true});
  });
  router.post('/auth/revoke-all',express.json({limit:'4kb'}),(req,res)=>{if(!requireCsrf(req,res))return;authdb.prepare("DELETE FROM entries WHERE kind IN ('access','refresh','spent','family','code','pending')").run();res.json({ok:true});});
  router.get('/auth/consent',(req,res)=>{
    const id=String(req.query.request||''),pending=get('pending',id);
    if(!pending)return res.status(400).send(page('授权已过期','请从 Work 重新连接。'));
    const client=get('client',pending.clientId),s=session(req);
    // 授权页可能被客户端嵌在 iframe 里；iframe 内操作失败时给出顶层地址兜底。
    const openHint=`<p style="margin-top:22px;font-size:13px;color:#6b6459;line-height:1.6">如果本页面显示在聊天窗口里点不动或一直转圈，请复制下面地址到浏览器新标签页打开后再操作：<br><code style="word-break:break-all">${esc(base.origin+'/auth/consent?request='+id)}</code></p>`;
    if(!s)return res.type('html').send(page('登录共读室',`<p>登录后可确认 Work 的连接请求。</p><form method="post" action="/auth/consent/login"><input type="hidden" name="request" value="${esc(id)}"><input type="password" name="password" autocomplete="current-password" aria-label="共读室密码" required><button>登录</button></form>${openHint}`));
    // form-action also applies to redirects in Chromium. Allow only the registered callback origin.
    res.setHeader('Content-Security-Policy',`default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${new URL(pending.redirectUri).origin}`);
    res.type('html').send(page('允许连接共读室？',`<p>${esc(client?.client_name||'MCP 客户端')}</p><small>回调：${esc(new URL(pending.redirectUri).origin)}</small><p>可读取已分享的书页和批注${pending.scopes.includes('reading:write')?'，并以岚的身份写批注、回复和阅读进度':''}。不能读取私密草稿、主动分享或管理书库。</p><form method="post" action="/auth/approve"><input type="hidden" name="request" value="${esc(id)}"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button name="decision" value="allow">允许连接</button><button name="decision" value="deny">取消</button></form>${openHint}`));
  });
  router.post('/auth/consent/login',limited,express.urlencoded({extended:false,limit:'4kb'}),async(req,res)=>{
    const id=String(req.body.request||'');
    if(!get('pending',id))return res.sendStatus(400);
    // allowOpaque：客户端把授权页放进 iframe 时浏览器给不出可校验的 Origin，
    // 这里仍然要求「共读室密码正确 + 一次性 pending 有效」，随后签发一次性票据。
    if(await login(req,res,req.body.password,{allowOpaque:true})){
      const ticket=random();put('ticket',ticket,{pendingId:id},5*60000);
      return res.redirect('/auth/approve?ticket='+encodeURIComponent(ticket)+'&request='+encodeURIComponent(id));
    }
    res.status(401).send(page('登录失败','请返回重试。'));
  });
  router.get('/auth/approve',(req,res)=>{
    const ticket=String(req.query.ticket||'');
    const t=ticket?get('ticket',ticket):null;
    if(!t)return res.status(400).send(page('授权已过期','请从 Work 重新连接。'));
    const pending=get('pending',t.pendingId);
    if(!pending)return res.status(400).send(page('授权已过期','请重新连接。'));
    const client=get('client',pending.clientId);
    res.setHeader('Content-Security-Policy',`default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${new URL(pending.redirectUri).origin}`);
    res.type('html').send(page('允许连接共读室？',`<p>${esc(client?.client_name||'MCP 客户端')}</p><small>回调：${esc(new URL(pending.redirectUri).origin)}</small><p>可读取已分享的书页和批注${pending.scopes.includes('reading:write')?'，并以岚的身份写批注、回复和阅读进度':''}。不能读取私密草稿、主动分享或管理书库。</p><form method="post" action="/auth/approve"><input type="hidden" name="ticket" value="${esc(ticket)}"><input type="hidden" name="request" value="${esc(t.pendingId)}"><button name="decision" value="allow">允许连接</button><button name="decision" value="deny">取消</button></form>`));
  });
  router.post('/auth/approve',express.urlencoded({extended:false,limit:'4kb'}),(req,res)=>{
    const ticket=String(req.body?.ticket||req.query?.ticket||'');
    let pending=null,id='';
    if(ticket){
      // 票据路径：票据由「密码校验通过」签发、一次性、5 分钟有效，本身就是批准凭据。
      const t=get('ticket',ticket);
      if(!t)return res.status(403).json({error:'Invalid or expired approval ticket'});
      del('ticket',ticket);
      id=t.pendingId;
      pending=get('pending',id);
      if(!pending)return res.status(400).send(page('授权已过期','请重新连接。'));
    }else{
      if(!requireCsrf(req,res))return;
      id=String(req.body.request||'');
      const p=get('pending',id);
      if(!p)return res.status(400).send(page('授权已过期','请重新连接。'));
      pending=p;
    }
    const url=new URL(pending.redirectUri);
    authdb.transaction(()=>{
      del('pending',id);
      if(req.body.decision==='allow'){
        const code=random();put('code',code,pending,120000);url.searchParams.set('code',code);
        const client=get('client',pending.clientId);if(client)put('client',pending.clientId,client,0);
      }else url.searchParams.set('error','access_denied');
    }).immediate();
    if(pending.state!==undefined)url.searchParams.set('state',pending.state);
    res.redirect(url.href);
  });
  router.use(mcpAuthRouter({provider,issuerUrl:base,resourceServerUrl:new URL(resource),scopesSupported:SCOPES,resourceName:'知岚共读室',
    clientRegistrationOptions:{clientSecretExpirySeconds:0,rateLimit:{validate:{xForwardedForHeader:false}}},
    authorizationOptions:{rateLimit:{validate:{xForwardedForHeader:false}}},tokenOptions:{rateLimit:{validate:{xForwardedForHeader:false}}},revocationOptions:{rateLimit:{validate:{xForwardedForHeader:false}}}}));
  return {router,provider,base,resource,close:()=>authdb.close(),requireCsrf,
    human:req=>session(req)?HUMAN:null,
    unauthorized:res=>res.status(401).set('WWW-Authenticate',`Bearer resource_metadata="${base.origin}/.well-known/oauth-protected-resource/mcp", scope="reading:read reading:write"`).json({error:'authentication_required'})};
}
