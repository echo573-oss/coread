import React,{useEffect,useState} from 'react';
import { configureSession, ownerFetch } from './api';

async function clearReadingCache(){
  for(const key of Object.keys(localStorage))if(key.startsWith('pagebreaks-')||key.startsWith('coread-cache-'))localStorage.removeItem(key);
  if(indexedDB.databases)for(const db of await indexedDB.databases())if(db.name?.startsWith('study-reader-cache-'))indexedDB.deleteDatabase(db.name);
}
export default function AuthGate({children}:{children:React.ReactNode}){
  const [ready,setReady]=useState(false),[signedIn,setSignedIn]=useState(false),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=async()=>{
    const res=await fetch('/auth/session',{cache:'no-store',credentials:'same-origin'});
    if(!res.ok)throw Error('暂时无法连接共读室');
    const data=await res.json();configureSession(data.csrf||'');
    if(data.authenticated){localStorage.setItem('coread-cache-generation',data.cache_namespace);}
    setSignedIn(data.authenticated);setReady(true);
  };
  useEffect(()=>{
    refresh().catch(e=>{setReady(true);setError(e.message);});
    const expired=()=>{configureSession('');setSignedIn(false);void clearReadingCache();};
    const logout=async()=>{await ownerFetch('/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await clearReadingCache();configureSession('');setSignedIn(false);};
    window.addEventListener('coread-session-expired',expired);window.addEventListener('coread-logout',logout);
    return ()=>{window.removeEventListener('coread-session-expired',expired);window.removeEventListener('coread-logout',logout);};
  },[]);
  if(!ready)return <main style={{padding:40}}>正在打开共读室…</main>;
  if(signedIn)return <>{children}</>;
  return <main style={{height:'100%',display:'grid',placeItems:'center',padding:24,background:'#f7f4f0'}}><form style={{width:'100%',maxWidth:360}} onSubmit={async e=>{
    e.preventDefault();if(busy)return;setBusy(true);setError('');
    try{const res=await fetch('/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});setPassword('');if(!res.ok)throw Error('登录失败，请核对密码或稍后重试');await refresh();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }}><h1 style={{fontSize:28,marginBottom:12}}>知与岚的共读室</h1><p style={{marginBottom:24,color:'#777'}}>书页、划线，和留给彼此的话。</p>
    <label htmlFor="password">共读室密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required style={{width:'100%',padding:14,margin:'10px 0',fontSize:16,border:'1px solid #ccc',borderRadius:12}}/>
    {error&&<p role="alert" style={{color:'#a33',margin:'8px 0'}}>{error}</p>}<button disabled={busy} style={{width:'100%',padding:14,borderRadius:12,border:0,background:'#33302a',color:'#fff',fontSize:16}}>{busy?'正在登录…':'走进共读室'}</button></form></main>;
}
