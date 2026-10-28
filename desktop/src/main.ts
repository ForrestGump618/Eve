import { app, BrowserWindow, ipcMain, safeStorage, dialog, session } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { rpc } from './rpc.js';
import { ensureHome, readConnection, safeError, type Connection } from './security.js';
import { validateModelConfig } from './providers.js';
import { RPC_METHODS } from './shared/contract.js';
import { WorkbenchManager } from './workbench.js';
import {WindowLifecycle} from './window-lifecycle.js';
import {resolveUserData} from './user-data.js';
import {blocksRuntimeUpgrade, compatibleRuntime, diagnosticConsole, runtimeIdentity} from './runtime-identity.js';

const here=dirname(fileURLToPath(import.meta.url));
app.setName('Eve');
// Eve owns its profile. Legacy SuWen data is renamed once when that can be done
// safely; a locked old profile is left intact rather than shared.
const testHome=process.env.EVE_TEST_HOME??process.env.SUWEN_TEST_HOME;
const nativeConsole=diagnosticConsole(process.argv,testHome);
const buildIdentity=runtimeIdentity(app.getVersion(),resolve(here,'..'));
const userData=resolveUserData({appData:app.getPath('appData'),testHome:testHome?resolve(testHome):undefined});
app.setPath('userData',userData.path);
if(userData.migrationError)console.warn('[Eve] Legacy profile migration deferred; old data remains intact:',userData.migrationError);
const hasSingleInstanceLock=app.requestSingleInstanceLock();
if(!hasSingleInstanceLock)app.quit();
let win:BrowserWindow|null=null,connection:Connection|null=null;
let researchWindow:BrowserWindow|null=null;
let quitting=false;
let activationPending=false;
let streamCursor=0,pumpTimer:NodeJS.Timeout|null=null,pumpBusy=false;
let reconnectTimer:NodeJS.Timeout|null=null,reconnecting=false;
const home=join(app.getPath('userData'),'runtime');
const uiFile=resolve(here,'../ui/index.html');
/** Python selected for the detached daemon (frozen preferences.json), used by the workbench runtime. */
function daemonPythonPath():string{try{const value=JSON.parse(readFileSync(join(home,'preferences.json'),'utf8')) as {pythonPath?:unknown};return typeof value.pythonPath==='string'&&value.pythonPath?value.pythonPath:'python';}catch{return 'python';}}
/** Managed, pinned Python dependency set for the legacy web workbench (never bundled credentials). */
const workbenchDeps=process.env.SUWEN_WORKBENCH_DEPS?resolve(process.env.SUWEN_WORKBENCH_DEPS):join(app.getPath('userData'),'python-env');
const workbench=new WorkbenchManager({home,depsDir:workbenchDeps,python:daemonPythonPath});
/** Electron can destroy a BrowserWindow between any two synchronous accesses.
 * Keep teardown races contained here so native callbacks never surface an
 * "Object has been destroyed" modal to the user. */
function liveWindow(window:BrowserWindow|null|undefined):window is BrowserWindow {
 try{return Boolean(window&&!window.isDestroyed()&&!window.webContents.isDestroyed());}catch{return false;}
}
function runInWindow(window:BrowserWindow|null|undefined,script:string):void {
 if(!liveWindow(window))return;
 try{void window.webContents.executeJavaScript(script).catch(()=>{});}catch{/* destroyed during dispatch */}
}
function sendToWindow(window:BrowserWindow|null|undefined,channel:string,...args:unknown[]):boolean {
 if(!liveWindow(window))return false;
 try{window.webContents.send(channel,...args);return true;}catch{return false;}
}
export const lifecycle=new WindowLifecycle({path:join(app.getPath('userData'),'desktop-window.json'),icon:app.isPackaged?join(process.resourcesPath,'eve.ico'):resolve(here,'../../assets/eve.ico'),window:()=>liveWindow(researchWindow)?researchWindow:liveWindow(win)?win:null,
 active:async()=>{if(!connection)return 0;const snapshot=await rpc(connection,'snapshot');return snapshot.tasks.filter((t:any)=>!['completed','failed','cancelled'].includes(t.status)).length;},
 shutdown:async()=>{workbench.cancel();if(!connection)return;const old=connection;await rpc(old,'shutdown');for(let i=0;i<250;i++){await new Promise(r=>setTimeout(r,100));const current=readConnection(home);if(!current||current.pid!==old.pid){connection=null;return;}}throw new Error('运行时未在 25 秒内完成资源清理，请检查任务状态');},
 quit:()=>{quitting=true;app.quit();}});
function activateExistingInstance():void{
 activationPending=true;
 const target=liveWindow(researchWindow)?researchWindow:liveWindow(win)?win:BrowserWindow.getAllWindows().find(candidate=>liveWindow(candidate));
 if(liveWindow(target)){target.show();target.focus();activationPending=false;}
}
if(hasSingleInstanceLock)app.on('second-instance',activateExistingInstance);
async function connectDaemon():Promise<void>{
 const old=readConnection(home);
 if(old){
  let health:any=null;try{health=await rpc(old,'health');}catch{}
  if(health){
   if(compatibleRuntime(health,buildIdentity)){connection=old;return;}
   const snapshot:any=await rpc(old,'snapshot');
   if(blocksRuntimeUpgrade(snapshot))throw new Error(`旧构建后台正在执行任务。请完成或暂停任务后重连，以加载当前 Eve ${app.getVersion()} 工作台。`);
   await rpc(old,'shutdown');
   let stopped=false;
   for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,100));try{await rpc(old,'health');}catch{stopped=true;break;}}
   if(!stopped)throw new Error('旧版后台尚未退出，请稍后重连。');
  }
 }
 const script=join(here,'daemon.js');const worker=app.isPackaged?join(process.resourcesPath,'worker','research_worker.py'):resolve(here,'../../worker/research_worker.py');
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_USE_ENV_PROXY:'1'} as NodeJS.ProcessEnv;
 // Node fetch does not automatically use Windows' system proxy. Resolve it through Electron.
 if(!env.HTTPS_PROXY&&!env.HTTP_PROXY){
  const resolved=await session.defaultSession.resolveProxy('https://api.openai.com');
  const match=resolved.match(/^PROXY ([a-zA-Z0-9.:[\]-]+:\d+)(?:;|$)/);
  if(match){env.HTTPS_PROXY='http://'+match[1];env.HTTP_PROXY=env.HTTPS_PROXY;}
 }
 env.NO_PROXY=env.NO_PROXY??'localhost,127.0.0.1,::1';
 const args=[script,'--home',home,'--worker',worker,'--legacy-source',app.isPackaged?join(process.resourcesPath,'legacy'):resolve(here,'../../..'),'--legacy-script',app.isPackaged?join(process.resourcesPath,'worker','legacy_server.py'):resolve(here,'../../worker/legacy_server.py')];
 // Only openResearchWorkspace may select dependencies, after interpreter/hash
 // checks. A historical marker alone must not inject incompatible binary wheels.
 const child=spawn(process.execPath,args,{detached:true,windowsHide:true,stdio:'ignore',env});child.unref();
 for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,150));const c=readConnection(home);if(c){try{if(compatibleRuntime(await rpc(c,'health') as any,buildIdentity)){connection=c;return;}}catch{}}}
 throw new Error('后台未启动，请在诊断中重试。');
}
/** Push incremental daemon events to the renderer; see docs/architecture/streaming-events.md. */
async function pumpEvents():Promise<void>{
 if(quitting||pumpBusy||!liveWindow(win)||(!win.isVisible()&&!testHome))return;
 if(!connection){scheduleReconnect();return;}
 pumpBusy=true;
 try{
  const batch:any=await rpc(connection,'events.stream',{since:streamCursor,limit:500});
  if(typeof batch?.cursor==='number')streamCursor=batch.cursor;
  const hasPayload=batch?.reset===true||(Array.isArray(batch?.events)&&batch.events.length>0)||(Array.isArray(batch?.streams)&&batch.streams.length>0)||(Array.isArray(batch?.tasks)&&batch.tasks.length>0);
  if(hasPayload)sendToWindow(win,'suwen:events',batch);
 }catch{
  // A killed/restarted daemon leaves a stale connection object behind; without clearing it the
  // pump would retry the dead pipe forever instead of rescheduling. Clear it and reconnect.
  connection=null;
  scheduleReconnect();
 }
 finally{pumpBusy=false;}
}
function startEventPump():void{
 if(pumpTimer)return;
 const next=()=>{
  if(quitting)return;
  pumpTimer=setTimeout(async()=>{pumpTimer=null;await pumpEvents();next();},liveWindow(win)&&(win.isVisible()||testHome)?150:2000);
  pumpTimer.unref?.();
 };
 next();
}
/** Renderer-facing connection state for streaming UI recovery. */
function notifyConnection(state:'reconnecting'|'restored'|'lost'):void{
 sendToWindow(win,'suwen:connection',{state,at:Date.now()});
}
/** Re-establish the detached daemon without losing the renderer; bounded exponential backoff. */
function scheduleReconnect():void{
 if(quitting||reconnecting||reconnectTimer)return;
 reconnecting=true;
 notifyConnection('reconnecting');
 let attempt=0;
 const delays=[300,800,1500,3000,5000,8000,12000];
 const attemptConnect=async()=>{
  reconnectTimer=null;
  try{
   await connectDaemon();
   const cfg=readConfig();if(cfg&&connection)await rpc(connection,'configure',cfg);
   await pushSecrets();
   reconnecting=false;
   notifyConnection('restored');
  }catch{
   if(attempt<delays.length){const delay=delays[Math.min(attempt,delays.length-1)];attempt++;reconnectTimer=setTimeout(()=>{void attemptConnect();},delay);reconnectTimer.unref?.();}
   else{reconnecting=false;notifyConnection('lost');}
  }
 };
 void attemptConnect();
}
/** Fast path for renderer calls made while the daemon is restarting. */
async function ensureConnected():Promise<void>{
 if(connection)return;
 if(reconnecting)throw new Error('后台正在恢复连接，请稍候重试');
 await connectDaemon();
 const cfg=readConfig();if(cfg&&connection)await rpc(connection,'configure',cfg);
 await pushSecrets();
}
function secureConfigPath():string{return join(home,'model-config.enc');}
function readConfig():any {if(!existsSync(secureConfigPath()))return null;if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用');return JSON.parse(safeStorage.decryptString(readFileSync(secureConfigPath())));}
const secretsPath=join(home,'secrets.enc');
/** Decrypted credential references, main-process only. Never written to disk in plaintext. */
function readSecrets():Record<string,string>{
 if(!existsSync(secretsPath))return {};
 if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用');
 try{const parsed=JSON.parse(safeStorage.decryptString(readFileSync(secretsPath)));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,string>:{};}catch{return {};}
}
function writeSecrets(map:Record<string,string>):void{
 if(!safeStorage.isEncryptionAvailable())throw new Error('系统加密不可用，拒绝明文保存凭据');
 const encrypted=safeStorage.encryptString(JSON.stringify(map));const tmp=secretsPath+'.tmp';writeFileSync(tmp,encrypted,{mode:0o600});renameSync(tmp,secretsPath);
}
async function pushSecrets():Promise<void>{if(!connection)return;try{await rpc(connection,'secrets.set',{refs:readSecrets()});}catch{/* daemon may still be starting */}}
const MAIN_ONLY=new Set(['settings','configure','login','reconnect','pythonPicker','legacyOpen','shutdown','support','secrets.status','secret.put','secret.remove','secrets.set','events.stream','workbench.status','workbench.install','workbench.cancel']);
/** Main-process handlers that the sandboxed renderer may invoke directly (no daemon passthrough). */
const UI_MAIN_METHODS=['secrets.status','secret.put','secret.remove','events.replay','workbench.status','workbench.install','workbench.cancel'];
const exposed=new Set<string>([...RPC_METHODS.filter(method=>!MAIN_ONLY.has(method)),...UI_MAIN_METHODS]);
/** The formal workbench is the only product home. An isolated test profile can
 * opt into the diagnostic console; stale launch arguments cannot open it. */
async function openResearchWorkspace(primary=false):Promise<{ok:boolean}> {
 if(quitting)return {ok:false};
 if(liveWindow(researchWindow)){researchWindow.show();researchWindow.focus();return {ok:true};}
 const isolated=session.fromPartition(`suwen-research-${randomUUID()}`);
 const window=new BrowserWindow({width:1600,height:1000,minWidth:980,minHeight:680,title:'Eve',titleBarStyle:'hidden',titleBarOverlay:{color:'#eef1f6',symbolColor:'#333333',height:36},backgroundColor:'#eef1f6',show:!process.argv.includes('--background'),webPreferences:{preload:join(here,'desktop-preload.cjs'),session:isolated,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 researchWindow=window;
 lifecycle.attach(window);
 const startupPage=(message:string,failed=false)=>'data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{margin:0;background:#eef1f6;color:#555;font:14px "Segoe UI",sans-serif}header{height:36px;-webkit-app-region:drag}main{margin:32px;padding:32px;border:1px solid #dfe3e9;border-radius:18px;background:#fff}h1{color:#303238;font-size:20px}p{white-space:pre-wrap;line-height:1.8}button{padding:8px 16px;border:1px solid #ddd;background:#f5f5f5;border-radius:6px;cursor:pointer}</style><header></header><main><h1>Eve</h1><p id="startup-status"></p>${failed?'<button onclick="window.suwenDesktop.retryStartup()">重试启动</button>':''}</main><script>document.getElementById('startup-status').textContent=${JSON.stringify(message).replaceAll('<','\\u003c')}</script></html>`);
 isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.on('closed',()=>{try{isolated.webRequest.onBeforeSendHeaders(null);}catch{/* session already torn down */}if(researchWindow===window)researchWindow=null;});
 try{
 await window.loadURL(startupPage('正在准备工作台…'));
 let runtime=await workbench.runtime();
 if(!runtime.ready){
  const installed=await workbench.install(progress=>runInWindow(window,`document.getElementById('startup-status').textContent=${JSON.stringify('正在安装独立运行环境，完成后自动进入工作台…\n'+String(progress.message||'')).replaceAll('<','\\u003c')}`));
  if(!installed.installed)throw new Error(installed.error||'科研工作台运行环境未就绪，请在设置中检查 Python');
  runtime={ready:true,depsDir:installed.depsDir};
 }
 const cfg=readConfig();
 const modelConfig=cfg&&cfg.apiKey?{provider:cfg.provider==='anthropic'?'custom-anthropic':'custom-openai',model:cfg.model,apiBase:cfg.baseUrl,apiKey:cfg.apiKey}:undefined;
 await ensureConnected();const result=await rpc(connection!,'legacyStart',{...(runtime.depsDir?{deps:runtime.depsDir}:{}),...(modelConfig?{config:modelConfig}:{})});
 if(quitting||!liveWindow(window))return {ok:false};
 const origin=`http://127.0.0.1:${result.port}`;
 const contentsId=window.webContents.id;
 isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 isolated.webRequest.onBeforeSendHeaders({urls:[origin+'/*',origin.replace(/^http/,'ws')+'/*']},(details,callback)=>{
  if(!quitting&&liveWindow(window)&&details.webContentsId===contentsId)callback({requestHeaders:{...details.requestHeaders,Authorization:'Bearer '+result.token}});else callback({cancel:true});
 });
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(navigation,url)=>{try{if(new URL(url).origin!==origin)navigation.preventDefault();}catch{navigation.preventDefault();}});
 window.webContents.on('will-frame-navigate',details=>{
  // Standalone artifacts stay inside their opaque srcdoc frame. A scripted
  // self-navigation must not reach authenticated APIs or an external website.
  if(!details.isMainFrame&&!/^about:(?:srcdoc|blank)(?:#|$)/.test(details.url))details.preventDefault();
 });
 await window.loadURL(origin);if(quitting||!liveWindow(window))return {ok:false};if(activationPending||!process.argv.includes('--background')){activationPending=false;window.show();window.focus();}if(primary&&liveWindow(win))win.hide();return {ok:true};
 }catch(error){if(!quitting&&liveWindow(window)){try{window.webContents.removeAllListeners('will-navigate');await window.loadURL(startupPage('工作台启动失败：'+safeError(error),true));}catch{/* closed while reporting failure */}}return {ok:false};}
}
if(hasSingleInstanceLock)app.whenReady().then(async()=>{
 lifecycle.install();
 ipcMain.handle('suwen:desktop',(event,method:unknown,value:unknown)=>{
  const target=researchWindow;
  if(!liveWindow(target)||event.sender!==target.webContents||event.senderFrame!==target.webContents.mainFrame)throw new Error('Untrusted desktop sender');
  if(method==='getCloseAction')return lifecycle.getCloseAction();
  if(method==='setCloseAction')return lifecycle.setCloseAction(value);
  if(method==='retryStartup'&&target.webContents.getURL().startsWith('data:text/html')){try{target.destroy();}catch{/* already closed */}if(researchWindow===target)researchWindow=null;void openResearchWorkspace(true);return {ok:true};}
  throw new Error('Unsupported desktop operation');
 });
 ensureHome(home);let startupError='';try{await connectDaemon();const c=readConfig();if(c&&connection)await rpc(connection,'configure',c);if(connection)await pushSecrets();}catch(err){startupError=safeError(err);}
 if(quitting)return;
 if(!nativeConsole){
  await openResearchWorkspace(true);
  return;
 }
 win=new BrowserWindow({width:1400,height:930,minWidth:980,minHeight:680,title:'Eve',titleBarStyle:'hidden',titleBarOverlay:{color:'#eef1f6',symbolColor:'#333333',height:36},show:!process.argv.includes('--background'),backgroundColor:'#eef1f6',webPreferences:{preload:join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:!testHome}});
 const shell=win;
 lifecycle.attach(shell);
 shell.on('show',()=>{void pumpEvents();});
 shell.on('closed',()=>{if(win===shell)win=null;});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(uiFile).href)event.preventDefault();});
 win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 ipcMain.handle('suwen:call',async(event,method:unknown,params:any)=>{
  if(!liveWindow(win)||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==pathToFileURL(uiFile).href)throw new Error('Untrusted sender');
  if(typeof method!=='string'||JSON.stringify(params??{}).length>1_000_000)throw new Error('Invalid request');
  try{
   if(method==='settings') {const c=readConfig();return {provider:c?.provider??'openai',baseUrl:c?.baseUrl??'https://api.openai.com/v1',model:c?.model??'gpt-4o-mini',contextWindow:c?.contextWindow??128000,maxOutput:c?.maxOutput??4096,hasKey:!!c?.apiKey,encrypted:safeStorage.isEncryptionAvailable(),launchAtLogin:app.getLoginItemSettings().openAtLogin,startupError,home};}
   if(method==='configure') {
    const old=readConfig();if(!params.apiKey&&old?.apiKey)params={...params,apiKey:old.apiKey};const c=validateModelConfig(params);
    if(!safeStorage.isEncryptionAvailable())throw new Error('系统加密不可用，拒绝明文保存密钥');
    if(!connection)await connectDaemon();await rpc(connection!,'configure',c);
    const encrypted=safeStorage.encryptString(JSON.stringify(c));const tmp=secureConfigPath()+'.tmp';writeFileSync(tmp,encrypted,{mode:0o600});(await import('node:fs')).renameSync(tmp,secureConfigPath());return {ok:true};
   }
   if(method==='login') {if(typeof params.enabled!=='boolean')throw new Error('Invalid login setting');app.setLoginItemSettings({openAtLogin:params.enabled,args:['--background']});return {enabled:app.getLoginItemSettings().openAtLogin};}
   if(method==='reconnect'){await connectDaemon();const c=readConfig();if(c)await rpc(connection!,'configure',c);await pushSecrets();return {ok:true};}
   if(method==='pythonPicker') {const result=await dialog.showOpenDialog(win,{title:'选择 Python 解释器（可选）',properties:['openFile'],filters:[{name:'Python',extensions:['exe']}]});if(result.canceled)return {cancelled:true};if(!connection)await connectDaemon();await rpc(connection!,'python',{path:result.filePaths[0]});return {path:result.filePaths[0]};}
   if(method==='workbench.status')return await workbench.status();
   if(method==='workbench.cancel')return {cancelled:workbench.cancel()};
   if(method==='workbench.install') {
    if(!liveWindow(win))throw new Error('窗口不可用');
    // Long-running but bounded: resolves only after install/probe finishes; progress events stream separately.
    return await workbench.install(progress=>{sendToWindow(win,'suwen:workbench',progress);});
   }
   if(method==='legacyOpen') {
    return await openResearchWorkspace();
   }
   if(method==='events.replay') {
    // Renderer-initiated gap replay: same frozen daemon protocol, bounded window.
    await ensureConnected();if(!connection)throw new Error('后台未连接，请在设置中重连');
    const since=Number(params?.since);
    const limit=Number(params?.limit);
    return await rpc(connection,'events.stream',{since:Number.isFinite(since)&&since>=0?Math.floor(since):0,limit:Number.isFinite(limit)?Math.max(1,Math.min(2000,Math.floor(limit))):2000});
   }
   if(method==='shutdown'){if(connection)await rpc(connection,'shutdown');connection=null;return {ok:true};}
   if(method==='secrets.status'){let refs:string[]=[];let available=safeStorage.isEncryptionAvailable();try{refs=Object.keys(readSecrets());}catch{}return {available,refs};}
   if(method==='secret.put') {
    const ref=String(params?.ref??'');if(!/^[A-Za-z][A-Za-z0-9._:-]{0,199}$/.test(ref))throw new Error('凭据引用名无效');
    const value=params?.value;if(typeof value!=='string'||value.length<1||value.length>8192)throw new Error('凭据值无效');
    const map=readSecrets();map[ref]=value;writeSecrets(map);await pushSecrets();return {ok:true,count:Object.keys(map).length};
   }
   if(method==='secret.remove') {
    const ref=String(params?.ref??'');if(!/^[A-Za-z][A-Za-z0-9._:-]{0,199}$/.test(ref))throw new Error('凭据引用名无效');
    const map=readSecrets();delete map[ref];writeSecrets(map);await pushSecrets();return {ok:true,count:Object.keys(map).length};
   }
   if(method==='support') {if(!connection)throw new Error('后台未连接');const snapshot=await rpc(connection,'snapshot');let doctor:any=null;let worker:any=null;try{doctor=await rpc(connection,'doctor.run');}catch{}try{worker=await rpc(connection,'worker.health');}catch{}const result=await dialog.showSaveDialog(win,{defaultPath:'Eve-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return {cancelled:true};const redacted={version:app.getVersion(),generatedAt:new Date().toISOString(),health:snapshot.health,doctor,worker,tasks:snapshot.tasks.map((t:any)=>({id:t.id,status:t.status,version:t.version,steps:t.steps.map((s:any)=>({id:s.id,status:s.status,attempts:s.attempts,operationId:s.operationId})),eventCount:t.events.length}))};writeFileSync(result.filePath,JSON.stringify(redacted,null,2));return {ok:true};}
   if(!exposed.has(method))throw new Error('Unsupported method');await ensureConnected();if(!connection)throw new Error('后台未连接，请在设置中重连');return await rpc(connection,method,params??{});
  }catch(err){throw new Error(safeError(err));}
 });
 try{await shell.loadFile(uiFile);}catch(error){if(quitting||!liveWindow(shell))return;throw error;}
 if(quitting||!liveWindow(shell))return;
 startEventPump();
 if(activationPending){activationPending=false;if(liveWindow(shell)){shell.show();shell.focus();}}
 else if(process.argv.includes('--background')&&liveWindow(shell))shell.hide();
});
if(hasSingleInstanceLock)app.on('before-quit',event=>{if(!quitting){event.preventDefault();void lifecycle.quit();return;}workbench.cancel();lifecycle.dispose();if(pumpTimer)clearInterval(pumpTimer);if(reconnectTimer)clearTimeout(reconnectTimer);});
if(hasSingleInstanceLock)app.on('window-all-closed',()=>{if(quitting)app.quit();});
