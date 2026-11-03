import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server.mjs';
import { passwordHash } from '../lib/auth.mjs';
import { getDb } from '../lib/db.mjs';

const publicOrigin='https://reading.ddnsto.com';
const resource=publicOrigin+'/mcp';
const secret='LOCAL TEST PASSWORD ONLY';

test('single-entry OAuth, private threads, recent activity, exports and recovery',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coread-security-'));
  const dbPath=path.join(dir,'library.db'),digest=await passwordHash(secret);
  let running=await startServer({port:0,publicUrl:publicOrigin,passwordDigest:digest,dbPath});
  let base='http://127.0.0.1:'+running.server.address().port;
  const clients=[];
  t.after(async()=>{for(const c of clients)await c.close();running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  let cookie='',csrf='';
  async function request(url,method='GET',body,extra={}){
    const headers={...extra};
    if(cookie)headers.cookie=cookie;
    if(body!==undefined && !(body instanceof Buffer)){headers['content-type']='application/json';body=JSON.stringify(body);}
    if(!['GET','HEAD'].includes(method)){headers.origin=publicOrigin;if(csrf)headers['x-csrf-token']=csrf;}
    const res=await fetch(base+url,{method,headers,body,redirect:'manual'});return res;
  }
  const json=async(url,method='GET',body,headers={})=>{const r=await request(url,method,body,headers);assert.ok(r.ok,await r.clone().text());return r.json();};
  async function grant(scopes='reading:read reading:write'){
    const registration=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Integration Work client',redirect_uris:['https://chatgpt.com/aip/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    assert.equal(registration.status,201,await registration.clone().text());const info=await registration.json();
    const verifier=crypto.randomBytes(40).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const q=new URLSearchParams({client_id:info.client_id,redirect_uri:info.redirect_uris[0],response_type:'code',scope:scopes,state:'opaque-test-state',code_challenge:challenge,code_challenge_method:'S256',resource});
    const authorization=await request('/authorize?'+q);assert.equal(authorization.status,302,await authorization.clone().text());
    const consent=authorization.headers.get('location');assert.match(consent,/^\/auth\/consent\?request=/);
    const consentHtml=await request(consent);assert.match(consentHtml.headers.get('content-security-policy'),/https:\/\/chatgpt.com/);assert.match(await consentHtml.text(),/允许连接共读室/);
    const id=new URL(consent,publicOrigin).searchParams.get('request');
    const approval=await request('/auth/approve','POST',Buffer.from(new URLSearchParams({request:id,csrf,decision:'allow'}).toString()),{'content-type':'application/x-www-form-urlencoded'});
    assert.equal(approval.status,302,await approval.clone().text());
    const callback=new URL(approval.headers.get('location'));assert.equal(callback.searchParams.get('state'),'opaque-test-state');
    const form={client_id:info.client_id,code:callback.searchParams.get('code'),code_verifier:verifier,redirect_uri:info.redirect_uris[0],resource,grant_type:'authorization_code'};
    const exchange=async data=>fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});
    const wrong=await exchange({...form,code_verifier:'wrong'});assert.equal(wrong.status,400);
    const wrongResource=await exchange({...form,resource:'https://other.example/mcp'});assert.equal(wrongResource.status,400);
    const tokenRes=await exchange(form);assert.equal(tokenRes.status,200,await tokenRes.clone().text());const token=await tokenRes.json();
    assert.equal((await exchange(form)).status,400,'authorization code is single-use');
    return {...token,client_id:info.client_id,exchange};
  }
  async function mcp(token){const c=new Client({name:'security-tests',version:'1.0'});await c.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));clients.push(c);return c;}
  const call=async(client,name,args={})=>{const result=await client.callTool({name,arguments:args});return {raw:result,value:result.content[0]?.type==='text'?JSON.parse(result.content[0].text):null};};

  await t.test('anonymous and cross-origin access is denied',async()=>{
    for(const url of ['/v1/books','/v1/books/1','/v1/books/1/new-replies','/v1/book-images/1/cover.png','/v1/books/1/export','/mcp'])assert.equal((await request(url)).status,401,url);
    assert.equal((await request('/v1/books/1','DELETE')).status,401);
    assert.equal((await request('/v1/backup/export','POST',{})).status,401);
    assert.equal((await fetch(base+'/auth/login',{method:'POST',headers:{origin:'https://attacker.test','content-type':'application/json'},body:JSON.stringify({password:secret})})).status,403);
    const metadata=await json('/.well-known/oauth-protected-resource/mcp');assert.equal(metadata.resource,resource);
    const as=await json('/.well-known/oauth-authorization-server');assert.equal(as.issuer,publicOrigin+'/');assert.ok(as.code_challenge_methods_supported.includes('S256'));
    assert.match((await request('/mcp')).headers.get('www-authenticate'),/resource_metadata/);
  });
  await t.test('approval from an opaque-origin client works through a one-time ticket',async()=>{
    const registration=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Embedded client',redirect_uris:['https://chatgpt.com/aip/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})});
    assert.equal(registration.status,201,await registration.clone().text());const info=await registration.json();
    const verifier=crypto.randomBytes(40).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const q=new URLSearchParams({client_id:info.client_id,redirect_uri:info.redirect_uris[0],response_type:'code',scope:'reading:read',state:'opaque-state',code_challenge:challenge,code_challenge_method:'S256',resource});
    const authorization=await request('/authorize?'+q);assert.equal(authorization.status,302,await authorization.clone().text());
    const id=new URL(authorization.headers.get('location'),publicOrigin).searchParams.get('request');
    const form={request:id,password:secret};
    // 明确第三方来源仍然拿不到批准凭据。
    const third=await fetch(base+'/auth/consent/login',{method:'POST',headers:{origin:'https://attacker.test','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),redirect:'manual'});
    assert.equal(third.status,401);
    // 不透明来源（客户端把授权页放进 sandbox iframe）：Origin 为 null，仍需密码正确。
    const bad=await fetch(base+'/auth/consent/login',{method:'POST',headers:{origin:'null','sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,password:'wrong'}),redirect:'manual'});
    assert.equal(bad.status,401);
    const login=await fetch(base+'/auth/consent/login',{method:'POST',headers:{origin:'null','sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),redirect:'manual'});
    assert.equal(login.status,302,await login.clone().text());
    const ticket=new URL(login.headers.get('location'),base).searchParams.get('ticket');assert.ok(ticket);
    const confirm=await fetch(base+'/auth/approve?ticket='+encodeURIComponent(ticket)+'&request='+encodeURIComponent(id),{redirect:'manual'});
    assert.equal(confirm.status,200);assert.match(await confirm.text(),/允许连接共读室/);
    const approval=await fetch(base+'/auth/approve',{method:'POST',headers:{origin:'null','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,request:id,decision:'allow'}),redirect:'manual'});
    assert.equal(approval.status,302,await approval.clone().text());
    const callback=new URL(approval.headers.get('location'));assert.equal(callback.searchParams.get('state'),'opaque-state');assert.ok(callback.searchParams.get('code'));
    // 票据一次性：用过即失效。
    const replay=await fetch(base+'/auth/approve',{method:'POST',headers:{origin:'null','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,request:id,decision:'allow'}),redirect:'manual'});
    assert.equal(replay.status,403);
  });
  await t.test('owner login uses a secure cookie and CSRF',async()=>{
    assert.equal((await request('/auth/login','POST',{password:'wrong'})).status,401);
    const login=await request('/auth/login','POST',{password:secret});assert.equal(login.status,200);
    const set=login.headers.get('set-cookie');assert.match(set,/HttpOnly/);assert.match(set,/Secure/);assert.match(set,/SameSite=Lax/);assert.match(set,/__Host-coread-session/);cookie=set.split(';')[0];
    const session=await json('/auth/session');csrf=session.csrf;
    const blocked=await fetch(base+'/v1/books',{method:'POST',headers:{cookie,origin:publicOrigin,'content-type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
  });
  const book=await json('/v1/books','POST',{title:'Security book',content:'One stable paragraph.\n\nA second paragraph with <script>alert(1)</script> as text.'});
  const bookId=book.book_id;
  const root=await json('/v1/books/'+bookId+'/comment','POST',{paragraph_idx:0,content:'PRIVATE_SENTINEL',selected_text:'stable',from_who:'ai'});
  const reply=await json('/v1/books/'+bookId+'/comment','POST',{paragraph_idx:0,content:'PRIVATE_REPLY',reply_to:root.id,visibility:'shared'});
  assert.equal(root.visibility,'private');assert.equal(root.author_role,'human');assert.equal(reply.visibility,'private');
  const grantData=await grant(),client=await mcp(grantData.access_token);
  await t.test('MCP cannot reveal private notes or publish them via extra parameters',async()=>{
    const catalog=await client.listTools();assert.equal(catalog.tools.length,11);assert.ok(catalog.tools.every(t=>t.inputSchema.additionalProperties===false));
    const listed=await call(client,'list_comments',{book_id:bookId});assert.deepEqual(listed.value,[]);
    assert.equal((await call(client,'list_books')).value[0].comment_count,0);
    const read=await call(client,'read_book',{book_id:bookId});assert.doesNotMatch(JSON.stringify(read),/PRIVATE_/);
    const snapshot=await call(client,'get_recent_activity');assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_/);
    const bypass=await client.callTool({name:'list_comments',arguments:{book_id:bookId,includePrivate:true}});assert.equal(bypass.isError,true);assert.doesNotMatch(JSON.stringify(bypass),/PRIVATE_SENTINEL/);
    assert.equal((await client.callTool({name:'share_thread',arguments:{id:root.id}})).isError,true);
    assert.equal((await client.callTool({name:'add_comment',arguments:{book_id:bookId,paragraph_idx:0,content:'probe',reply_to:root.id}})).isError,true);
    const api=await fetch(base+'/v1/books',{headers:{authorization:'Bearer '+grantData.access_token}});assert.equal(api.status,401);
    const blocked=await fetch(base+'/auth/approve',{method:'POST',headers:{authorization:'Bearer '+grantData.access_token,origin:publicOrigin,'content-type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
  });
  let cursor;
  await t.test('explicit share, incrementality and withdrawal include the complete thread',async()=>{
    cursor=(await call(client,'get_recent_activity')).value.next_cursor;
    await json('/v1/books/comment/'+root.id+'/visibility','PATCH',{visibility:'shared'});
    const after=(await call(client,'get_recent_activity',{after_cursor:cursor})).value;
    assert.match(JSON.stringify(after),/PRIVATE_SENTINEL/);assert.match(JSON.stringify(after),/PRIVATE_REPLY/);cursor=after.next_cursor;
    assert.equal((await call(client,'get_recent_activity',{after_cursor:cursor})).value.events.length,0);
    assert.equal((await client.callTool({name:'delete_comment',arguments:{comment_id:root.id}})).isError,true);
    await json('/v1/books/comment/'+root.id+'/visibility','PATCH',{visibility:'private'});
    const withdrawn=(await call(client,'get_recent_activity',{after_cursor:cursor})).value;
    assert.equal(withdrawn.events[0].kind,'withdrawn');assert.doesNotMatch(JSON.stringify(withdrawn),/PRIVATE_SENTINEL|PRIVATE_REPLY/);
    assert.deepEqual((await call(client,'list_comments',{book_id:bookId})).value,[]);
  });
  await t.test('AI authorship is enforced and every tool obeys the door',async()=>{
    const added=(await call(client,'add_comment',{book_id:bookId,paragraph_idx:0,content:'AI_SHARED',from_who:'human'})).value;
    assert.equal(added.author_role,'ai');assert.equal(added.visibility,'shared');
    await json('/v1/reading-room/door','POST',{locked:true});
    for(const [name,args] of [['list_comments',{book_id:bookId}],['list_books',{}],['get_toc',{book_id:bookId}],['delete_comment',{comment_id:added.id}],['get_recent_activity',{}]]){
      const result=await call(client,name,args);assert.equal(result.value.error,'door_locked',name);assert.equal(result.raw.isError,true);
    }
    await json('/v1/reading-room/door','POST',{locked:false});
    const settings=await json('/v1/settings');assert.deepEqual(settings,{human:'知',ai:'岚'});
    await json('/v1/settings','PATCH',{human:'知测试',ai:'岚测试'});
    assert.match((await call(client,'read_book',{book_id:bookId})).value.text,/岚测试/);
  });
  await t.test('owner exports preserve private notes, escaping, images, and versioned backup',async()=>{
    const md=await request('/v1/books/'+bookId+'/export?format=md');assert.equal(md.status,200);assert.match(await md.text(),/知测试/);
    const epub=await request('/v1/books/'+bookId+'/export');assert.equal(epub.status,200);const z=new AdmZip(Buffer.from(await epub.arrayBuffer()));
    const xhtml=z.getEntries().filter(e=>e.entryName.endsWith('.xhtml')).map(e=>z.readAsText(e)).join('');assert.match(xhtml,/&lt;script&gt;/);assert.doesNotMatch(xhtml,/<script>/);
    const zip=new AdmZip();zip.addFile('mimetype',Buffer.from('application/epub+zip'));
    zip.addFile('META-INF/container.xml',Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
    zip.addFile('book.opf',Buffer.from('<package><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="i" href="image.png" media-type="image/png"/></manifest><spine><itemref idref="c"/></spine></package>'));
    zip.addFile('chapter.xhtml',Buffer.from('<html><body><p>Image book body.</p><img src="image.png"/></body></html>'));
    zip.addFile('image.png',Buffer.from([137,80,78,71]));
    const imported=await json('/v1/books?title=EPUB&format=epub','POST',zip.toBuffer(),{'content-type':'application/octet-stream'});assert.ok(imported.book_id);
    assert.equal((await request('/v1/book-images/'+imported.book_id+'/image.png')).status,200);
    const backup=await json('/v1/backup/export','POST',{}, {'x-coread-backup':'1'});assert.equal(backup.schemaVersion,2);assert.equal(backup.data.book_comments.find(c=>c.id===root.id).visibility,'private');
    const saved=await json('/v1/coread-backup/export','POST',{settings:{'coread-font-size':'16','coread-brightness':'100','coread-night-mode':'false'}});assert.equal(saved.ok,true);
    const stored=await json('/v1/coread-backup/list','POST',{});assert.ok(stored.files.some(f=>f.file===saved.file));
    const savedPreview=await json('/v1/coread-backup/preview','POST',{file:saved.file});assert.equal(savedPreview.schemaVersion,2);
    assert.ok(backup.data.reading_log.length>0);assert.doesNotMatch(JSON.stringify(backup),new RegExp(grantData.access_token));
    const preview=await json('/v1/backup/preview','POST',backup,{'x-coread-backup':'1'});
    const beforeCursor=(await call(client,'get_recent_activity')).value.next_cursor;
    await json('/v1/backup/restore','POST',{token:preview.token,confirmed:true},{'x-coread-backup':'1'});
    const stale=await client.callTool({name:'get_recent_activity',arguments:{after_cursor:beforeCursor}});assert.equal(stale.isError,true);
    const notes=(await json('/v1/books/'+bookId)).comments;assert.equal(notes.find(c=>c.id===root.id).visibility,'private');
  });
  await t.test('persistent OAuth survives restart, read-only scope and refresh replay are enforced',async()=>{
    for(const c of clients)await c.close();clients.length=0;
    running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));
    running=await startServer({port:0,publicUrl:publicOrigin,passwordDigest:digest,dbPath});base='http://127.0.0.1:'+running.server.address().port;
    const again=await mcp(grantData.access_token);assert.equal((await again.listTools()).tools.length,11);
    const readOnly=await grant('reading:read'),reader=await mcp(readOnly.access_token);
    assert.equal((await reader.callTool({name:'add_comment',arguments:{book_id:bookId,paragraph_idx:0,content:'not permitted'}})).isError,true);
    const rotate={grant_type:'refresh_token',client_id:grantData.client_id,refresh_token:grantData.refresh_token,resource};
    const refreshed=await grantData.exchange(rotate);assert.equal(refreshed.status,200);const replacement=await refreshed.json();assert.notEqual(replacement.refresh_token,grantData.refresh_token);
    assert.equal((await grantData.exchange(rotate)).status,400);
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+replacement.access_token}})).status,401);
  });
  await t.test('revoking connections and changing the owner password invalidate existing grants',async()=>{
    const fresh=await grant();
    await json('/auth/revoke-all','POST',{});
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+fresh.access_token}})).status,401);
    const freshAgain=await grant();
    for(const c of clients)await c.close();clients.length=0;
    running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));
    const nextPassword='ANOTHER LOCAL TEST PASSWORD';
    running=await startServer({port:0,publicUrl:publicOrigin,passwordDigest:await passwordHash(nextPassword),dbPath});base='http://127.0.0.1:'+running.server.address().port;
    assert.equal((await request('/v1/books')).status,401);
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+freshAgain.access_token}})).status,401);
    assert.equal((await request('/auth/login','POST',{password:secret})).status,401);
    const login=await request('/auth/login','POST',{password:nextPassword});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await json('/auth/session')).csrf;
  });
  await t.test('logout revokes the owner cookie',async()=>{
    await json('/auth/logout','POST',{});assert.equal((await request('/v1/books')).status,401);
  });
});
