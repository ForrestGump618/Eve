import { spawn } from 'node:child_process';
export function runPython(python:string,script:string,request:unknown,signal:AbortSignal):Promise<any> {
 return new Promise((resolve,reject)=>{
  // Fixed script and operations; no shell or arbitrary Python text is accepted.
  const env:NodeJS.ProcessEnv={SYSTEMROOT:process.env.SYSTEMROOT,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONIOENCODING:'utf-8',PYTHONNOUSERSITE:'1'};
  const child=spawn(python,['-I','-u',script],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,env});let data='';let settled=false;
  const abort=()=>{child.kill();if(!settled){settled=true;reject(new Error('Python worker cancelled'));}};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
  child.stdout.on('data',chunk=>{data+=chunk.toString();if(data.length>2_000_000)abort();});child.stderr.resume();
  child.on('error',err=>{settled=true;reject(new Error(`Python worker unavailable: ${err.message}`));});
  child.on('close',code=>{signal.removeEventListener('abort',abort);if(settled)return;settled=true;try {if(code!==0)throw new Error(`Python worker exited ${code}`);const r=JSON.parse(data.trim());if(r.error)throw new Error(r.error);resolve(r.result);}catch(err){reject(err);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request)+'\n');
 });
}
