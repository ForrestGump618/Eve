/** Real old/new daemons and Electron. Never uses the production profile. */
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {_electron} from 'playwright-core';
import {rpc} from '../dist/src/rpc.js';
const old=process.argv.find(x=>x.startsWith('--old-app='))?.slice(10);
if(!old)throw Error('Supply an extracted older application directory');
const root=resolve('.'),oldRoot=resolve(old),version=JSON.parse(readFileSync(join(oldRoot,'package.json'),'utf8')).version;
if(version==='3.4.0')throw Error('Expected an older application');
const report={kind:'real version upgrade; isolated profiles',oldVersion:version,results:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const active of [false,true]){
 const profile=mkdtempSync(join(tmpdir(),'suwen-daemon-upgrade-')),home=join(profile,'runtime');
 const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
 const oldProcess=spawn(process.execPath,[join(oldRoot,'dist/src/daemon.js'),'--home',home,'--worker',resolve('worker/research_worker.py')],{env,windowsHide:true,stdio:'ignore'});
 let app,connection;const result={active};
 try{
  for(let i=0;i<100;i++){if(existsSync(join(home,'connection.json'))){connection=JSON.parse(readFileSync(join(home,'connection.json'),'utf8'));try{await rpc(connection,'health');break;}catch{}}await pause(100);}
  if(!connection)throw Error('Old daemon did not start');
  const task=await rpc(connection,'create',{name:'preserve-upgrade-history',steps:[{id:'step',kind:active?'approval':'echo',input:{test:'persisted'}}]});
  for(let i=0;i<50;i++){const s=await rpc(connection,'snapshot');if(s.tasks.find(x=>x.id===task.id)?.status===(active?'waiting_approval':'completed'))break;await pause(100);}
  app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[root,'--native'],env,timeout:60000});const page=await app.firstWindow();
  await page.waitForFunction(()=>window.suwen&&document.getElementById('health'));
  const settings=await page.evaluate(()=>window.suwen.call('settings'));
  connection=JSON.parse(readFileSync(join(home,'connection.json'),'utf8'));const health=await rpc(connection,'health'),snapshot=await rpc(connection,'snapshot');
  result.actualVersion=health.version;result.taskStatus=snapshot.tasks.find(x=>x.id===task.id)?.status;
  result.startupError=settings.startupError;
  result.ok=active?health.version===version&&result.taskStatus==='waiting_approval'&&settings.startupError.includes('未结束任务'):health.version==='3.4.0'&&result.taskStatus==='completed'&&(await rpc(connection,'skill.list')).skills.length===8;
 }catch(e){result.error=String(e.message);result.ok=false;}
 finally{try{if(connection)await rpc(connection,'shutdown');}catch{}if(app)await Promise.race([app.close(),pause(5000)]);if(oldProcess.exitCode===null)oldProcess.kill();report.results.push(result);console.log(JSON.stringify(result));}
}
writeFileSync(resolve('../docs/verification/product-340-20261026/daemon-upgrade.json'),JSON.stringify(report,null,2));process.exit(report.results.every(x=>x.ok)?0:1);
