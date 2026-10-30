import { mkdirSync, chmodSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
export function protect(path:string):void {
  if(process.platform==='win32') {
    const identity=execFileSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
    const sid=identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if(!sid)throw new Error('Cannot establish current-user file permissions');
    execFileSync('icacls',[path,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],{windowsHide:true,stdio:'pipe'});
  } else chmodSync(path,0o700);
}
export function ensureHome(home:string):void {mkdirSync(home,{recursive:true,mode:0o700});protect(home);}
export function atomicJson(path:string,value:unknown):void {
 const temp=path+'.'+randomBytes(6).toString('hex')+'.tmp';
 writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(temp,path);
}
/** Windows readers/antivirus can briefly deny an atomic replacement. Retry
 * without deleting the old connection record or blocking the daemon event loop. */
export async function atomicJsonAsync(path:string,value:unknown):Promise<void> {
 const temp=path+'.'+randomBytes(6).toString('hex')+'.tmp';
 try {
  await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});
  for(let attempt=0;;attempt++){
   try { await rename(temp,path);return; }
   catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(code??'')||attempt>=6)throw error;
    await delay(25*2**attempt);
   }
  }
 }finally{await unlink(temp).catch(()=>{});}
}
export function secretEqual(a:unknown,b:string):boolean {return typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
/** PID checks alone are insufficient on Windows because PIDs are reused.
 * The daemon lock may only be honored by an Eve/Electron/Node runtime image. */
export function isEveRuntimeProcess(pid:number):boolean {
  if(!Number.isSafeInteger(pid)||pid<=0||(process.platform==='win32'&&pid>0x7fffffff))return false;
  if(process.platform==='win32'){
    try {
      const csv=execFileSync('tasklist.exe',['/FI',`PID eq ${pid}`,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();
      const image=csv.match(/^"([^"]+)"/)?.[1]?.toLowerCase();
      return image==='eve.exe'||image==='electron.exe'||image==='node.exe';
    } catch {
      // If tasklist itself is unavailable, retain the conservative liveness check.
    }
  }
  try { process.kill(pid,0); return true; }
  catch(error){return !['ESRCH','EINVAL','ERANGE'].includes((error as NodeJS.ErrnoException).code??'');}
}
export interface Connection { pipe:string; token:string; pid:number; version:number }
export function connectionPath(home:string):string {return join(home,'connection.json');}
export function readConnection(home:string):Connection|null {try {return JSON.parse(readFileSync(connectionPath(home),'utf8'));}catch{return null;}}
export function newConnection(home:string):Connection {
 const suffix=createHash('sha256').update(home).digest('hex').slice(0,16)+'-'+randomBytes(12).toString('hex');
 return {pipe:process.platform==='win32'?String.raw`\\.\pipe\suwen-${suffix}`:join(home,`suwen-${suffix}.sock`),token:randomBytes(32).toString('hex'),pid:process.pid,version:1};
}
export function safeError(value:unknown):string {
 return String(value instanceof Error?value.message:value)
  .replace(/(["']?(?:api[_-]?key|password|secret|token|authorization)["']?\s*[=:]\s*)(["'])(.*?)\2/gi,'$1"[redacted]"')
  .replace(/Bearer\s+\S+|sk-[\w-]+|(?:api[_-]?key|password|secret|token)\s*[=:]\s*[^\s,}]+/gi,'[redacted]').slice(0,600);
}
