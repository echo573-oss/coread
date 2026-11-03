#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback);
const target=process.argv[2]||'.env';
if(fs.existsSync(target)){console.error('Configuration exists; it was not overwritten.');process.exit(1);}
const password=crypto.randomBytes(24).toString('base64url'),salt=crypto.randomBytes(24).toString('base64url');
const digest='scrypt:'+salt+':'+Buffer.from(await scrypt(password,salt,64)).toString('hex');
const uid=process.getuid?.()||1000,gid=process.getgid?.()||1000;
fs.writeFileSync(target,['COREAD_PUBLIC_URL=https://reading.ddnsto.com','COREAD_PASSWORD_HASH='+digest,'COREAD_BIND_IP=127.0.0.1','COREAD_HOST_PORT=3010','COREAD_UID='+uid,'COREAD_GID='+gid,''].join('\n'),{mode:0o600,flag:'wx'});
const credentialFile=target+'.initial-password.txt';
fs.writeFileSync(credentialFile,password+'\n',{mode:0o600,flag:'wx'});
fs.mkdirSync('data',{mode:0o700,recursive:true});
console.log('配置已生成。初始网页密码只保存在本机文件：'+credentialFile+'。请收入密码管理器后删除该文件。');
