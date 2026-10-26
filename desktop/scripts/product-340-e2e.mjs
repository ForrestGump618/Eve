/** Full formal UI, actual workspace files/skill worker, grouped tools, truncation
 * continuation. Default uses a labelled protocol fixture; --live uses the vendor. */
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core'),{rpc}=await import('../dist/src/rpc.js');
const live=process.argv.includes('--live'),packaged=process.argv.includes('--packaged');
const out=resolve(root,'../docs/verification/product-340-20261026');mkdirSync(out,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'suwen-product-340-')),workspace=join(profile,'test-workspace');mkdirSync(workspace);
writeFileSync(join(workspace,'sample.csv'),'value\n2\n4\n6\n');
let baseUrl,apiKey,server;
if(live){const path=process.argv.find(x=>x.startsWith('--credentials='))?.slice(14);if(!path)throw Error('Explicit credentials path required');const lines=readFileSync(path,'utf8').trim().split(/\r?\n/);baseUrl=lines.find(x=>x.startsWith('https:')).trim();apiKey=lines.find(x=>!x.startsWith('https:')).trim();}
else{
 server=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),observations=body.messages.filter(x=>x.role==='tool').map(x=>JSON.parse(x.content));
  const emit=(delta,reason='tool_calls')=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:reason}],usage:{prompt_tokens:200,completion_tokens:50}})+'\n\ndata: [DONE]\n\n');};
  const call=(name,args)=>emit({tool_calls:[{index:0,id:`step-${observations.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  if(observations.some(x=>!x.ok))return emit({content:'工具执行失败'},'stop');
  const steps=[['workspace_info',{}],['list_directory',{path:'.'}],['read_file',{path:'sample.csv'}],['skill_search',{query:'csv-analysis'}]];
  if(observations.length<4)return call(...steps[observations.length]);
  const id=observations[3].result.skills.find(x=>x.name==='csv-analysis').id;
  if(observations.length===4)return call('skill_load',{id});
  if(observations.length===5)return call('skill_run',{id,input:{csv:observations[2].result.content}});
  if(!body.messages.at(-1).content.includes('输出因长度上限中断'))return emit({content:'CSV_READ_OK，'},'length');
  const actual=JSON.parse(observations.at(-1).result.result.stdout);
  emit({content:`共 ${actual.rowCount} 行，均值 ${actual.numericSummary.value.mean}。RESULT_OK`},'stop');
 });server.listen(0,'127.0.0.1');await once(server,'listening');baseUrl=`http://127.0.0.1:${server.address().port}/v1`;apiKey='suwen-protocol-fixture-no-external-credential';
}
const report={kind:live?'real model + real files and worker':'controlled model protocol fixture + real files and Python worker; not real-model acceptance',packaged,checks:[],errors:[],at:new Date().toISOString()};
const check=(name,ok,detail)=>{report.checks.push({name,ok:Boolean(ok),detail});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
let app,connection;
try{
 const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=packaged?join(root,'release/product-340/win-unpacked/SuWen.exe'):join(root,'node_modules/electron/dist/electron.exe');
 const args=packaged?[]:[root];
 app=await _electron.launch({executablePath,args:[...args,'--native'],env});let shell=await app.firstWindow();await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 await shell.evaluate(async config=>window.suwen.call('configure',config),{provider:'openai',baseUrl,apiKey,model:'deepseek-v4.1-flash-economy',contextWindow:65536,maxOutput:8192});await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);app=null;
 app=await _electron.launch({executablePath,args,env});
 let page;for(let i=0;i<180;i++){page=app.windows().find(p=>p.url().startsWith('http://127.0.0.1:'));if(page)break;await new Promise(r=>setTimeout(r,500));}if(!page)throw Error('Formal window unavailable');
 page.on('pageerror',e=>report.errors.push(e.message));await page.waitForSelector('[data-route="chat"]');
 try{await page.getByRole('button',{name:'先看看',exact:true}).click({timeout:5000});}catch{}
 await page.locator('[data-route="chat"]').first().click();await page.waitForSelector('.view-root > .route-mount > .chat-view[data-ready="true"] #chat-input');
 await page.click('#chat-workspace');await page.getByPlaceholder('输入本机文件夹的完整路径').fill(workspace);await page.getByRole('button',{name:'使用此目录',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#chat-workspace span')?.textContent==='test-workspace');check('workspace-picker-selects-real-directory',true);
 const before=await page.locator('.composer').boundingBox();
 await page.fill('#chat-input',live?'读取工作目录中的 sample.csv，查找并加载 csv-analysis 技能，然后实际执行此技能汇总行数和值列的均值。必须报告均值4，末尾写 RESULT_OK，不超过200字。':'读取 sample.csv 并实际运行 csv-analysis Skill，汇报真实均值，末尾写 RESULT_OK。');await page.click('#send-btn');
 await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('RESULT_OK')&&!document.querySelector('#send-btn')?.disabled,null,{timeout:240000});
 connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));const snapshot=await rpc(connection,'snapshot');
 const task=snapshot.tasks.find(t=>t.name.includes('sample.csv'));report.task=task;
 const names=task.events.filter(x=>x.type==='tool.completed').map(x=>x.data.name);
 check('no-chat-execution-errors',await page.locator('#messages .error-card').count()===0);
 check('actual-file-and-skill-executed',task.status==='completed'&&names.includes('read_file')&&names.includes('skill_run'));
 if(!live)check('truncated-turn-recovers',task.events.some(x=>x.type==='model.continuing'));
 check('one-collapsed-tool-group',await page.locator('.tool-run').count()===1&&await page.locator('.tool-run[open]').count()===0);
 check('all-tool-cards-settled',await page.locator('.tool-card').count()===task.events.filter(x=>['tool.completed','tool.failed'].includes(x.type)).length&&await page.locator('.tool-card.is-running').count()===0);
 await page.locator('.tool-run-summary').click();check('tool-details-expand',await page.locator('.tool-run[open]').count()===1);
 await page.locator('.tool-head').first().click();check('raw-tool-result-accessible',await page.locator('.tool-card.is-open .tool-body').first().isVisible());
 await page.locator('.tool-run-summary').click();
 const style=await page.locator('.msg-user .msg-bubble').first().evaluate(x=>({image:getComputedStyle(x).backgroundImage,shadow:getComputedStyle(x).boxShadow}));check('flat-user-message',style.image==='none'&&style.shadow==='none',style);
 const after=await page.locator('.composer').boundingBox();check('composer-position-stable',Math.abs(before.y-after.y)<=2,{before:before.y,after:after.y});
 const inventory=await page.evaluate(()=>fetch('/api/skills').then(r=>r.json()));check('same-installed-skill-catalog-in-ui',inventory.skills.filter(x=>x.runtime==='desktop').length===8);
 const capabilities=await page.evaluate(()=>fetch('/api/platform/registry/skill').then(r=>r.json()));check('capability-center-shares-catalog',capabilities.items.filter(x=>x.runtime==='desktop').length===8);
 const csv=capabilities.items.find(x=>x.name==='csv-analysis');const toggled=await page.evaluate(async id=>{await fetch('/api/platform/registry/skill/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});const disabled=await fetch('/api/skills').then(r=>r.json());await fetch('/api/platform/registry/skill/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});return disabled.skills.find(s=>s.id===id)?.enabled===false;},csv.id);check('skill-toggle-shared-with-chat',toggled);
 await page.click('#chat-drawer-toggle');check('sidebar-collapses',await page.locator('.chat-view.sidebar-collapsed').count()===1);await page.click('#chat-drawer-toggle');
 await page.reload();await page.waitForSelector('.view-root > .route-mount > .chat-view[data-ready="true"] #chat-input');await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('RESULT_OK'),null,{timeout:30000});
 check('tool-history-survives-reload',await page.locator('.tool-run').count()===1&&await page.locator('.tool-card.is-running').count()===0&&await page.locator('.tool-card').count()===names.length);
 check('workspace-selection-survives-reload',await page.locator('#chat-workspace span').textContent()==='test-workspace');
 await page.locator('.tool-run-summary').click();await page.locator('.tool-head').first().click();check('raw-tool-preview-survives-reload',(await page.locator('.tool-card.is-open .tool-result').first().textContent()).includes('roots'));await page.locator('.tool-run-summary').click();
 check('run-details-survive-reload',await page.locator('.run-detail-link').count()>=1);
 const runId=await page.locator('.run-detail-link').first().getAttribute('data-run-id');const run=await page.evaluate(id=>fetch('/api/runs/'+encodeURIComponent(id)).then(r=>r.json()),runId);report.pythonRunStatus=run.status||run.run?.status;check('python-projection-and-harness-both-succeeded',report.pythonRunStatus==='succeeded');
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:join(out,`chat-${live?'live':'controlled'}-${theme}.png`)});}
 check('no-renderer-errors',report.errors.length===0);
}catch(e){report.error=String(e.message).split(apiKey).join('[redacted]');console.log(report.error);}
finally{
 try{connection??=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));}catch{}
 try{if(connection)await rpc(connection,'shutdown');}catch{}
 if(app)await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);if(server){server.closeAllConnections();server.close();}
 writeFileSync(join(out,`product-ui-${live?'live':'controlled'}${packaged?'-packaged':''}.json`),JSON.stringify(report,null,2).split(apiKey).join('[redacted]'));
 process.exit(report.error||report.checks.some(x=>!x.ok)?1:0);
}
