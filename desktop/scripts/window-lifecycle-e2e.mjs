/** Actual Electron main-process teardown orders. Captured uncaught exceptions
 * fail the run instead of opening a modal on the user's desktop. */
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core');
const {rpc}=await import('../dist/src/rpc.js');
const args=process.argv,packaged=args.includes('--packaged');
const phase=args.find(x=>x.startsWith('--phase='))?.slice(8)??'fixed';
const only=args.find(x=>x.startsWith('--only='))?.slice(7);
const report={kind:'real Electron window lifecycle, no model requests',packaged,phase,at:new Date().toISOString(),results:[]};
for(const scenario of ['owner-first','formal-first','quit-both','during-start'].filter(x=>!only||x===only)){
 const profile=mkdtempSync(join(tmpdir(),'suwen-window-close-'));
 const errorsFile=join(profile,'main-errors.jsonl'),env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
 let app,connection,child;
 const entry={scenario,errors:[]};
 try{
  app=await _electron.launch({executablePath:packaged?join(root,'release/win-unpacked/SuWen.exe'):join(root,'node_modules/electron/dist/electron.exe'),args:packaged?[]:[root],env,timeout:60000});
  child=app.process();
  await app.evaluate(async({dialog},file)=>{
   const fs=process.getBuiltinModule('fs');
   const log=(kind,error)=>fs.appendFileSync(file,JSON.stringify({kind,message:String(error?.stack||error)})+'\n');
   process.on('uncaughtException',error=>log('uncaughtException',error));
   process.on('unhandledRejection',error=>log('unhandledRejection',error));
   dialog.showErrorBox=(title,body)=>log('error-dialog',title+': '+body);
  },errorsFile);
  await app.firstWindow();
  if(scenario!=='during-start'){
   let found=false;
   for(let i=0;i<180;i++){if(app.windows().some(p=>/^http:\/\/127\.0\.0\.1:/.test(p.url()))){found=true;break;}await new Promise(r=>setTimeout(r,500));}
   if(!found)throw new Error('Formal window did not start');
  }
  if(existsSync(join(profile,'runtime/connection.json')))connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));
  await app.evaluate(({app,BrowserWindow},mode)=>{
   const all=BrowserWindow.getAllWindows(),owner=all.find(w=>w.webContents.getURL().startsWith('file:')),formal=all.find(w=>w.webContents.getURL().startsWith('http:'));
   if(mode==='owner-first'){owner?.destroy();formal?.close();}
   else if(mode==='formal-first')formal?.close();
   else app.quit();
  },scenario).catch(error=>{if(!/closed|Target|destroyed/i.test(error.message))throw error;});
  const deadline=Date.now()+10000;
  while(child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  entry.exitCode=child.exitCode;
 }catch(e){entry.error=String(e.message);}
 finally{
  if(existsSync(errorsFile))entry.errors=readFileSync(errorsFile,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
  entry.ok=!entry.error&&entry.exitCode===0&&entry.errors.length===0;
  try{if(!connection&&existsSync(join(profile,'runtime/connection.json')))connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));if(connection)await rpc(connection,'shutdown');}catch{}
  if(app)await Promise.race([app.close().catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);
  report.results.push(entry);console.log(JSON.stringify(entry));
 }
}
writeFileSync(resolve(root,`../docs/verification/harness-20261025/window-lifecycle-${phase}.json`),JSON.stringify(report,null,2));
process.exit(report.results.every(x=>x.ok)?0:1);
