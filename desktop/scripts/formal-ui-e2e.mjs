/** Full product launch and UI -> HTTP -> Python adapter -> IPC -> TS harness -> live model/tool -> UI. */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(root,'package.json'));const {_electron}=require('playwright-core');
const {rpc}=await import('../dist/src/rpc.js');
const args=process.argv;const credentials=args.find(x=>x.startsWith('--credentials='))?.slice(14);
if(!credentials)throw new Error('Explicit credentials file required');
const lines=readFileSync(credentials,'utf8').trim().split(/\r?\n/).filter(x=>x.trim());let baseUrl=lines.find(x=>x.startsWith('https:')).trim();let apiKey=lines.find(x=>!x.startsWith('https:')).trim();
const fixture=args.includes('--fixture');let modelServer;
if(fixture){
 modelServer=createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);res.writeHead(200,{'content-type':'text/event-stream'});const observation=body.messages.filter(x=>x.role==='tool').at(-1);
 if(!observation)res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'formal-call-1',type:'function',function:{name:'database_search',arguments:'{"database":"pubmed","query":"16904174"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:30}})+'\n\ndata: [DONE]\n\n');
 else {const data=JSON.parse(observation.content);if(!data.ok)throw new Error('Actual database tool failed');const paper=data.result.results.find(x=>x.pmid==='16904174');if(!paper)throw new Error('PMID absent from actual response');const text=`${paper.title}\nPMID 16904174 · ${paper.year}\n[来源](${paper.url})`;res.end('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:30}})+'\n\ndata: [DONE]\n\n');}
 }catch{res.end('data: {"error":{"message":"fixture failed"}}\n\n');}});
 modelServer.listen(0,'127.0.0.1');await once(modelServer,'listening');baseUrl=`http://127.0.0.1:${modelServer.address().port}/v1`;apiKey='local-ui-fixture';
}
const profile=args.find(x=>x.startsWith('--profile='))?.slice(10)??mkdtempSync(join(tmpdir(),'suwen-formal-ui-'));
const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
const packaged=args.includes('--packaged');
const executablePath=packaged?join(root,'release/win-unpacked/Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const launchArgs=packaged?[]:[root];
const out=resolve(root,args.find(x=>x.startsWith('--output-dir='))?.slice(13)??'../docs/verification/harness-20261025');mkdirSync(out,{recursive:true});
const report={kind:fixture?'controlled local model protocol fixture, REAL public PubMed tool, default product launch; NOT real-model acceptance':'real external model and public network; default product launch',checks:[],errors:[],screenshots:[]};
let app,connection;
const check=(name,ok,detail)=>{report.checks.push({name,ok:Boolean(ok),detail});console.log(`${ok?'PASS':'FAIL'} ${name}${detail?`: ${detail}`:''}`);};
try{
  // Bootstrap only the encrypted credential configuration in this throwaway profile.
  if(fixture||!existsSync(join(profile,'runtime/model-config.enc'))){
  console.log('Preparing isolated encrypted model config');
  app=await _electron.launch({executablePath,args:[...launchArgs,'--native','--background'],env,timeout:60000});let shell=await app.firstWindow();
  await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
  await shell.evaluate(async config=>{await window.suwen.call('configure',config);},{provider:'openai',baseUrl,apiKey,model:'deepseek-v4.1-flash-economy',contextWindow:65536,maxOutput:2048});
  await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);app=null;
  }
  // No --native, workbench.install or legacyOpen call: this is the normal launch.
  console.log('Launching default research workspace');
  app=await _electron.launch({executablePath,args:launchArgs,env,timeout:60000});
  let page;
  for(let i=0;i<180;i++){page=app.windows().find(p=>/^http:\/\/127\.0\.0\.1:/.test(p.url()));if(page)break;await new Promise(r=>setTimeout(r,500));}
  if(!page){report.startupDiagnostics=await Promise.all(app.windows().map(async window=>({url:window.url().startsWith('data:')?'data:startup':window.url(),error:await window.locator('#startup-status').textContent({timeout:2000}).catch(()=>null)})));throw new Error('Default launch did not open the research workspace');}
  await page.waitForLoadState('domcontentloaded');page.on('pageerror',e=>report.errors.push(e.message));
  await page.waitForSelector('.view-root > .route-mount > .workbench-page',{timeout:30000});
  const onboarding=page.getByRole('button',{name:'先看看',exact:true});
  try{await onboarding.waitFor({state:'visible',timeout:8000});await onboarding.click();}catch{}
  check('default-launch-opens-formal-workspace',true);
  const visible=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.isVisible()).map(w=>({title:w.getTitle(),url:w.webContents.getURL()})));
  check('single-visible-product-window',visible.length===1,JSON.stringify(visible));
  // The workbench is the formal home page and embeds the shared chat controller.
  // Do not navigate to the retired standalone chat route.
  await page.waitForSelector('.workbench-page .chat-view #chat-input',{timeout:30000});
  const before=await page.locator('.composer').boundingBox();
  await page.fill('#chat-input','实际检索 PubMed PMID 16904174，给出标题、年份、PMID 与来源链接，不超过150字。');await page.click('#send-btn');
  connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));
  let task=null;
  for(let i=0;i<360;i++){
    const snap=await rpc(connection,'snapshot');
    task=snap.tasks.find(t=>t.steps.some(s=>s.input?.prompt?.includes('16904174')));
    if(task&&['completed','failed','cancelled','interrupted'].includes(task.status))break;
    await new Promise(r=>setTimeout(r,500));
  }
  if(!task)throw new Error('The formal chat did not create a harness task');
  if(task.status!=='completed')throw new Error(`Harness task ended as ${task.status}: ${JSON.stringify(task.steps.map(s=>s.error).filter(Boolean)).slice(0,1200)}`);
  await page.waitForFunction(()=>document.getElementById('send-btn')?.disabled===false&&document.querySelectorAll('.tool-card.is-running').length===0,null,{timeout:30000});
  await page.waitForFunction(()=>{
    const assistant=[...document.querySelectorAll('#messages .msg.msg-assistant')].at(-1);
    return Boolean(assistant&&assistant.textContent.includes('16904174')&&!assistant.textContent.includes('正在执行'));
  },null,{timeout:30000});
  const text=await page.locator('#messages').innerText();
  check('formal-chat-uses-unified-harness',Boolean(task?.steps?.[0]?.output?.traceId),task?.status);
  check('formal-chat-executes-real-pubmed',task?.events?.some(e=>e.type==='tool.completed'&&e.data.name==='database_search'));
  check('formal-chat-verified-answer',task?.status==='completed'&&task.steps[0].output.verification.passed&&text.includes('16904174'));
  check('tool-card-settled',await page.locator('.tool-card.is-ok').count()>=1&&await page.locator('.tool-card.is-running').count()===0);
  const after=await page.locator('.composer').boundingBox();check('formal-composer-stable',Math.abs(before.y-after.y)<=2,JSON.stringify({beforeY:before.y,afterY:after.y}));
  const screenshot=join(out,fixture?'formal-workspace-controlled.png':'formal-workspace-live.png');await page.screenshot({path:screenshot,fullPage:false});report.screenshots.push(screenshot);
  report.task={id:task?.id,status:task?.status,answer:task?.steps?.[0]?.output?.text,trace:task?.steps?.[0]?.output?.trace,sources:task?.steps?.[0]?.output?.sources};
  check('no-renderer-errors',report.errors.length===0,report.errors.join(';'));
}catch(e){report.error=String(e.message).split(apiKey).join('[redacted]');console.log(report.error);}
finally{
  if(!connection){try{connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));}catch{}}
  try{if(connection)await rpc(connection,'shutdown');}catch{}
  if(app)await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);
  if(modelServer){modelServer.closeAllConnections();modelServer.close();}
  report.packaged=packaged;report.at=new Date().toISOString();writeFileSync(join(out,fixture?(packaged?'formal-ui-packaged.json':'formal-ui-controlled.json'):'formal-ui.json'),JSON.stringify(report,null,2).split(apiKey).join('[redacted]'));
  if(report.error||report.checks.some(x=>!x.ok))process.exitCode=1;
  process.exit(process.exitCode??0);
}
