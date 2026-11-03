import fs from 'node:fs';
import path from 'node:path';
import { getDbPath } from './db.mjs';
const lockPath=()=>process.env.ROOM_LOCK_PATH||path.join(path.dirname(getDbPath()),'reading-room-lock.json');
export function readRoomLock(){
  try{const state=JSON.parse(fs.readFileSync(lockPath(),'utf8'));return {locked:!!state.locked,at:state.at||null,note:String(state.note||'').slice(0,120)};}
  catch(error){return {locked:error.code!=='ENOENT',at:null,note:error.code==='ENOENT'?'':'锁文件无法读取，请重新设置'};}
}
export function writeRoomLock(locked,note){
  const state={locked:!!locked,at:new Date().toISOString(),note:String(note||'').slice(0,120)};
  fs.mkdirSync(path.dirname(lockPath()),{recursive:true});
  const temporary=lockPath()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(state),{mode:0o600});fs.renameSync(temporary,lockPath());return state;
}
