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

const here=dirname(fileURLToPath(import.meta.url));
app.setName('SuWen');
if(process.env.SUWEN_TEST_HOME)app.setPath('userData',resolve(process.env.SUWEN_TEST_HOME));
if(!app.requestSingleInstanceLock())app.quit();
let win:BrowserWindow|null=null,connection:Connection|null=null;
let streamCursor=0,pumpTimer:NodeJS.Timeout|null=null,pumpBusy=false;
let reconnectTimer:NodeJS.Timeout|null=null,reconnecting=false;
const home=join(app.getPath('userData'),'runtime');
const uiFile=resolve(here,'../ui/index.html');
async function connectDaemon():Promise<void>{
 const old=readConnection(home);if(old){try{await rpc(old,'health');connection=old;return;}catch{}}
 const script=join(here,'daemon.js');const worker=app.isPackaged?join(process.resourcesPath,'worker','research_worker.py'):resolve(here,'../../worker/research_worker.py');
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_USE_ENV_PROXY:'1'} as NodeJS.ProcessEnv;
 // Node fetch does not automatically use Windows' system proxy. Resolve it through Electron.
 if(!env.HTTPS_PROXY&&!env.HTTP_PROXY){
  const resolved=await session.defaultSession.resolveProxy('https://api.openai.com');
  const match=resolved.match(/^PROXY ([a-zA-Z0-9.:[\]-]+:\d+)(?:;|$)/);
  if(match){env.HTTPS_PROXY='http://'+match[1];env.HTTP_PROXY=env.HTTPS_PROXY;}
 }
 env.NO_PROXY=env.NO_PROXY??'localhost,127.0.0.1,::1';
 const child=spawn(process.execPath,[script,'--home',home,'--worker',worker,'--legacy-source',app.isPackaged?join(process.resourcesPath,'legacy'):resolve(here,'../../..'),'--legacy-script',app.isPackaged?join(process.resourcesPath,'worker','legacy_server.py'):resolve(here,'../../worker/legacy_server.py')],{detached:true,windowsHide:true,stdio:'ignore',env});child.unref();
 for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,150));const c=readConnection(home);if(c){try{await rpc(c,'health');connection=c;return;}catch{}}}
 throw new Error('后台未启动，请在诊断中重试。');
}
/** Push incremental daemon events to the renderer; see docs/architecture/streaming-events.md. */
async function pumpEvents():Promise<void>{
 if(pumpBusy||!win||win.isDestroyed())return;
 if(!connection){scheduleReconnect();return;}
 pumpBusy=true;
 try{
  const batch:any=await rpc(connection,'events.stream',{since:streamCursor,limit:500});
  if(typeof batch?.cursor==='number')streamCursor=batch.cursor;
  const hasPayload=batch?.reset===true||(Array.isArray(batch?.events)&&batch.events.length>0)||(Array.isArray(batch?.streams)&&batch.streams.length>0)||(Array.isArray(batch?.tasks)&&batch.tasks.length>0);
  if(hasPayload&&win&&!win.isDestroyed())win.webContents.send('suwen:events',batch);
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
 pumpTimer=setInterval(()=>{void pumpEvents();},100);
 pumpTimer.unref?.();
}
/** Renderer-facing connection state for streaming UI recovery. */
function notifyConnection(state:'reconnecting'|'restored'|'lost'):void{
 try{if(win&&!win.isDestroyed())win.webContents.send('suwen:connection',{state,at:Date.now()});}catch{/* window teardown */}
}
/** Re-establish the detached daemon without losing the renderer; bounded exponential backoff. */
function scheduleReconnect():void{
 if(reconnecting||reconnectTimer)return;
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
const MAIN_ONLY=new Set(['settings','configure','login','reconnect','pythonPicker','legacyOpen','shutdown','support','secrets.status','secret.put','secret.remove','secrets.set','events.stream']);
/** Main-process handlers that the sandboxed renderer may invoke directly (no daemon passthrough). */
const UI_MAIN_METHODS=['secrets.status','secret.put','secret.remove','events.replay'];
const exposed=new Set<string>([...RPC_METHODS.filter(method=>!MAIN_ONLY.has(method)),...UI_MAIN_METHODS]);
app.whenReady().then(async()=>{
 ensureHome(home);let startupError='';try{await connectDaemon();const c=readConfig();if(c&&connection)await rpc(connection,'configure',c);if(connection)await pushSecrets();}catch(err){startupError=safeError(err);}
 win=new BrowserWindow({width:1400,height:930,minWidth:980,minHeight:680,title:'素问 · SuWen',backgroundColor:'#f6f7fa',webPreferences:{preload:join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(uiFile).href)event.preventDefault();});
 win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 ipcMain.handle('suwen:call',async(event,method:unknown,params:any)=>{
  if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==pathToFileURL(uiFile).href)throw new Error('Untrusted sender');
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
   if(method==='legacyOpen') {
    if(!connection)await connectDaemon();const result=await rpc(connection!,'legacyStart');
    const origin=`http://127.0.0.1:${result.port}`;
    const isolated=session.fromPartition(`suwen-legacy-${randomUUID()}`);
    const legacyWindow=new BrowserWindow({width:1400,height:930,title:'素问 · 科研工作台（Python 兼容）',webPreferences:{session:isolated,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    isolated.webRequest.onBeforeSendHeaders({urls:[origin+'/*']},(details,callback)=>{
     if(details.webContentsId===legacyWindow.webContents.id)callback({requestHeaders:{...details.requestHeaders,Authorization:'Bearer '+result.token}});else callback({cancel:true});
    });
    legacyWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    legacyWindow.webContents.on('will-navigate',(navigation,url)=>{try{if(new URL(url).origin!==origin)navigation.preventDefault();}catch{navigation.preventDefault();}});
    legacyWindow.on('closed',()=>isolated.webRequest.onBeforeSendHeaders(null));
    await legacyWindow.loadURL(origin);return {ok:true};
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
   if(method==='support') {if(!connection)throw new Error('后台未连接');const snapshot=await rpc(connection,'snapshot');let doctor:any=null;let worker:any=null;try{doctor=await rpc(connection,'doctor.run');}catch{}try{worker=await rpc(connection,'worker.health');}catch{}const result=await dialog.showSaveDialog(win,{defaultPath:'SuWen-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return {cancelled:true};const redacted={version:app.getVersion(),generatedAt:new Date().toISOString(),health:snapshot.health,doctor,worker,tasks:snapshot.tasks.map((t:any)=>({id:t.id,status:t.status,version:t.version,steps:t.steps.map((s:any)=>({id:s.id,status:s.status,attempts:s.attempts,operationId:s.operationId})),eventCount:t.events.length}))};writeFileSync(result.filePath,JSON.stringify(redacted,null,2));return {ok:true};}
   if(!exposed.has(method))throw new Error('Unsupported method');await ensureConnected();if(!connection)throw new Error('后台未连接，请在设置中重连');return await rpc(connection,method,params??{});
  }catch(err){throw new Error(safeError(err));}
 });
 await win.loadFile(uiFile);
 startEventPump();
 if(process.argv.includes('--background'))win.hide();
 app.on('second-instance',()=>{const target=win&&!win.isDestroyed()?win:BrowserWindow.getAllWindows()[0];target?.show();target?.focus();});
});
app.on('window-all-closed',()=>app.quit());
// UI exit deliberately leaves the detached daemon alive; explicit shutdown pauses work.
