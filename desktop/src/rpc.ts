import { connect } from 'node:net';
import type { Connection } from './security.js';
export async function rpc(connection:Connection,method:string,params:unknown={}):Promise<any> {
 return new Promise((resolve,reject)=>{
  const socket=connect(connection.pipe); socket.setEncoding('utf8'); let data='',settled=false;
  const finish=(error:unknown,value?:any)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value);};
  socket.setTimeout(method==='legacyStart'?95000:15000,()=>socket.destroy(new Error('Daemon response timed out')));
  socket.on('connect',()=>socket.write(JSON.stringify({token:connection.token,method,params})+'\n'));
  socket.on('data',chunk=>{data+=chunk.toString();if(data.length>8_000_000){socket.destroy(new Error('Response exceeded limit'));return;}
   if(data.includes('\n')){try {const result=JSON.parse(data.slice(0,data.indexOf('\n')));finish(result.error?new Error(result.error):null,result.result);}catch(err){finish(err);}}});
  socket.on('error',error=>finish(error));socket.on('end',()=>{if(!data.includes('\n'))finish(new Error('Incomplete daemon response'));});
 });
}
