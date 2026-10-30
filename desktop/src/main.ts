import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { rpc } from './rpc.js';
import { ensureHome, readConnection, safeError, type Connection } from './security.js';
import { WorkbenchManager } from './workbench.js';
import {WindowLifecycle} from './window-lifecycle.js';
import {resolveUserData} from './user-data.js';
import {blocksRuntimeUpgrade, compatibleRuntime, runtimeIdentity} from './runtime-identity.js';
import {startupPage, startupStateScript} from './startup-page.js';

const here=dirname(fileURLToPath(import.meta.url));
app.setName('Eve');
// Eve owns its profile. Legacy SuWen data is renamed once when that can be done
// safely; a locked old profile is left intact rather than shared.
const testHome=process.env.EVE_TEST_HOME??process.env.SUWEN_TEST_HOME;
const buildIdentity=runtimeIdentity(app.getVersion(),resolve(here,'..'));
const userData=resolveUserData({appData:app.getPath('appData'),testHome:testHome?resolve(testHome):undefined});
app.setPath('userData',userData.path);
if(userData.migrationError)console.warn('[Eve] Legacy profile migration deferred; old data remains intact:',userData.migrationError);
const hasSingleInstanceLock=app.requestSingleInstanceLock();
if(!hasSingleInstanceLock)app.quit();
let connection:Connection|null=null;
let researchWindow:BrowserWindow|null=null;
let quitting=false;
let activationPending=false;
const home=join(app.getPath('userData'),'runtime');
const windowChrome={
 light:{background:'#f5f5f5',symbol:'#202020'},
 dark:{background:'#181818',symbol:'#ececec'},
 height:36,
};
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
export const lifecycle=new WindowLifecycle({path:join(app.getPath('userData'),'desktop-window.json'),icon:app.isPackaged?join(process.resourcesPath,'eve.ico'):resolve(here,'../../assets/eve.ico'),window:()=>liveWindow(researchWindow)?researchWindow:null,
 active:async()=>{if(!connection)return 0;const snapshot=await rpc(connection,'snapshot');return snapshot.tasks.filter((t:any)=>!['completed','failed','cancelled'].includes(t.status)).length;},
 shutdown:async()=>{workbench.cancel();if(!connection)return;const old=connection;await rpc(old,'shutdown');for(let i=0;i<250;i++){await new Promise(r=>setTimeout(r,100));const current=readConnection(home);if(!current||current.pid!==old.pid){connection=null;return;}}throw new Error('运行时未在 25 秒内完成资源清理，请检查任务状态');},
 quit:()=>{quitting=true;app.quit();}});
function activateExistingInstance():void{
 activationPending=true;
 const target=liveWindow(researchWindow)?researchWindow:BrowserWindow.getAllWindows().find(candidate=>liveWindow(candidate));
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
/** Fast path for renderer calls made while the daemon is restarting. */
async function ensureConnected():Promise<void>{
 if(connection)return;
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
/** The formal workbench is the only product home and the only renderer. */
async function openResearchWorkspace():Promise<{ok:boolean}> {
 if(quitting)return {ok:false};
 if(liveWindow(researchWindow)){researchWindow.show();researchWindow.focus();return {ok:true};}
 const isolated=session.fromPartition(`suwen-research-${randomUUID()}`);
 const window=new BrowserWindow({width:1600,height:1000,minWidth:980,minHeight:680,title:'Eve',titleBarStyle:'hidden',titleBarOverlay:{color:windowChrome.light.background,symbolColor:windowChrome.light.symbol,height:windowChrome.height},backgroundColor:windowChrome.light.background,show:!process.argv.includes('--background'),webPreferences:{preload:join(here,'desktop-preload.cjs'),session:isolated,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 researchWindow=window;
 lifecycle.attach(window);
 isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.on('closed',()=>{try{isolated.webRequest.onBeforeSendHeaders(null);}catch{/* session already torn down */}if(researchWindow===window)researchWindow=null;});
 try{
 await window.loadURL(startupPage(app.getVersion(),{title:'正在准备 Eve',detail:'检查本地运行环境'}));
 let runtime=await workbench.runtime();
 if(!runtime.ready){
  const installed=await workbench.install(progress=>runInWindow(window,startupStateScript({title:'正在准备运行环境',detail:String(progress.message||'安装本地依赖')})));
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
 await window.loadURL(origin);if(quitting||!liveWindow(window))return {ok:false};if(activationPending||!process.argv.includes('--background')){activationPending=false;window.show();window.focus();}return {ok:true};
 }catch(error){if(!quitting&&liveWindow(window)){try{window.webContents.removeAllListeners('will-navigate');await window.loadURL(startupPage(app.getVersion(),{title:'启动未完成',detail:safeError(error),failed:true}));}catch{/* closed while reporting failure */}}return {ok:false};}
}
if(hasSingleInstanceLock)app.whenReady().then(async()=>{
 lifecycle.install();
 ipcMain.handle('suwen:desktop',(event,method:unknown,value:unknown)=>{
  const target=researchWindow;
  if(!liveWindow(target)||event.sender!==target.webContents||event.senderFrame!==target.webContents.mainFrame)throw new Error('Untrusted desktop sender');
  if(method==='getCloseAction')return lifecycle.getCloseAction();
  if(method==='setCloseAction')return lifecycle.setCloseAction(value);
  if(method==='setWindowTheme'){
   if(value!=='light'&&value!=='dark')throw new Error('Unsupported window theme');
   const colors=windowChrome[value];
   target.setTitleBarOverlay({color:colors.background,symbolColor:colors.symbol,height:windowChrome.height});
   target.setBackgroundColor(colors.background);
   return {ok:true,theme:value};
  }
  if(method==='retryStartup'&&target.webContents.getURL().startsWith('data:text/html')){try{target.destroy();}catch{/* already closed */}if(researchWindow===target)researchWindow=null;void openResearchWorkspace();return {ok:true};}
  throw new Error('Unsupported desktop operation');
 });
 ensureHome(home);try{await connectDaemon();const c=readConfig();if(c&&connection)await rpc(connection,'configure',c);if(connection)await pushSecrets();}catch{/* The workbench reports its own recovery state below. */}
 if(quitting)return;
 await openResearchWorkspace();
});
if(hasSingleInstanceLock)app.on('before-quit',event=>{if(!quitting){event.preventDefault();void lifecycle.quit();return;}workbench.cancel();lifecycle.dispose();});
if(hasSingleInstanceLock)app.on('window-all-closed',()=>{if(quitting)app.quit();});
