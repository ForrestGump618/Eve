/** Controlled model decisions; real formal Electron, tools, Node, browser, files and viewer. */
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core');
const {SkillLibrary}=await import('../dist/src/skill-library.js');
const {rpc}=await import('../dist/src/rpc.js');
const library=new SkillLibrary(join(root,'skill-library'));
const skill=library.skills.find(s=>s.name==='archify');
const candidate=JSON.parse(library.read(skill.id,'examples/agent-tool-call.workflow.json'));
candidate.meta.output='.archify/ui-workflow/index.html';
const profile=mkdtempSync(join(tmpdir(),'eve-archify-ui-'));
const output=join(root,'release','archify-acceptance');mkdirSync(output,{recursive:true});
const env={...process.env,SUWEN_TEST_HOME:profile,SUWEN_WORKBENCH_DEPS:join(process.env.APPDATA,'Eve/python-env')};
delete env.ELECTRON_RUN_AS_NODE;
const installed=process.argv.includes('--installed');
const executablePath=installed?join(process.env.LOCALAPPDATA,'Programs/Eve/Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const launchArgs=installed?[]:[root];
const report={checks:[],errors:[],profile,installed,kind:'controlled model protocol; real formal Electron, skill execution, browser validation and artifact preview; no paid-model quality claim'};
const check=(name,condition)=>{report.checks.push({name,passed:Boolean(condition)});if(!condition)throw Error(name);console.log('PASS',name);};
let app,connection,server;
try{
  server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const {messages}=JSON.parse(raw),observations=messages.filter(m=>m.role==='tool');
      const last=observations.length?JSON.parse(observations.at(-1).content):null;
      const first=observations.length?JSON.parse(observations[0].content):null;
      const id=first?.result?.skills?.find(s=>s.name==='archify')?.id;
      const plan=[
        ['skill_search',{query:'archify'}],
        ['skill_load',{id}],
        ['skill_read_resource',{id,path:'references/delivery-contract.md'}],
        ['skill_prepare',{id}],
        ['write_file',{path:'archify-ui-candidate.json',content:JSON.stringify(candidate)}],
        ['skill_run',{id,input:{command:'finalize',type:'workflow',candidate:'archify-ui-candidate.json',
          output:'.archify/ui-workflow/index.html',outDir:'.archify/ui-workflow/review',quality:'showcase'}}],
      ];
      res.writeHead(200,{'content-type':'text/event-stream'});
      const next=plan[observations.length];
      const link=last?.result?.artifact?.link;
      const data=last?.ok===false?{content:'EVE_ARCHIFY_TOOL_FAILED '+JSON.stringify(last)}:next?{
        tool_calls:[{index:0,id:'archify-'+observations.length,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}],
      }:{content:link?`EVE_ARCHIFY_OK：已生成并通过原生校验。\n\n[工具调用流程](${link})`:'EVE_ARCHIFY_MISSING_ARTIFACT '+JSON.stringify(last)};
      res.end('data: '+JSON.stringify({choices:[{delta:data,finish_reason:next&&last?.ok!==false?'tool_calls':'stop'}],
        usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220}})+'\n\ndata: [DONE]\n\n');
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  app=await _electron.launch({executablePath,args:[...launchArgs,'--native','--background'],env,timeout:60000});
  const shell=await app.firstWindow();
  await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
  await shell.evaluate(baseUrl=>window.suwen.call('configure',{provider:'openai',baseUrl,apiKey:'fixture-only',
    model:'controlled-archify-protocol',contextWindow:65536,maxOutput:8192}),baseUrl);
  await app.evaluate(({app})=>app.exit(0));app=null;
  app=await _electron.launch({executablePath,args:launchArgs,env,timeout:60000});
  let page;
  for(let n=0;n<240;n++){
    page=app.windows().find(p=>/^http:/.test(p.url()));if(page)break;
    await new Promise(r=>setTimeout(r,500));
  }
  if(!page)throw Error('Formal workbench did not open');
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.waitForSelector('#chat-input',{timeout:60000});
  const welcome=page.getByRole('button',{name:'先看看',exact:true});
  await welcome.waitFor({state:'visible',timeout:10000}).catch(e=>{if(e.name!=='TimeoutError')throw e;});
  if(await welcome.isVisible()){await welcome.click();await welcome.waitFor({state:'detached'});}
  await page.evaluate(async()=>{(await import('/js/store.js?v=2.1.1')).navigate('skills');});
  await page.waitForSelector('#skills-filter');
  await page.locator('#skills-filter').fill('archify');
  await page.locator('.skill-card').filter({hasText:'archify'}).click();
  await page.waitForFunction(()=>document.querySelector('#skill-detail')?.textContent.includes('Node'));
  check('catalogue shows Node and browser requirements',(await page.locator('#skill-detail').textContent()).includes('bin/archify.mjs'));
  await page.locator('#skill-use').click();
  await page.waitForSelector('#chat-input');
  await page.locator('#chat-permission-mode').evaluate(node=>{node.value='full';node.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.locator('#chat-input').fill('使用 Archify 按内置示例生成工具调用流程图，实际运行 finalize，保留校验回执，返回可打开的交互页面卡片。');
  await page.locator('#send-btn').click();
  await page.waitForFunction(()=>/EVE_ARCHIFY_(OK|TOOL_FAILED|MISSING)/.test(document.querySelector('#messages')?.textContent||''),undefined,{timeout:180000});
  check('real UI to tools to finalize to artifact card',(await page.locator('#messages').textContent()).includes('EVE_ARCHIFY_OK'));
  await page.locator('.artifact-card').last().click();
  await page.waitForSelector('iframe.artifact-frame');
  const frame=page.frameLocator('iframe.artifact-frame');
  await frame.locator('svg').first().waitFor({timeout:20000});
  check('native SVG rendered in isolated viewer',await frame.locator('svg').count()>0);
  const buttons=await frame.locator('button').count();
  check('native interactive controls preserved',buttons>2);
  const before=await frame.locator('html').getAttribute('data-theme');
  check('preview initially follows application theme',before===await page.locator('html').getAttribute('data-theme'));
  await page.screenshot({path:join(output,installed?'preview-installed.png':'preview.png'),fullPage:true});
  const themeButton=frame.locator('button[aria-label*="theme"],button[title*="theme"],button[aria-label*="主题"],button[title*="主题"]');
  if(await themeButton.count()){
    await themeButton.first().click();
    report.themeAfter=await frame.locator('html').getAttribute('data-theme');
    check('theme control responds',before!==report.themeAfter);
  }else{
    const interactive=frame.locator('button').filter({visible:true});
    await interactive.first().click();
    check('native control accepts input',true);
  }
  check('preview excludes same-origin privileges',(await page.locator('iframe.artifact-frame').getAttribute('sandbox'))==='allow-scripts allow-downloads');
  await page.locator('.modal-foot').getByRole('button',{name:'关闭',exact:true}).click();
  await page.waitForSelector('iframe.artifact-frame',{state:'detached'});
  await page.reload();await page.waitForSelector('.artifact-card',{timeout:30000});
  check('artifact link survives conversation reload',await page.locator('.artifact-card').count()>0);
  const explainer=readFileSync(join(output,'runtime-final/.archify/explainer/index.html'),'utf8');
  await page.evaluate(async content=>{
    const store=await import('/js/store.js?v=2.1.1');
    const workspaceId=store.getState().workspaceId;
    const response=await fetch(`/api/workspaces/${workspaceId}/files/write`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({path:'verified-explainer.html',content})});
    if(!response.ok)throw Error('explainer fixture write failed');
    const {openHtmlArtifact}=await import('/js/artifact-viewer.js?v=1.0.0');
    await openHtmlArtifact(workspaceId,'verified-explainer.html','单页说明');
  },explainer);
  await page.frameLocator('iframe.artifact-frame').getByText('缓存未命中时，请求为什么变慢？',{exact:true}).first().waitFor();
  check('verified explainer survives isolated DOM serialization',true);
  const explainerFrame=page.frameLocator('iframe.artifact-frame');
  await explainerFrame.locator('[data-theme-choice="dark"]').click();
  check('explainer reader controls run',await explainerFrame.locator('html').getAttribute('data-theme')==='dark');
  await page.locator('.modal-foot').getByRole('button',{name:'关闭',exact:true}).click();
  await page.waitForSelector('iframe.artifact-frame',{state:'detached'});
  // Exercise the exact production viewer with a hostile workspace HTML file.
  const security=await page.evaluate(async()=>{
    const conversations=await fetch('/api/conversations').then(r=>r.json());
    const ws=(await fetch('/api/conversations/'+conversations.conversations[0].id).then(r=>r.json())).conversation?.meta?.workspace_id;
    const store=await import('/js/store.js?v=2.1.1');
    const workspaceId=ws||store.getState().workspaceId;
    const html='<html><body><p id="result">starting</p><iframe id="frozen-child" sandbox="allow-scripts" srcdoc="<p>Frozen nested diagram</p>"></iframe><script>let blocked=false;try{parent.document.body.dataset.compromised="yes"}catch{blocked=true}document.getElementById("result").textContent=blocked?"parent-blocked":"parent-allowed";fetch("/api/workspaces").then(()=>document.body.dataset.network="allowed",()=>document.body.dataset.network="blocked");<\/script></body></html>';
    const response=await fetch(`/api/workspaces/${workspaceId}/files/write`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:'security-preview.html',content:html})});
    if(!response.ok)throw Error('security fixture write failed');
    const {openHtmlArtifact}=await import('/js/artifact-viewer.js?v=1.0.0');
    await openHtmlArtifact(workspaceId,'security-preview.html','隔离检查');
    return {workspaceId};
  });
  report.security=security;
  await page.frameLocator('iframe.artifact-frame').locator('#result').waitFor();
  check('artifact cannot access parent DOM',(await page.frameLocator('iframe.artifact-frame').locator('#result').textContent())==='parent-blocked');
  await page.frameLocator('iframe.artifact-frame').locator('body[data-network="blocked"]').waitFor();
  check('artifact network calls blocked',true);
  await page.frameLocator('iframe.artifact-frame').frameLocator('#frozen-child').getByText('Frozen nested diagram').waitFor();
  check('frozen nested srcdoc remains available for explainers',true);
  const hostileFrame=page.frames().find(f=>f.url()==='about:srcdoc');
  await hostileFrame.evaluate(()=>{location.href='/api/workspaces';});
  await page.waitForTimeout(400);
  check('artifact self-navigation cannot reach authenticated API',hostileFrame.url()==='about:srcdoc');
  check('host unaffected',await page.evaluate(()=>!document.body.dataset.compromised));
  check('one formal window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.isVisible()).length)===1);
  check('no renderer exceptions',report.errors.length===0);
}catch(error){report.error=error.message;throw error;}finally{
  writeFileSync(join(output,installed?'ui-report-installed.json':'ui-report.json'),JSON.stringify(report,null,2));
  try{connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));}catch{}
  if(connection)await rpc(connection,'shutdown').catch(()=>{});
  if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
  server?.closeAllConnections();server?.close();
}
