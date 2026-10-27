/** Full formal UI, actual workspace files/skill worker, grouped tools, truncation
 * continuation. Default uses a labelled protocol fixture; --live uses the vendor. */
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core'),{rpc}=await import('../dist/src/rpc.js');
const live=process.argv.includes('--live'),packaged=process.argv.includes('--packaged');
const packagedDirArg=process.argv.find(x=>x.startsWith('--packaged-dir='))?.slice(15);
const out=resolve(root,'../docs/verification/eve-1.0');mkdirSync(out,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'suwen-product-100-')),workspace=join(profile,'test-workspace');mkdirSync(workspace);writeFileSync(join(profile,'desktop-window.json'),JSON.stringify({closeAction:'quit'}));
writeFileSync(join(workspace,'sample.csv'),'value\n2\n4\n6\n');
const uiSkill=join(workspace,'ui-installed-skill');mkdirSync(uiSkill);
writeFileSync(join(uiSkill,'SKILL.md'),'# UI Installed Skill\n\nRead the selected workspace and report only observed values.\n');
writeFileSync(join(uiSkill,'skill.json'),JSON.stringify({name:'ui-installed-skill',version:'1.0.0',description:'Installed through the formal Capability Center',entry:'SKILL.md',license:'MIT',permissions:[]}));
let baseUrl,apiKey,server;const parallelModels={};let steeringActive=false,steeringAborted=false;
if(live){const path=process.argv.find(x=>x.startsWith('--credentials='))?.slice(14);if(!path)throw Error('Explicit credentials path required');const lines=readFileSync(path,'utf8').trim().split(/\r?\n/);baseUrl=lines.find(x=>x.startsWith('https:')).trim();apiKey=lines.find(x=>!x.startsWith('https:')).trim();}
else{
 server=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),observations=body.messages.filter(x=>x.role==='tool').map(x=>JSON.parse(x.content));
  const emit=(delta,reason='tool_calls')=>{if(!res.headersSent)res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:reason}],usage:{prompt_tokens:200,completion_tokens:50}})+'\n\ndata: [DONE]\n\n');};
  const call=(name,args)=>emit({tool_calls:[{index:0,id:`step-${observations.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const research=body.messages.find(x=>x.role==='user'&&x.content.includes('推进 Eve 课题'))?.content.match(/课题 (quest_[a-f0-9]+) 的 ([a-z]+) 阶段/);
  if(research){
   if(!observations.length)return call('research_list',{});
   if(observations.length===1)return call('skill_search',{query:'baseline'});
   if(observations.length===2)return call('skill_load',{id:observations[1].result.skills[0].id});
   if(observations.length===3)return call('read_file',{path:'sample.csv'});
   if(observations.length===4)return call('write_file',{path:'quest-scout.md',content:'Protocol fixture observed sample.csv values: 2,4,6. This is test evidence, not a scientific claim.'});
   if(observations.length===5)return call('research_record',{id:research[1],stage:research[2],artifacts:['quest-scout.md'],summary:'实际读取 CSV 并登记产物；协议测试，不宣称科学发现。'});
   return emit({content:'课题阶段已有真实产物记录 RESEARCH_STAGE_DONE'},'stop');
  }
  const parallel=body.messages.find(x=>x.role==='user'&&/MULTI_CASE_[AB]/.test(x.content))?.content.match(/MULTI_CASE_([AB])/)?.[1];
  if(body.messages.some(x=>x.role==='user'&&x.content.includes('STEER_CASE'))){
   const feedback=body.messages.filter(x=>x.role==='user'&&x.content.startsWith('[用户引导 '));
   if(!observations.length)return call('write_file',{path:'steering-before.txt',content:'original task executed'});
   if(!feedback.length){
    steeringActive=true;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'正在分析原始数据'},finish_reason:null}]})+'\n\n');
    res.on('close',()=>{if(!res.writableEnded)steeringAborted=true;steeringActive=false;});setTimeout(()=>{if(!res.destroyed)emit({content:'。初始模型请求完成。'},'stop');},20000).unref();return;
   }
   if(observations.length===1)return call('write_file',{path:'steering-guided.txt',content:feedback.map(x=>x.content).join('\n')});
   return emit({content:'STEERING_COMPLETED，实际文件已包含补充要求与批注。'},'stop');
  }
  if(parallel){
   parallelModels[parallel]??=[];parallelModels[parallel].push(body.model);
   if(!observations.length)return call('write_file',{path:'multi-before.txt',content:parallel});
   if(observations.length===1){setTimeout(()=>{if(!res.destroyed)call('write_file',{path:'multi-after.txt',content:parallel});},parallel==='A'?8000:3000).unref();return;}
   return emit({content:'MULTI_DONE_'+parallel},'stop');
  }
  const restoring=body.messages.some(x=>x.role==='user'&&x.content.includes('RESUME_CASE'));
  if(restoring){
   if(!observations.length)return call('write_file',{path:'resume-once.txt',content:'initial committed write'});
   if(body.messages.some(x=>x.role==='user'&&x.content.startsWith('从已保存')))return emit({content:'已复用原先写入的真实结果。RESUME_COMPLETED'},'stop');
   const timer=setTimeout(()=>{if(!res.destroyed)emit({content:'RESUME_ORIGINAL_DONE'},'stop');},20000);timer.unref();return;
  }
  const permission=body.messages.find(x=>x.role==='user'&&x.content.includes('PERMISSION_CASE_'))?.content.match(/PERMISSION_CASE_(askApprove|askDeny|review|full)/)?.[1];
  if(permission){
    if(!observations.length)return call('write_file',{path:'permission-'+permission+(permission==='full'?'.py':'.txt'),content:'permission verified'});
    if(permission==='askApprove'&&observations.length===1)return call('write_file',{path:'permission-second.txt',content:'second approved operation'});
    return emit({content:observations.at(-1).ok?'PERMISSION_DONE':'权限拒绝，文件未写入'},'stop');
  }
  if(body.messages.some(x=>x.role==='user'&&x.content.includes('UI_MCP_CASE'))){
    if(!observations.length)return call('mcp_tools',{});
    const servers=observations[0].result?.servers||[];
    const server=servers.find(x=>x.name==='UI installed MCP');
    if(!server)return emit({content:'UI_MCP_SERVER_NOT_FOUND'},'stop');
    if(observations.length===1)return call('mcp_call',{serverId:server.id,name:'e2e_ping',arguments:{message:'UI_MCP_OK'}});
    const returned=JSON.stringify(observations[1].result||{});
    return emit({content:`MCP_TOOL_RETURNED ${returned.slice(0,1000)} UI_MCP_OK`},'stop');
  }
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
let app,connection,remoteCleanup;
try{
 const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
 const packagedDir=packaged?(packagedDirArg?resolve(root,packagedDirArg):join(root,'release/product-100')):null;
 const executablePath=packaged?join(packagedDir,'Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
 const args=packaged?[]:[root];
 app=await _electron.launch({executablePath,args:[...args,'--native'],env});let shell=await app.firstWindow();await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 await shell.evaluate(async config=>window.suwen.call('configure',config),{provider:'openai',baseUrl,apiKey,model:'deepseek-v4.1-flash-economy',contextWindow:65536,maxOutput:8192});await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);app=null;
 app=await _electron.launch({executablePath,args,env});
 let page;for(let i=0;i<180;i++){page=app.windows().find(p=>p.url().startsWith('http://127.0.0.1:'));if(page)break;await new Promise(r=>setTimeout(r,500));}if(!page)throw Error('Formal window unavailable');
 page.setDefaultTimeout(45000);
 page.on('pageerror',e=>report.errors.push(e.message));await page.waitForSelector('#app-sidebar');await page.waitForSelector('html[data-ready="true"]',{timeout:60000});
 try{await page.getByRole('button',{name:'先看看',exact:true}).click({timeout:5000});}catch{}
 await page.waitForSelector('.workbench-page.unified-workspace #chat-input',{timeout:60000});
 try{await page.getByRole('button',{name:'先看看',exact:true}).click({timeout:2000});}catch{}
 check('home-is-full-unified-workbench',await page.locator('.workbench-page.unified-workspace').count()===1);
 check('home-has-one-workspace-sidebar',await page.locator('.chat-sidebar').count()===1);
 await page.locator('.modal-backdrop').waitFor({state:'detached'});
 check('formal-startup-has-only-one-window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length===1));
 check('permission-selector-matches-toolbar',await page.locator('#chat-permission-mode').evaluate(x=>getComputedStyle(x).appearance==='none'&&!!x.closest('.permission-control')));
 await page.screenshot({path:join(out,'workbench-default-light.png')});
 await page.getByRole('link',{name:'聊天',exact:true}).click();await page.waitForSelector('.view-root > .route-mount > .chat-view[data-ready="true"] #chat-input');
 await page.click('#chat-workspace');await page.getByPlaceholder('输入本机文件夹的完整路径').fill(workspace);await page.getByRole('button',{name:'使用此目录',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#chat-workspace span')?.textContent==='test-workspace');check('workspace-picker-selects-real-directory',true);
 await page.selectOption('#chat-permission-mode','full');
 check('default-light-theme',await page.evaluate(()=>document.documentElement.dataset.theme==='light'));
 check('three-permission-modes',await page.locator('#chat-permission-mode option').count()===3);
 check('project-files-visible',await page.locator('#project-file-tree').textContent().then(x=>x.includes('sample.csv')));
 check('single-sidebar-in-chat',await page.locator('.chat-sidebar').count()===1&&await page.locator('#app-sidebar').isVisible());
 check('no-brand-subtitle',await page.locator('.brand-sub').count()===0);
 check('desktop-lifecycle-preload-is-restricted',await page.evaluate(()=>!!window.suwenDesktop&&!window.suwen));
 if(process.argv.includes('--research-only')){
  const {researchAcceptance}=await import('./research-workspace-acceptance.mjs');
  await researchAcceptance({page,workspace,check,out,live});
 }else{
 const before=await page.locator('.composer').boundingBox();
 await page.fill('#chat-input',live?'读取工作目录中的 sample.csv，查找并加载 csv-analysis 技能，然后实际执行此技能汇总行数和值列的均值。必须报告均值4，末尾写 RESULT_OK，不超过200字。':'读取 sample.csv 并实际运行 csv-analysis Skill，汇报真实均值，末尾写 RESULT_OK。');await page.click('#send-btn');
 await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('RESULT_OK')&&document.querySelector('#stop-btn')?.classList.contains('is-hidden'),null,{timeout:240000});
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
 const inventory=await page.evaluate(()=>fetch('/api/skills').then(r=>r.json()));check('same-installed-skill-catalog-in-ui',inventory.skills.filter(x=>x.runtime==='desktop').length>=258);
 const capabilities=await page.evaluate(()=>fetch('/api/platform/registry/skill').then(r=>r.json()));check('capability-center-shares-catalog',capabilities.items.filter(x=>x.runtime==='desktop').length===inventory.skills.filter(x=>x.runtime==='desktop').length);
 const csv=capabilities.items.find(x=>x.name==='csv-analysis');const toggled=await page.evaluate(async id=>{await fetch('/api/platform/registry/skill/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});const disabled=await fetch('/api/skills').then(r=>r.json());await fetch('/api/platform/registry/skill/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});return disabled.skills.find(s=>s.id===id)?.enabled===false;},csv.id);check('skill-toggle-shared-with-chat',toggled);
 if(!live){
  await page.evaluate(()=>{location.hash='#/extensions';});await page.waitForSelector('.sw-page');
  await page.locator('.sw-section[data-section="skill"]').click();
  await page.locator('[data-action="new-skill"]').waitFor();
  check('skill-library-renders-one-bounded-page',await page.locator('.sw-grid > .sw-card').count()<=32);
  await page.locator('[data-action="new-skill"]').click();
  await page.fill('#skill-source','ui-installed-skill');
  await page.check('#skill-trusted');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.fill('#skill-query','ui-installed-skill');await page.click('[data-action="skill-search"]');
  const installedSkillCard=page.locator('.sw-card').filter({hasText:'ui-installed-skill'});
  await installedSkillCard.waitFor({timeout:30000});
  const installedSkill=await page.evaluate(()=>fetch('/api/skills').then(r=>r.json()).then(x=>x.skills.find(s=>s.name==='ui-installed-skill')));
  check('formal-ui-installs-discovered-skill',Boolean(installedSkill?.id)&&installedSkill.runtime==='desktop');

  await page.locator('.sw-section[data-section="mcp"]').click();
  await page.locator('[data-action="new-mcp"]').waitFor();
  await page.locator('[data-action="new-mcp"]').click();
  const capabilityDialogs=await page.locator('.modal-backdrop').evaluateAll(nodes=>nodes.map(node=>({layer:node.dataset.layer,title:node.querySelector('.modal-title')?.textContent,closing:node.classList.contains('is-closing')})));
  check('capability-dialogs-do-not-stack',capabilityDialogs.length===1,capabilityDialogs);
  await page.fill('#record-name','UI installed MCP');
  await page.fill('#record-command',process.execPath);
  await page.fill('#record-args',JSON.stringify([join(root,'scripts/fixtures/research-e2e/mcp-server.mjs')]));
  await page.getByRole('button',{name:'安装并验证',exact:true}).click();
  let installedMcpCard=page.locator('.sw-card').filter({hasText:'UI installed MCP'});
  await installedMcpCard.waitFor({timeout:30000});
  await installedMcpCard.getByRole('button',{name:'停用',exact:true}).waitFor({timeout:30000});
  await page.waitForFunction(()=>[...document.querySelectorAll('.sw-card')].some(x=>x.textContent?.includes('UI installed MCP')&&x.textContent?.includes('e2e_ping')),null,{timeout:30000});
  const installedMcp=await page.evaluate(()=>fetch('/api/platform/registry/mcp').then(r=>r.json()).then(x=>x.items.find(s=>s.name==='UI installed MCP')));
  check('formal-ui-installs-and-discovers-mcp-tool',installedMcp?.enabled===true&&installedMcp?.status?.tools?.some(x=>x.name==='e2e_ping'));
  await page.evaluate(()=>{location.hash='#/chat';});
  await page.waitForSelector('.view-root > .route-mount > .chat-view[data-ready="true"] #chat-input');
  const originalConversation=await page.locator('.conv-item.is-active').getAttribute('data-id');
  await page.click('#new-conv');await page.selectOption('#chat-permission-mode','full');
  await page.fill('#chat-input','调用 MCP 服务 UI installed MCP 的 e2e_ping，参数 message=UI_MCP_OK。UI_MCP_CASE，必须实际调用并报告返回结果，末尾写 UI_MCP_OK。');await page.click('#send-btn');
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('UI_MCP_OK')&&document.querySelector('#stop-btn')?.classList.contains('is-hidden'),null,{timeout:60000});
  const mcpState=await rpc(connection,'snapshot');
  const mcpTask=mcpState.tasks.find(t=>t.name.includes('UI_MCP_CASE'));
  const mcpNames=mcpTask?.events.filter(e=>e.type==='tool.completed').map(e=>e.data.name)||[];
  check('formal-ui-mcp-is-callable-by-unified-agent',mcpTask?.status==='completed'&&mcpNames.includes('mcp_tools')&&mcpNames.includes('mcp_call'));
  if(originalConversation)await page.locator(`.conv-item[data-id="${originalConversation}"] .conv-title`).click();
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('RESULT_OK'),null,{timeout:30000});
 }
 await page.click('#chat-drawer-toggle');check('sidebar-collapses',await page.locator('.chat-view.sidebar-collapsed').count()===1);await page.click('#chat-drawer-toggle');
 await page.reload();await page.waitForSelector('.view-root > .route-mount > .chat-view[data-ready="true"] #chat-input');await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('RESULT_OK'),null,{timeout:30000});
 check('tool-history-survives-reload',await page.locator('.tool-run').count()===1&&await page.locator('.tool-card.is-running').count()===0&&await page.locator('.tool-card').count()===names.length);
 check('permission-selection-survives-reload',await page.locator('#chat-permission-mode').inputValue()==='full');
 check('workspace-selection-survives-reload',await page.locator('#chat-workspace span').textContent()==='test-workspace');
 await page.locator('.tool-run-summary').click();await page.locator('.tool-head').first().click();check('raw-tool-preview-survives-reload',(await page.locator('.tool-card.is-open .tool-result').first().textContent()).includes('roots'));await page.locator('.tool-run-summary').click();
 check('run-details-survive-reload',await page.locator('.run-detail-link').count()>=1);
 const runId=await page.locator('.run-detail-link').first().getAttribute('data-run-id');const run=await page.evaluate(id=>fetch('/api/runs/'+encodeURIComponent(id)).then(r=>r.json()),runId);report.pythonRunStatus=run.status||run.run?.status;check('python-projection-and-harness-both-succeeded',report.pythonRunStatus==='succeeded');
 for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:join(out,`chat-${live?'live':'controlled'}-${theme}.png`)});}
 if(!live){
  for(const scenario of ['review','full','askApprove','askDeny']){
   await page.click('#new-conv');await page.selectOption('#chat-permission-mode',scenario.startsWith('ask')?'ask':scenario);
   await page.fill('#chat-input',`写入文件 PERMISSION_CASE_${scenario}，实际执行工具。`);await page.click('#send-btn');
   if(scenario.startsWith('ask')){
    await page.waitForSelector('.approval-card .approve-btn',{timeout:30000});
    check(scenario+'-shows-real-approval',true);
    await page.locator(scenario==='askApprove'?'.approval-card .approve-btn':'.approval-card .deny-btn').last().click();
    if(scenario==='askApprove'){
     await page.locator('.approval-card .approve-btn').last().waitFor({state:'visible'});await page.locator('.approval-card .approve-btn').last().click();
     check('multiple-approvals-share-one-group',await page.locator('.approval-run').count()===1);
     check('approval-events-do-not-create-toast-stacks',await page.locator('.toast').filter({hasText:'需要你的批准'}).count()===0);
     await page.screenshot({path:join(out,'approvals-integrated.png')});
    }
   }
   await page.waitForFunction(()=>document.querySelector('#stop-btn')?.classList.contains('is-hidden'),null,{timeout:60000});
   const file=join(workspace,'permission-'+scenario+(scenario==='full'?'.py':'.txt'));
   check(scenario+'-execution-enforced',scenario==='askDeny'?!existsSync(file):existsSync(file)&&readFileSync(file,'utf8')==='permission verified');
   if(!scenario.startsWith('ask'))check(scenario+'-no-approval-popup',await page.locator('.approval-card').count()===0);
   const state=await rpc(connection,'snapshot');const actual=state.tasks.find(t=>t.name.includes('PERMISSION_CASE_'+scenario));
   check(scenario+'-task-status-truthful',actual?.status===(scenario==='askDeny'?'failed':'completed'));
  }
 }
 if(!live){
  await page.click('#new-conv');await page.selectOption('#chat-permission-mode','full');
  await page.fill('#chat-input','写入文件一次，然后报告执行记录 RESUME_CASE。');await page.click('#send-btn');
  for(let i=0;i<100&&!existsSync(join(workspace,'resume-once.txt'));i++)await new Promise(r=>setTimeout(r,100));
  check('resume-original-side-effect-committed',existsSync(join(workspace,'resume-once.txt')));
  await new Promise(r=>setTimeout(r,400));
  const runId=await page.evaluate(async()=>{const data=await fetch('/api/runtime/runs?status=running').then(r=>r.json());return data.runs[0]?.run_id;});
  if(!runId)throw Error('Recovery fixture has no active run');
  await page.click('#stop-btn');await page.waitForFunction(()=>document.querySelector('#stop-btn')?.classList.contains('is-hidden'));
  let stopped;for(let i=0;i<250;i++){stopped=await page.evaluate(id=>fetch('/api/runs/'+id,{cache:'no-store'}).then(r=>r.json()),runId);if(['cancelled','interrupted','failed'].includes(stopped.status))break;await new Promise(r=>setTimeout(r,100));}
  console.log('RECOVERY_STOPPED',JSON.stringify({status:stopped.status,actions:stopped.actions}));
  if(!stopped.actions?.resume)throw Error('Stopped task did not expose a recoverable checkpoint');
  writeFileSync(join(workspace,'resume-once.txt'),'edited after interruption');
  await page.locator(`.run-detail-link[data-run-id="${runId}"]`).last().click();
  await page.getByRole('button',{name:'从检查点恢复',exact:true}).click();await page.getByRole('button',{name:'已核对，继续恢复',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('RESUME_COMPLETED'),null,{timeout:60000});
  check('resume-does-not-repeat-completed-write',readFileSync(join(workspace,'resume-once.txt'),'utf8')==='edited after interruption');
  const state=await rpc(connection,'snapshot'),resumed=state.tasks.find(t=>t.events.some(e=>e.type==='agent.resumed'));
  check('resume-trace-links-original-checkpoint',resumed?.status==='completed'&&resumed.events.some(e=>e.type==='agent.resumed'));
  check('resume-has-no-second-write-call',!resumed?.events.some(e=>e.type==='tool.started'&&e.data.name==='write_file'));
 }
 if(live&&process.argv.includes('--steering-live')){
  await page.click('#new-conv');await page.selectOption('#chat-permission-mode','full');
  await page.fill('#chat-input',`LIVE_STEER_CASE：请实际调用 run_shell，在当前工作目录执行 python -c "import time; time.sleep(8); print('BASE_TASK_OK')"，然后简短报告结果。`);await page.click('#send-btn');
  let original;for(let i=0;i<450;i++){const snapshot=await rpc(connection,'snapshot');original=snapshot.tasks.find(t=>t.name.includes('LIVE_STEER_CASE'));if(original?.events.some(e=>e.type==='tool.started'&&e.data.name==='run_shell'))break;await new Promise(r=>setTimeout(r,200));}
  if(!original?.events.some(e=>e.type==='tool.started'&&e.data.name==='run_shell'))throw Error('Live steering test did not reach shell execution');
  const originalShellHash=original.events.find(e=>e.type==='tool.started'&&e.data.name==='run_shell')?.data.argumentsSha256;
  await page.fill('#chat-input','补充需求：原命令完成后，在同一工作目录写入 live-guidance-result.txt，内容严格为 REAL_STEERING_OK；读取核对后，把同一个 live-guidance-result.txt 的内容覆盖为 REAL_GUIDANCE_COMPLETE。沿用当前任务，不要停止或重复原命令。');await page.click('#send-btn');
  await page.locator('.guidance-item').filter({hasText:'补充需求'}).waitFor();
  check('live-guidance-queued-in-existing-task',(await rpc(connection,'task.snapshot',{id:original.id})).status==='running');
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('REAL_GUIDANCE_COMPLETE')&&document.querySelector('#stop-btn')?.classList.contains('is-hidden'),null,{timeout:240000});
  const finished=await rpc(connection,'task.snapshot',{id:original.id});
  // The requested workflow intentionally overwrites the intermediate marker
  // after read-back verification. Assert the final durable value and the
  // observable read/write sequence rather than stale intermediate contents.
  const guidanceFile=existsSync(join(workspace,'live-guidance-result.txt'))?readFileSync(join(workspace,'live-guidance-result.txt'),'utf8'):'';
  const guidanceValue=guidanceFile.replace(/\r?\n$/,'');
  const guidanceWrites=finished.events.filter(e=>e.type==='tool.started'&&e.data.name==='write_file').length;
  const guidanceReads=finished.events.filter(e=>e.type==='tool.started'&&e.data.name==='read_file').length;
  check('live-guidance-actually-writes-and-verifies-new-requirement',
    guidanceValue==='REAL_GUIDANCE_COMPLETE'&&
    finished.status==='completed'&&
    guidanceWrites>=2&&guidanceReads>=1,
    {guidanceValue,status:finished.status,writeCalls:guidanceWrites,readCalls:guidanceReads});
  const guidanceCount=finished.events.filter(e=>e.type==='agent.guidance').length;
  const originalShellCalls=finished.events.filter(e=>e.type==='tool.started'&&e.data.name==='run_shell'&&e.data.argumentsSha256===originalShellHash).length;
  check('live-guidance-keeps-same-task-and-original-command-once',
    guidanceCount===1&&Boolean(originalShellHash)&&originalShellCalls===1,
    {guidanceCount,originalShellCalls,originalShellHash});
 }
 if(!live){
  await page.click('#new-conv');await page.selectOption('#chat-permission-mode','full');await page.fill('#chat-input','写入文件并分析 STEER_CASE');await page.click('#send-btn');
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('正在分析原始数据'),null,{timeout:30000});
  const original=(await rpc(connection,'snapshot')).tasks.find(t=>t.name.includes('STEER_CASE'));
  await page.fill('#chat-input','CANDIDATE_REMOVED');await page.press('#chat-input','Enter');
  let item=page.locator('.guidance-item').filter({hasText:'CANDIDATE_REMOVED'});await item.getByRole('button',{name:'修改',exact:true}).click();
  await page.locator('.modal-body textarea').fill('CANDIDATE_EDITED');await page.getByRole('button',{name:'确定',exact:true}).click();
  item=page.locator('.guidance-item').filter({hasText:'CANDIDATE_EDITED'});await item.getByRole('button',{name:'发送',exact:true}).click();
  await item.getByRole('button',{name:'撤回',exact:true}).click();await item.getByRole('button',{name:'删除',exact:true}).click();
  await item.waitFor({state:'detached'});
  check('candidate-can-edit-send-withdraw-and-delete',await page.locator('.guidance-item').count()===0);
  await page.evaluate(()=>{const node=[...document.querySelectorAll('.msg-assistant .msg-text')].find(x=>x.textContent.includes('正在分析'));const selection=window.getSelection();selection.removeAllRanges();const range=document.createRange();range.selectNodeContents(node);selection.addRange(range);});
  await page.click('#guidance-annotate');await page.fill('#guidance-feedback','ANNOTATION_FEEDBACK');await page.getByRole('button',{name:'加入候选',exact:true}).click();
  const annotated=page.locator('.guidance-item').filter({hasText:'ANNOTATION_FEEDBACK'});
  check('annotation-preserves-selected-output',(await annotated.locator('blockquote').textContent()).includes('正在分析原始数据'));
  await annotated.getByRole('button',{name:'发送',exact:true}).click();
  await page.fill('#chat-input','DIRECT_GUIDANCE');await page.click('#send-btn');await page.locator('.guidance-item').filter({hasText:'DIRECT_GUIDANCE'}).waitFor();
  check('guidance-does-not-abort-in-flight-model',steeringActive&&!steeringAborted&&(await rpc(connection,'task.snapshot',{id:original.id})).status==='running');
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('STEERING_COMPLETED')&&document.querySelector('#stop-btn')?.classList.contains('is-hidden'),null,{timeout:60000});
  const guided=readFileSync(join(workspace,'steering-guided.txt'),'utf8');
  check('guidance-applied-to-same-running-task',guided.includes('DIRECT_GUIDANCE')&&guided.includes('ANNOTATION_FEEDBACK')&&!guided.includes('CANDIDATE_EDITED')&&!steeringAborted);
  check('guidance-trace-confirms-context-delivery',(await rpc(connection,'task.snapshot',{id:original.id})).events.filter(e=>e.type==='agent.guidance').length===2);
  await page.screenshot({path:join(out,'guidance-feedback.png')});
  const second=join(profile,'parallel-workspace');mkdirSync(second);
  const added=await page.evaluate(path=>fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Parallel B',local_path:path})}).then(r=>r.json()),second);
  const originalWorkspace=await page.locator('#project-workspace').inputValue();
  const selectTaskModel=async(model,mode)=>{await page.getByRole('button',{name:'选择任务模型',exact:true}).click();await page.selectOption('#task-provider','custom_openai');await page.fill('#task-model',model);await page.selectOption('#task-permission',mode);await page.getByRole('button',{name:'保存任务配置',exact:true}).click();await page.locator('.task-selection-form').waitFor({state:'detached'});};
  await page.click('#new-conv');await selectTaskModel('acceptance-model-A','full');await page.fill('#chat-input','执行两个写入步骤 MULTI_CASE_A');await page.click('#send-btn');
  for(let i=0;i<100&&!existsSync(join(workspace,'multi-before.txt'));i++)await new Promise(r=>setTimeout(r,50));
  const a=(await rpc(connection,'snapshot')).tasks.find(t=>t.name.includes('MULTI_CASE_A'));
  const active=await page.evaluate(()=>fetch('/api/runtime/runs?status=running').then(r=>r.json()));const originalConversation=active.runs[0].session_id;
  await page.click('#project-refresh');await page.waitForSelector(`#project-workspace option[value="${added.workspace.workspace_id}"]`,{state:'attached'});
  await page.selectOption('#project-workspace',added.workspace.workspace_id);await page.waitForFunction(()=>document.querySelector('#chat-workspace span')?.textContent==='Parallel B');
  check('workspace-switch-is-enabled-during-reply',!await page.locator('#send-btn').isDisabled());
  await selectTaskModel('acceptance-model-B','review');await page.fill('#chat-input','执行两个写入步骤 MULTI_CASE_B');await page.click('#send-btn');
  for(let i=0;i<100&&!existsSync(join(second,'multi-before.txt'));i++)await new Promise(r=>setTimeout(r,50));
  let state=await rpc(connection,'snapshot');const b=state.tasks.find(t=>t.name.includes('MULTI_CASE_B'));
  check('two-workspaces-run-concurrently',state.tasks.find(t=>t.id===a.id)?.status==='running'&&b?.status==='running');
  const activeB=await page.evaluate(()=>fetch('/api/runtime/runs?status=running').then(r=>r.json()));const secondConversation=activeB.runs.find(r=>r.session_id!==originalConversation).session_id;
  await page.locator(`.conv-item[data-id="${originalConversation}"] .conv-title`).click();
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('MULTI_DONE_A'),null,{timeout:60000});
  for(let i=0;i<100;i++){state=await rpc(connection,'snapshot');if([a.id,b.id].every(id=>state.tasks.find(t=>t.id===id)?.status==='completed'))break;await new Promise(r=>setTimeout(r,100));}
  check('both-background-tasks-finish', [a.id,b.id].every(id=>state.tasks.find(t=>t.id===id)?.status==='completed'));
  check('concurrent-tools-stay-in-original-workspaces',readFileSync(join(workspace,'multi-after.txt'),'utf8')==='A'&&readFileSync(join(second,'multi-after.txt'),'utf8')==='B');
  check('concurrent-model-requests-keep-independent-selection',parallelModels.A?.every(m=>m==='acceptance-model-A')&&parallelModels.B?.every(m=>m==='acceptance-model-B'));
  check('original-conversation-restores-own-model-and-permission',(await page.locator('#chat-model-chip').textContent()).includes('acceptance-model-A')&&await page.locator('#chat-permission-mode').inputValue()==='full');
  check('switch-back-shows-original-stream-only',!(await page.locator('#messages').textContent()).includes('MULTI_DONE_B'));
  await page.locator(`.conv-item[data-id="${secondConversation}"] .conv-title`).click();await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('MULTI_DONE_B'));
  check('second-conversation-restores-own-result',!(await page.locator('#messages').textContent()).includes('MULTI_DONE_A'));
  check('second-conversation-restores-own-model-and-permission',(await page.locator('#chat-model-chip').textContent()).includes('acceptance-model-B')&&await page.locator('#chat-permission-mode').inputValue()==='review');
  await page.selectOption('#project-workspace',originalWorkspace);await page.waitForFunction(()=>document.querySelector('#chat-workspace span')?.textContent==='test-workspace');
 }
 const sshPath=process.argv.find(x=>x.startsWith('--ssh-credentials='))?.slice(18);
 if(sshPath){
  const privateConfig=JSON.parse(readFileSync(sshPath,'utf8'));
  const api=async(path,body)=>page.evaluate(async({path,body})=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error('Acceptance API '+r.status);return value;},{path,body});
  const added=await api('/api/ssh/profiles',{name:'Acceptance SSH',auth:'password',...privateConfig});
  const id=added.profile.id,dir='.suwen-ui-'+crypto.randomUUID().replaceAll('-','');
  if(!/^\.suwen-ui-[a-f0-9]{32}$/.test(dir))throw Error('Invalid acceptance directory');
  const setup=await api('/api/ssh/exec',{profile_id:id,command:`mkdir -m 700 ${dir} && printf 'value\\n3\\n6\\n9\\n' > ${dir}/sample.csv`});
  if(setup.status!=='ok')throw Error('Remote fixture setup failed');
  remoteCleanup=()=>api('/api/ssh/exec',{profile_id:id,command:`python3 -c "import pathlib,shutil; p=pathlib.Path.home()/'${dir}'; assert p.name=='${dir}' and p.parent==pathlib.Path.home(); shutil.rmtree(p)"`});
  const addedWorkspace=await api('/api/workspaces',{name:'SSH acceptance',backend:'ssh',remote:{profile_id:id,root:'~/'+dir}});
  await page.click('#project-refresh');await page.waitForSelector(`#project-workspace option[value="${addedWorkspace.workspace.workspace_id}"]`,{state:'attached'});
  await page.selectOption('#project-workspace',addedWorkspace.workspace.workspace_id);
  await page.waitForFunction(()=>document.querySelector('#chat-workspace span')?.textContent==='SSH acceptance');
  await page.selectOption('#chat-permission-mode','full');
  await page.fill('#chat-input','读取远程 sample.csv 并实际运行 csv-analysis Skill，报告实际均值，末尾写 RESULT_OK。');await page.click('#send-btn');
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('RESULT_OK')&&document.querySelector('#stop-btn')?.classList.contains('is-hidden'),null,{timeout:240000});
  check('SSH-workspace-selected-in-UI',await page.locator('#project-workspace').inputValue()===addedWorkspace.workspace.workspace_id);
  check('SSH-actual-mean-differs-from-local-twin',(await page.locator('#messages').textContent()).includes('6'));
  const snapshot=await rpc(connection,'snapshot'),task=snapshot.tasks.find(t=>t.name.includes('远程 sample.csv'));
  const artifact=task.events.find(e=>e.type==='agent.tool_artifact'&&e.data.name==='read_file');
  const raw=await rpc(connection,'artifact.read',{taskId:task.id,artifactId:artifact.data.artifact.id});
  const data=JSON.parse(raw.text);check('SSH-tool-target-is-remote',data.observation.result.execution_target.kind==='ssh');
  const skillEvent=task.events.find(e=>e.type==='agent.tool_artifact'&&e.data.name==='skill_run');
  const rawSkill=await rpc(connection,'artifact.read',{taskId:task.id,artifactId:skillEvent.data.artifact.id});
  const actual=JSON.parse(rawSkill.text).observation.result.result;
  check('SSH-skill-executes-on-selected-host',actual.executionEnvironment==='ssh'&&JSON.parse(actual.stdout).numericSummary.value.mean===6);
  check('SSH-local-twin-untouched',readFileSync(join(workspace,'sample.csv'),'utf8')==='value\n2\n4\n6\n');
  await page.screenshot({path:join(out,'ssh-ui-'+(live?'live':'controlled')+'.png')});
 }
 const history=await page.evaluate(()=>fetch('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Long history acceptance'})}).then(r=>r.json()));
 history.messages=Array.from({length:1000},(_,i)=>({id:'history_'+i,role:i%2?'assistant':'user',content:'History message '+i+' '+('content '.repeat(30)),ts:Date.now()/1000}));
 writeFileSync(join(profile,'runtime/legacy/conversations',history.id+'.json'),JSON.stringify(history));
 await page.evaluate(async id=>{const source=document.querySelector('script[type="module"]').src;const {setPref}=await import(new URL('util.js?v=2.1.1',source));setPref('activeConversationId',id);location.hash='#/chat';},history.id);await page.reload();
 await page.waitForFunction(()=>document.querySelector('#messages')?.textContent?.includes('History message 999'),null,{timeout:30000});
 check('1000-message-history-renders-at-most-80',await page.locator('#messages > .msg').count()<=80);
 await page.getByRole('button',{name:/查看更早消息/}).click();
 check('older-history-is-accessible',(await page.locator('#messages').textContent()).includes('History message 860'));
 }
 check('no-renderer-errors',report.errors.length===0);
}catch(e){report.error=String(e.message).split(apiKey).join('[redacted]');console.log(report.error);}
finally{
 try{if(remoteCleanup)await remoteCleanup();}catch(error){report.cleanupError='Remote temporary directory cleanup failed: '+error.message;}
 try{connection??=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));}catch{}
 try{if(connection)await rpc(connection,'shutdown');}catch{}
 if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});if(server){server.closeAllConnections();server.close();}
 writeFileSync(join(out,`${process.argv.includes('--research-only')?process.argv.includes('--research-full')?'research-full':'research':'product'}-ui-${live?'live':'controlled'}${process.argv.some(x=>x.startsWith('--ssh-credentials='))?'-ssh':''}${packaged?'-packaged':''}.json`),JSON.stringify(report,null,2).split(apiKey).join('[redacted]'));
 process.exit(report.error||report.checks.some(x=>!x.ok)?1:0);
}
