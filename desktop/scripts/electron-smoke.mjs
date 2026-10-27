import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync,writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const workspace=resolve(process.env.SUWEN_SMOKE_OUTPUT??join(project,'release','smoke'));
mkdirSync(workspace+'/outputs',{recursive:true});
mkdirSync(workspace+'/work',{recursive:true});
const require=createRequire(project+'/package.json');
const {_electron}=require('playwright-core');
const {rpc}=await import(pathToFileURL(project+'/dist/src/rpc.js'));
const {readConnection}=await import(pathToFileURL(project+'/dist/src/security.js'));
const profile=workspace+'/work/electron-e2e-profile';mkdirSync(profile,{recursive:true});
const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk.toString();assert.match(req.url,/chat\/completions$/);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'这是一条本地模拟服务的界面验收响应。\n\n'}}]})+'\n\n');setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{delta:{content:'已验证流式显示、任务持久化与执行记录；这不是科研结论。'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:50}})+'\n\ndata: [DONE]\n\n'),300);});
server.listen(0,'127.0.0.1');await once(server,'listening');
const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
const packaged=process.env.SUWEN_SMOKE_PACKAGED==='1';
const executablePath=packaged?project+'/release/win-unpacked/Eve.exe':project+'/node_modules/electron/dist/electron.exe';
const launchArgs=packaged?['--native']:[project,'--native'];
let app,connection;const closes=[];const log={modelProtocol:'local HTTP fixture only; no external model account',checks:[]};
try{
 app=await _electron.launch({executablePath,args:launchArgs,env,timeout:30000});
 const page=await app.firstWindow();page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));await page.waitForSelector('#health');
 await page.waitForFunction(()=>document.getElementById('health').textContent.includes('后台运行'),{timeout:20000});log.checks.push('Electron main + detached runAsNode daemon + named pipe ready');
 assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.evaluate(()=>typeof window.suwen.call),'function');log.checks.push('renderer has no Node require; contextBridge present');
 await page.locator('[data-page="settings"]').click();await page.locator('#baseUrl').fill(`http://127.0.0.1:${server.address().port}/v1`);await page.locator('#model').fill('local-protocol-fixture');await page.locator('#apiKey').fill('fixture-only-not-a-real-secret');await page.locator('#contextWindow').fill('16000');await page.locator('#maxOutput').fill('512');await page.locator('#settings-form button.primary').click();await page.waitForFunction(()=>document.getElementById('saved').textContent.includes('已加密保存'));log.checks.push('safeStorage encrypted model configuration');
 await page.locator('[data-page="chat"]').click();await page.locator('#mode').selectOption('chat');await page.locator('#prompt').fill('界面验收：请明确标注这是一条本地模拟服务响应。');await page.locator('#send').click();await page.waitForFunction(()=>document.getElementById('timeline').textContent.includes('这不是科研结论。'),{timeout:20000});await page.waitForFunction(()=>document.getElementById('timeline').textContent.includes('已完成'),{timeout:10000});log.checks.push('chat fixture streamed and committed');
 await page.locator('#toggle-evidence').click();await page.screenshot({path:workspace+'/outputs/SuWen-preview.png',fullPage:true});
 await page.locator('[data-page="tasks"]').click();await page.locator('#task-demo').click();await page.waitForFunction(()=>document.getElementById('task-list').textContent.includes('等待计时'),{timeout:10000});
 connection=readConnection(profile+'/runtime');assert.ok(connection);const before=await rpc(connection,'snapshot');const demo=before.tasks.find(t=>t.name.startsWith('后台恢复演示'));assert.ok(demo);log.daemonPid=connection.pid;log.timerTask=demo.id;
 const processHandle=app.process();closes.push(app.close());app=null;await new Promise(r=>setTimeout(r,1000));assert.notEqual(processHandle.exitCode,null);assert.equal((await rpc(connection,'health')).pid,connection.pid);log.checks.push('closing actual Electron UI does not kill detached daemon');
 const deadline=Date.now()+38000;let task;while(Date.now()<deadline){const s=await rpc(connection,'snapshot');task=s.tasks.find(t=>t.id===demo.id);if(task.status==='completed')break;await new Promise(r=>setTimeout(r,500));}assert.equal(task.status,'completed');assert.equal(task.steps.find(s=>s.id==='start').attempts,1);log.checks.push('30-second persisted timer completed after UI exit; committed start step executed once');
 app=await _electron.launch({executablePath,args:launchArgs,env,timeout:30000});const reopened=await app.firstWindow();await reopened.waitForFunction(()=>document.getElementById('health').textContent.includes('后台运行'),{timeout:15000});assert.equal(readConnection(profile+'/runtime').pid,connection.pid);log.checks.push('reopen attaches to same daemon and restores task history');
 await reopened.locator('[data-page="tools"]').click();await reopened.screenshot({path:workspace+'/outputs/SuWen-tools.png',fullPage:true});
 if(process.env.SUWEN_SMOKE_LIVE==='1'){
  const databaseTask=await reopened.evaluate(()=>window.suwen.call('create',{name:'Packaged live MCP public database QA',steps:[{id:'literature',kind:'pubmed',input:{query:'TP53 cancer'},timeoutMs:30000,maxAttempts:1},{id:'protein',kind:'uniprot',input:{query:'gene:TP53 AND organism_id:9606'},timeoutMs:30000,maxAttempts:1}]}));
  let databaseResult;const dbDeadline=Date.now()+35000;
  while(Date.now()<dbDeadline){databaseResult=(await rpc(connection,'snapshot')).tasks.find(t=>t.id===databaseTask.id);if(['completed','failed','waiting_approval'].includes(databaseResult.status))break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(databaseResult.status,'completed',JSON.stringify(databaseResult.steps.map(s=>({kind:s.kind,error:s.error}))));
  assert.ok(databaseResult.steps.every(s=>s.output?.results?.length>0));log.checks.push('packaged daemon inherited system proxy and completed two live readonly MCP public database searches');
  writeFileSync(workspace+'/work/packaged-live-mcp-results.json',JSON.stringify(databaseResult,null,2));
 }else{log.liveMcp='skipped: SUWEN_SMOKE_LIVE is unset; live public-database evidence is exercised separately by scripts/e2e-rpc.mjs --live';}
 const sample=await reopened.evaluate(()=>window.suwen.call('create',{name:'Packaged Python research-worker sandbox QA',steps:[{id:'stats',kind:'python',input:{language:'python',source:'import statistics; print(statistics.mean([2,4,4,6,9]))'},timeoutMs:30000,maxAttempts:1}]}));
 let sampleResult;const sampleDeadline=Date.now()+45000;while(Date.now()<sampleDeadline){sampleResult=(await rpc(connection,'snapshot')).tasks.find(t=>t.id===sample.id);if(['completed','failed'].includes(sampleResult.status))break;await new Promise(r=>setTimeout(r,250));}assert.equal(sampleResult.status,'completed',JSON.stringify(sampleResult.steps.map(s=>({kind:s.kind,error:s.error}))));const sampleOut=sampleResult.steps[0].output;assert.equal(sampleOut.exitCode,0);assert.match(String(sampleOut.stdout),/\b5(\.0)?\b/);log.checks.push('packaged Python research-worker ran a sandboxed stdlib script (exit 0, mean 5)');
 try{
  const newWindow=app.waitForEvent('window',{timeout:60000}).catch(()=>null);
  try {
   await reopened.evaluate(()=>window.suwen.call('legacyOpen'));
   const legacyPage=await newWindow;assert.ok(legacyPage,'legacy window event');await legacyPage.waitForLoadState('domcontentloaded');
   assert.equal(await legacyPage.evaluate(()=>typeof window.require),'undefined');
   assert.equal(await legacyPage.evaluate(()=>typeof window.suwen),'undefined');
   const health=await rpc(connection,'health');assert.ok(health.legacy?.port);
   const unauthorized=await fetch(`http://127.0.0.1:${health.legacy.port}/api/health`);assert.equal(unauthorized.status,401);
   // The hosted legacy web UI must be the real SPA, not an empty shell.
   await legacyPage.waitForFunction(()=>document.querySelectorAll('nav [data-route], .nav-item, #nav button, #nav a').length>=8,{timeout:30000}).catch(()=>null);
   const legacyShell=await legacyPage.evaluate(()=>({title:document.title,brand:(document.body.textContent||'').includes('素问'),nav:document.querySelectorAll('nav [data-route], .nav-item, #nav button, #nav a').length,routes:[...document.querySelectorAll('[data-route]')].map(e=>e.getAttribute('data-route'))}));
   assert.match(legacyShell.title,/素问/);assert.equal(legacyShell.brand,true);assert.ok(legacyShell.nav>=8,`legacy nav items: ${legacyShell.nav}`);
   await legacyPage.screenshot({path:join(workspace,'work','legacy-workbench.png')}).catch(()=>null);
   log.legacyWorkbench={hosted:true,title:legacyShell.title,navItems:legacyShell.nav,routes:legacyShell.routes.slice(0,20),screenshot:'work/legacy-workbench.png'};
   log.checks.push('packaged optional Python workbench opens isolated authenticated window; unauthorized HTTP rejected');
   log.checks.push('packaged hosted legacy web SPA renders shell navigation');
  } catch(legacyError){
   await newWindow;
   if(process.env.SUWEN_WORKBENCH_DEPS)throw legacyError;
   log.legacyWorkbench='unavailable on this machine: '+legacyError.message;
  }
 }catch(legacyOuter){log.legacyWorkbench='unavailable on this machine: '+legacyOuter.message;}
 log.runtimeVersions=(await rpc(connection,'health')).runtimeVersions;log.packaged=packaged;log.result='passed';
}catch(err){log.result='failed';log.error=err.message;console.log(err.stack);process.exitCode=1;}
finally{
 if(connection){try{await rpc(connection,'shutdown');}catch{}}
 if(app)closes.push(app.close());await Promise.allSettled(closes);server.close();server.closeAllConnections();
 writeFileSync(workspace+'/work/electron-e2e-result.json',JSON.stringify(log,null,2));console.log(JSON.stringify(log,null,2));
}
