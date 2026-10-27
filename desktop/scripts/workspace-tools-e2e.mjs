/** Real formal Electron UI + PTY + persistence + teams. --credentials opts into paid model acceptance. */
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core'),{rpc}=await import('../dist/src/rpc.js');
const args=process.argv,credentials=args.find(x=>x.startsWith('--credentials='))?.slice(14),packaged=args.includes('--packaged');
const profile=mkdtempSync(join(tmpdir(),'eve-workspace-tools-')),out=resolve(root,'release/workspace-tools',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(out,{recursive:true});
const env={...process.env,SUWEN_TEST_HOME:profile,SUWEN_WORKBENCH_DEPS:join(process.env.APPDATA,'Eve/python-env')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=packaged?join(root,'release/win-unpacked/Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const launchArgs=packaged?[]:[root],report={kind:credentials?'real model, real Electron/PowerShell, isolated profile':'controlled SSE model, real Electron/PowerShell/persistence; not live model acceptance',checks:[],errors:[],profile,packaged};
const check=(name,ok,detail)=>{report.checks.push({name,ok:Boolean(ok),detail});console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw new Error(name);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let app,page,connection,server,apiKey='fixture-only',baseUrl,model='deepseek-v4.1-flash-economy';
async function request(path,method='GET',body){
 return page.evaluate(async({path,method,body})=>{
  const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));return result;
 },{path,method,body});
}
async function select(selector,value){await page.locator(selector).evaluate((node,value)=>{node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function waitFor(predicate,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await delay(250);}throw new Error('Condition timed out');}
try{
 if(credentials){
  const lines=readFileSync(credentials,'utf8').trim().split(/\r?\n/).filter(Boolean);baseUrl=lines.find(x=>x.startsWith('https:'));apiKey=lines.find(x=>!x.startsWith('https:'));
 }else{
  server=createServer(async(req,res)=>{
   let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),last=body.messages.filter(m=>m.role==='user').at(-1)?.content||'';
   const content=last.includes('EVE_REVIEW_138')?'EVE_REVIEW_138':last.includes('EVE_SUM_137')?'EVE_SUM_137':'EVE_HELLO_OK';
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.write('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');
   res.end('data: [DONE]\n\n');
  });server.listen(0,'127.0.0.1');await once(server,'listening');baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 }
 app=await _electron.launch({executablePath,args:[...launchArgs,'--native','--background'],env,timeout:60000});
 const shell=await app.firstWindow();await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 await shell.evaluate(async config=>window.suwen.call('configure',config),{provider:'openai',baseUrl,apiKey,model,contextWindow:65536,maxOutput:2048});
 await app.close();app=null;
 app=await _electron.launch({executablePath,args:launchArgs,env,timeout:60000});
 await waitFor(async()=>{page=app.windows().find(p=>/^http:/.test(p.url()));return Boolean(page);},180000);
 page.on('pageerror',error=>report.errors.push(error.message));
 await page.waitForSelector('#chat-input',{timeout:60000});
 const dismiss=page.getByRole('button',{name:'先看看',exact:true});if(await dismiss.isVisible().catch(()=>false))await dismiss.click();
 // A first-run provider/model notice can be rendered after the formal page;
 // close it before exercising the composer so overlays never mask controls.
 for(const label of ['关闭','稍后','跳过']){const button=page.getByRole('button',{name:label,exact:true}).last();if(await button.isVisible().catch(()=>false))await button.click().catch(()=>{});}
 connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));
 check('one-formal-window',(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.isVisible()).length))===1);
 check('concise-empty-copy',await page.locator('.chat-empty-hint,.chat-empty-tip').count()===0);
 // Send a real turn through the single durable desktop harness.
 await page.locator('#chat-input').fill('仅回复 EVE_HELLO_OK');await page.locator('#send-btn').click();
 await waitFor(async()=>{const data=await request('/api/conversations');const c=data.conversations[0];if(!c)return false;const conv=await request('/api/conversations/'+c.id);return conv.messages?.some(m=>m.role==='assistant'&&m.content.includes('EVE_HELLO_OK'));},120000);
 await page.waitForFunction(()=>document.querySelector('#send-btn')?.disabled===false);
 const conversations=await request('/api/conversations'),cid=conversations.conversations[0].id;
 const box=await page.locator('.msg-user .msg-bubble').last().boundingBox();
 check('compact-single-line-bubble',box&&box.height<=44,{height:box?.height});
 await page.locator(`.conv-item[data-id="${cid}"] .conv-pin`).click({force:true});
 await waitFor(async()=>Boolean((await request('/api/conversations')).conversations.find(c=>c.id===cid)?.pinned));
 await page.locator(`.conv-item[data-id="${cid}"] .conv-archive`).click({force:true});
 await waitFor(async()=>Boolean((await request('/api/conversations')).conversations.find(c=>c.id===cid)?.archived));
 check('archived-hidden-in-recent',await page.locator(`.conv-item[data-id="${cid}"]`).count()===0);
 await select('#conv-view','archived');await page.waitForSelector(`.conv-item[data-id="${cid}"]`);
 await page.reload();await page.waitForSelector(`.conv-item[data-id="${cid}"]`,{timeout:30000});
 check('archive-survives-reload',true);
 await page.locator(`.conv-item[data-id="${cid}"] .conv-archive`).click({force:true});await select('#conv-view','recent');
 await page.waitForSelector(`.conv-item[data-id="${cid}"]`);
 check('restore-preserves-history',(await request('/api/conversations/'+cid)).messages.length>=2);
 // Real PTY from the renderer: no simulated process or command endpoint.
 await page.waitForSelector('.eve-terminal-screen .xterm',{timeout:20000});
 const terminalColors=()=>page.evaluate(()=>({
  panel:getComputedStyle(document.querySelector('.eve-terminal-panel')).backgroundColor,
  viewport:getComputedStyle(document.querySelector('.eve-terminal-screen .xterm-viewport')).backgroundColor,
  theme:document.documentElement.dataset.theme,
 }));
 const lightColors=await terminalColors();
 check('terminal-matches-light-interface',lightColors.theme==='light'&&lightColors.panel===lightColors.viewport,lightColors);
 await page.locator('#theme-toggle').click();
 await waitFor(async()=>{const colors=await terminalColors();return colors.theme==='dark'&&colors.panel===colors.viewport;},5000);
 check('terminal-follows-dark-theme',true);
 await page.locator('#theme-toggle').click();
 await waitFor(async()=>{const colors=await terminalColors();return colors.theme==='light'&&colors.panel===colors.viewport;},5000);
 check('terminal-returns-to-light-theme',true);
 await waitFor(async()=>/PowerShell.*PTY/.test(await page.locator('.terminal-status').innerText()),20000);
 await page.locator('.xterm-helper-textarea').focus();
 await page.keyboard.type("Write-Output ('EVE_UI_' + 'TERMINAL_OK')");
 await page.keyboard.press('Enter');
 await waitFor(async()=>String(await page.locator('.xterm-accessibility-tree').innerText()).includes('EVE_UI_TERMINAL_OK'),20000);
 check('powershell-pty-rendered-output',true);
 await page.keyboard.type("$eveUiPersist=137; Write-Output ('PERSIST_' + $eveUiPersist)");
 await page.keyboard.press('Enter');
 await waitFor(async()=>String(await page.locator('.xterm-accessibility-tree').innerText()).includes('PERSIST_137'),15000);
 const terminal=await page.evaluate(()=>new Promise(resolve=>{
  const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/ws/terminal?workspace_id=ws_main');
  let text='',ready=null;const timeout=setTimeout(()=>{ws.close();resolve({ready,text,error:'timeout'});},15000);
  ws.onmessage=event=>{const frame=JSON.parse(event.data);if(frame.type==='ready'){ready=frame;ws.send(JSON.stringify({type:'input',data:"$evePersist=137; Write-Output ('SESSION_'+$evePersist)\r"}));}
   if(frame.type==='output'){text+=frame.data;if(frame.data.includes('\x1b[6n'))ws.send(JSON.stringify({type:'input',data:'\x1b[1;1R'}));if(text.includes('SESSION_137')){clearTimeout(timeout);ws.close();resolve({ready,matched:true});}}
  };ws.onerror=()=>{clearTimeout(timeout);resolve({error:'websocket failure'});};
 }));
 check('websocket-auth-and-real-powershell',terminal.ready?.pty&&terminal.matched);
 // Context inspection comes from the same harness task; force a summary, then recall a checked source.
 await page.evaluate(()=>{location.hash='#/context';});await page.waitForSelector('#context-conversation');
 await select('#context-conversation',cid);await page.waitForSelector('[data-context-action="compact"]');
 await page.locator('[data-context-action="compact"]').click();
 await page.waitForSelector('.context-snapshot:has([data-context-action="restore"])',{timeout:20000});
 await page.locator('.context-snapshot:has([data-context-action="restore"]) summary').first().click();
 await page.locator('[data-context-source]').first().click();
 await page.waitForSelector('.context-original');
 check('context-compaction-and-source-recall',(await page.locator('.context-original').innerText()).includes('EVE_HELLO_OK'));
 await page.getByRole('button',{name:'关闭',exact:true}).last().click();
 await page.locator('#context-query').fill('EVE_HELLO_OK');await page.locator('#context-search button').click();
 await page.waitForSelector('#context-matches .context-snapshot');check('search-original-context',true);
 await page.screenshot({path:join(out,'context-dashboard.png')});
 await page.locator('[data-context-request]').first().click();await page.waitForSelector('.context-request-browser');
 check('actual-model-request-browser',await page.locator('.context-request-browser').innerText().then(x=>x.includes('system')));
 await page.getByRole('button',{name:'关闭',exact:true}).last().click();
 await page.locator('#context-overview-toggle').click();await page.waitForSelector('#insights-query');
 check('cross-session-context-insights',await page.locator('#context-overview').innerText().then(x=>x.includes('EVE_HELLO_OK')||x.includes('Token')));
 await page.evaluate(()=>{location.hash='#/workbench';});await page.waitForSelector('.xterm-helper-textarea');
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type("Write-Output ('RETAINED_' + $eveUiPersist)");await page.keyboard.press('Enter');
 await waitFor(async()=>String(await page.locator('.xterm-accessibility-tree').innerText()).includes('RETAINED_137'),15000);
 check('terminal-survives-route-switch-with-state',true);
 await page.locator('[data-terminal-new]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-terminal-id]').length===2);
 check('multiple-workspace-terminal-tabs',true);
 // Team UI: independent model sessions, dependency handoff, trace links.
 await page.evaluate(()=>{location.hash='#/teams';});await page.waitForSelector('#team-create');
 await page.locator('#team-create').click();await page.waitForSelector('[data-member="member1"]');
 await page.locator('[data-member="member1"] [name="goal"]').fill('只回复 EVE_SUM_137');
 await page.locator('[data-member="member2"] [name="goal"]').fill('根据前置结果，只回复 EVE_REVIEW_138');
 await page.locator('[data-member="member2"] [name="dependencies"]').fill('member1');
 await page.getByRole('button',{name:'保存方案',exact:true}).click();
 await page.waitForSelector('[data-team-action="approve"]');
 check('team-plan-does-not-execute-before-approval',(await request('/api/teams')).items[0]?.status==='draft');
 await page.locator('[data-team-action="approve"]').click();
 await waitFor(async()=>{const result=await request('/api/teams');return result.items[0]?.status==='succeeded';},180000);
 await page.locator('#teams-refresh').click();await page.waitForSelector('.team-card');
 const team=(await request('/api/teams')).items[0],members=team.members;
 check('team-two-members-verified',members.every(m=>m.task.status==='succeeded'),members.map(m=>m.task.status));
 const a=members[0].task.nodes.work,b=members[1].task.nodes.work;
 check('team-independent-sessions',a.session_id!==b.session_id);
 if(!credentials)check('team-member-results',a.result?.includes('EVE_SUM_137')&&b.result?.includes('EVE_REVIEW_138'));
 const transcript=await request('/api/conversations/'+b.session_id);
 check('team-dependency-evidence-delivered',transcript.messages.some(m=>m.role==='user'&&m.content.includes('EVE_SUM_137')));
 check('team-trace-ui',await page.locator('[data-run]').count()===2);
 await page.screenshot({path:join(out,'team-board.png')});
 check('no-renderer-errors',report.errors.length===0,report.errors);
 report.success=true;
}catch(error){report.error=String(error.message).split(apiKey).join('[redacted]');console.error(report.error);}
finally{
 try{connection??=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));await rpc(connection,'shutdown');}catch{}
 if(app)await Promise.race([app.close(),delay(5000)]);
 if(server){server.closeAllConnections();server.close();}
 report.at=new Date().toISOString();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2).split(apiKey).join('[redacted]'));
 console.log(out);process.exit(report.success?0:1);
}
