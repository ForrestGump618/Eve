/** Real Electron lifecycle and real in-window confirmation clicks. */
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
const installed=packagedDir===join(process.env.LOCALAPPDATA,'Programs/Eve');
const executablePath=packaged?join(packagedDir,'Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const moduleUrl=pathToFileURL(packaged?join(packagedDir,'resources/app/dist/src/main.js'):join(root,'dist/src/main.js')).href;
const report={kind:'real Electron lifecycle and application modal UI',packaged,installed,checks:[]};
const check=(name,ok,detail)=>{report.checks.push({name,ok:Boolean(ok),detail});console.log((ok?'PASS ':'FAIL ')+name);};
let app,connection;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(action,value){return app.evaluate(async(_,{url,action,value})=>{
 const file=process.getBuiltinModule('url').fileURLToPath(url);const require=process.getBuiltinModule('module').createRequire(file);const {lifecycle}=require(file);
 if(action==='show'){lifecycle.show();return true;}
 if(action==='quit'){void lifecycle.quit();return true;}
 if(action==='set')return lifecycle.setCloseAction(value);
 if(action==='fault'){
  globalThis.__lifecycleOriginal??={active:lifecycle.options.active,shutdown:lifecycle.options.shutdown};
  lifecycle.options.active=value==='connection'?async()=>{throw Error('Test connection unavailable');}:globalThis.__lifecycleOriginal.active;
  lifecycle.options.shutdown=value==='shutdown'?async()=>{throw Error('Test shutdown unavailable');}:globalThis.__lifecycleOriginal.shutdown;
  return true;
 }
 if(action==='status')return {tray:lifecycle.trayAvailable,action:lifecycle.getCloseAction()};
},{url:moduleUrl,action,value});}
try{
 const env={...process.env,SUWEN_TEST_HOME:profile,SUWEN_WORKBENCH_DEPS:join(process.env.APPDATA,'Eve/python-env')};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({executablePath,args:[...(packaged?[]:[root]),...(formal?[]:['--native'])],env});
 const page=await app.firstWindow();if(formal)await page.waitForSelector('#chat-input',{timeout:90000});else await page.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));
 await app.evaluate(({dialog})=>{
  globalThis.__nativeDialogCount=0;
  dialog.showMessageBox=async()=>{globalThis.__nativeDialogCount++;throw Error('Unexpected native close dialog');};
 });
 const close=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 const choice=async(response,remember=false)=>{
  const modal=page.locator('eve-window-prompt');
  await modal.locator('dialog').waitFor({state:'visible'});
  if(remember)await modal.locator('input[type=checkbox]').check();
  await modal.locator(`button[data-response="${response}"]`).click();
 };
 check('native-tray-created',(await main('status')).tray);
 await page.locator(formal?'#chat-input':'#health').focus();
 await close();
 await page.locator('eve-window-prompt dialog').waitFor({state:'visible'});
 check('close-confirmation-is-in-existing-window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)===1);
 await close();await close();
 check('repeated-close-keeps-single-dialog',await page.locator('eve-window-prompt').count()===1);
 await sleep(200);
 await page.screenshot({path:join(root,'../docs/verification/eve-1.0/close-dialog'+(formal?'-formal':'')+'.png')});
 if(formal)await page.locator('eve-window-prompt dialog').screenshot({path:join(root,'../docs/verification/eve-1.0/close-dialog-detail.png')});
 await choice(2);await sleep(100);
 check('cancel-keeps-window-visible',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 await close();await page.locator('eve-window-prompt dialog').waitFor({state:'visible'});
 await page.keyboard.press('Escape');await page.locator('eve-window-prompt').waitFor({state:'detached'});
 check('escape-cancels-close',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 await main('fault','connection');await main('quit');
 await page.locator('eve-window-prompt h2').filter({hasText:'无法确认'}).waitFor();
 await choice(0);await sleep(100);
 check('unknown-backend-status-keeps-app-open',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 await main('fault','shutdown');await main('quit');
 await page.locator('eve-window-prompt h2').filter({hasText:'尚未安全退出'}).waitFor();
 await choice(0);await sleep(100);
 check('shutdown-failure-keeps-app-open',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 await main('fault','none');
 const task=await rpc(connection,'create',{name:'tray-continuation',steps:[{id:'wait',kind:'delay',input:{ms:120000}}]});await sleep(300);
 await close();await choice(1,true);await sleep(300);
 check('close-hides-to-tray',!(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())));
 check('tray-keeps-daemon-and-task-alive',(await rpc(connection,'task.snapshot',{id:task.id})).status==='waiting_external');
 check('remember-choice-is-persisted',JSON.parse(readFileSync(join(profile,'desktop-window.json'),'utf8')).closeAction==='tray');
 await main('show');await sleep(100);check('tray-show-restores-same-window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 await main('set','quit');await main('quit');await choice(1);await sleep(300);
 check('unfinished-task-exit-can-continue-in-tray',!(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()))&&(await rpc(connection,'task.snapshot',{id:task.id})).status==='waiting_external');
 // Quitting from a hidden tray window must reveal its confirmation.
 await main('quit');await page.locator('eve-window-prompt dialog').waitFor({state:'visible'});
 check('tray-quit-shows-window-for-confirmation',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()));
 await choice(2);await main('set','ask');await close();await choice(0);
 await page.locator('eve-window-prompt h2').filter({hasText:'未结束'}).waitFor();
 check('active-task-requires-explicit-stop',true);
 check('no-native-close-dialogs',await app.evaluate(()=>globalThis.__nativeDialogCount===0));
 const childProcess=app.process();await choice(0).catch(error=>{if(!/closed|Target|destroyed/i.test(error.message))throw error;});
 for(let i=0;i<300&&childProcess.exitCode===null;i++)await sleep(100);
 check('exit-drains-runtime-and-closes-app',childProcess.exitCode===0&&!existsSync(join(profile,'runtime/connection.json')),{exitCode:childProcess.exitCode,connectionFileRemaining:existsSync(join(profile,'runtime/connection.json'))});
}catch(error){report.error=error.message;console.log(report.error);}
finally{
 try{if(connection)await rpc(connection,'shutdown');}catch{}
 if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
 writeFileSync(join(root,'../docs/verification/eve-1.0/tray'+(formal?'-formal':'')+(installed?'-installed':packaged?'-packaged':'')+'.json'),JSON.stringify(report,null,2));
 process.exit(report.error||report.checks.some(x=>!x.ok)?1:0);
}
