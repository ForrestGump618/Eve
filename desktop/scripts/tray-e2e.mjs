/** Actual Electron windows/tray, with deterministic answers to native dialogs.
 * Dialog choices are injected; visibility, task continuation and shutdown are real. */
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core'),{rpc}=await import('../dist/src/rpc.js');
const profile=mkdtempSync(join(tmpdir(),'suwen-tray-acceptance-'));
const packaged=process.argv.includes('--packaged');
const formal=process.argv.includes('--formal');
const packagedDirArg=process.argv.find(x=>x.startsWith('--packaged-dir='))?.slice(15);
const packagedDir=packaged?(packagedDirArg?resolve(root,packagedDirArg):join(root,'release/product-100')):null;
const executablePath=packaged?join(packagedDir,'SuWen.exe'):join(root,'node_modules/electron/dist/electron.exe');
const moduleUrl=pathToFileURL(packaged?join(packagedDir,'resources/app/dist/src/main.js'):join(root,'dist/src/main.js')).href;
const report={kind:'real Electron lifecycle; native-dialog choices injected',packaged,checks:[]};
const check=(name,ok,detail)=>{report.checks.push({name,ok:Boolean(ok),detail});console.log((ok?'PASS ':'FAIL ')+name);};
let app,connection;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(action,value){return app.evaluate(async(_,{url,action,value})=>{
 const file=process.getBuiltinModule('url').fileURLToPath(url);const require=process.getBuiltinModule('module').createRequire(file);const {lifecycle}=require(file);
 if(action==='show'){lifecycle.show();return true;}
 if(action==='quit'){void lifecycle.quit();return true;}
 if(action==='set')return lifecycle.setCloseAction(value);
 if(action==='status')return {tray:lifecycle.trayAvailable,action:lifecycle.getCloseAction()};
},{url:moduleUrl,action,value});}
try{
 const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({executablePath,args:[...(packaged?[]:[root]),...(formal?[]:['--native'])],env});
 const page=await app.firstWindow();if(formal)await page.waitForSelector('#chat-input',{timeout:90000});else await page.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));
 await app.evaluate(({dialog})=>{
  globalThis.__dialogChoices=[];globalThis.__dialogRequests=[];
  dialog.showMessageBox=async(...args)=>{const options=args.at(-1);globalThis.__dialogRequests.push({buttons:options.buttons,checkbox:options.checkboxLabel});return globalThis.__dialogChoices.shift()??{response:2,checkboxChecked:false};};
 });
 const choice=async(response,remember=false)=>app.evaluate((_,decision)=>globalThis.__dialogChoices.push(decision),{response,checkboxChecked:remember});
 check('native-tray-created',(await main('status')).tray);
 await choice(2);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await sleep(200);
 check('cancel-keeps-window-visible',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 const task=await rpc(connection,'create',{name:'tray-continuation',steps:[{id:'wait',kind:'delay',input:{ms:30000}}]});await sleep(300);
 await choice(1,true);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await sleep(300);
 check('close-hides-to-tray',!(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())));
 check('tray-keeps-daemon-and-task-alive',(await rpc(connection,'task.snapshot',{id:task.id})).status==='waiting_external');
 check('remember-choice-is-persisted',JSON.parse(readFileSync(join(profile,'desktop-window.json'),'utf8')).closeAction==='tray');
 await main('show');await sleep(100);check('tray-show-restores-same-window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 await main('set','quit');await choice(1);await main('quit');await sleep(300);
 check('unfinished-task-exit-can-continue-in-tray',!(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()))&&(await rpc(connection,'task.snapshot',{id:task.id})).status==='waiting_external');
 await main('show');await main('set','ask');await choice(0);await choice(0);
 const childProcess=app.process();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close()).catch(()=>{});
 for(let i=0;i<300&&childProcess.exitCode===null;i++)await sleep(100);
 check('exit-drains-runtime-and-closes-app',childProcess.exitCode===0&&!existsSync(join(profile,'runtime/connection.json')),{exitCode:childProcess.exitCode,connectionFileRemaining:existsSync(join(profile,'runtime/connection.json'))});
}catch(error){report.error=error.message;console.log(report.error);}
finally{
 try{if(connection)await rpc(connection,'shutdown');}catch{}
 if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
 writeFileSync(join(root,'../docs/verification/release-1.0/tray'+(formal?'-formal':'')+(packaged?'-packaged':'')+'.json'),JSON.stringify(report,null,2));
 process.exit(report.error||report.checks.some(x=>!x.ok)?1:0);
}
