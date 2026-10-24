import { connect } from 'node:net';
import type { Connection } from './security.js';
export async function rpc(connection:Connection,method:string,params:unknown={}):Promise<any> {
 return new Promise((resolve,reject)=>{
  const socket=connect(connection.pipe); let data='';
  socket.setTimeout(method==='legacyStart'?95000:15000,()=>socket.destroy(new Error('Daemon response timed out')));
  socket.on('connect',()=>socket.write(JSON.stringify({token:connection.token,method,params})+'\n'));
  socket.on('data',chunk=>{data+=chunk.toString();if(data.length>8_000_000){socket.destroy(new Error('Response exceeded limit'));return;}
   if(data.includes('\n')){socket.end();try {const result=JSON.parse(data.slice(0,data.indexOf('\n')));result.error?reject(new Error(result.error)):resolve(result.result);}catch(err){reject(err);}}});
  socket.on('error',reject);socket.on('end',()=>{if(!data.includes('\n'))reject(new Error('Incomplete daemon response'));});
 });
}
