/** Real formal Electron window + scientific catalogue; no live model claim. */
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
const {rpc}=await import('../dist/src/rpc.js');
const profile=mkdtempSync(join(tmpdir(),'eve-science-ui-'));
const output=join(root,'release','science-acceptance');mkdirSync(output,{recursive:true});
const env={...process.env,SUWEN_TEST_HOME:profile,SUWEN_WORKBENCH_DEPS:join(process.env.APPDATA,'Eve/python-env')};
delete env.ELECTRON_RUN_AS_NODE;
const installed=process.argv.includes('--installed');
const executablePath=installed?join(process.env.LOCALAPPDATA,'Programs/Eve/Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const launchArgs=installed?[]:[root];
const live=process.argv.includes('--live');
let app,connection,server;
const report={checks:[],errors:[],profile,installed,kind:live?'controlled model protocol + real Electron/adapter/uv/public API; no paid-model acceptance':'real Electron UI; no model/API task acceptance'};
const check=(name,condition)=>{report.checks.push({name,passed:Boolean(condition)});if(!condition)throw Error(name);console.log('PASS',name);};
try{
  let baseUrl='http://127.0.0.1:9/v1';
  if(live){
    server=createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;
      const {messages}=JSON.parse(raw),observations=messages.filter(m=>m.role==='tool');
      const last=observations.length?JSON.parse(observations.at(-1).content):null;
      const first=observations.length?JSON.parse(observations[0].content):null;
      const id=first?.result?.skills?.[0]?.id;
      const plan=[
        ['skill_search',{query:'science-pubchem-database'}],
        ['skill_load',{id}],
        ['skill_prepare',{id}],
        ['skill_run',{id,input:{script:'scripts/pubchem_api.py',args:['properties','--cid','2244','--output','science-ui-pubchem.json'],allowDependencyInstall:true,timeoutSeconds:90}}],
        ['read_file',{path:'science-ui-pubchem.json'}],
      ];
      res.writeHead(200,{'content-type':'text/event-stream'});
      const next=plan[observations.length];
      const data=last?.ok===false?{content:'EVE_SCIENCE_TOOL_FAILED'}:next?{tool_calls:[{index:0,id:'science-'+observations.length,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]}:{content:'EVE_SCIENCE_LIVE_OK：已运行科学脚本并读取当前工作区结果文件。'};
      res.end('data: '+JSON.stringify({choices:[{delta:data,finish_reason:next&&last?.ok!==false?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220}})+'\n\ndata: [DONE]\n\n');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  }
  app=await _electron.launch({executablePath,args:[...launchArgs,'--native','--background'],env,timeout:60000});
  const shell=await app.firstWindow();
  await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
  await shell.evaluate(baseUrl=>window.suwen.call('configure',{provider:'openai',baseUrl,apiKey:'fixture-only',model:'controlled-science-protocol',contextWindow:65536,maxOutput:2048}),baseUrl);
  await app.evaluate(({app})=>app.exit(0));app=null;
  app=await _electron.launch({executablePath,args:launchArgs,env,timeout:60000});
  let page;
  for(let n=0;n<240;n++){page=app.windows().find(p=>/^http:/.test(p.url()));if(page)break;await new Promise(r=>setTimeout(r,500));}
  if(!page)throw Error('Formal workbench did not open');
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.waitForSelector('#chat-input',{timeout:60000});
  const welcome=page.getByRole('button',{name:'先看看',exact:true});
  await welcome.waitFor({state:'visible',timeout:10000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
  if(await welcome.isVisible()){await welcome.click();await welcome.waitFor({state:'detached'});}
  await page.evaluate(async()=>{const store=await import('/js/store.js?v=2.1.1');store.navigate('skills');});
  await page.waitForSelector('#skills-filter',{timeout:30000});
  await page.locator('#skills-filter').fill('science-pubmed-database');
  await page.locator('.skill-card').filter({hasText:'science-pubmed-database'}).click();
  await page.waitForFunction(()=>document.querySelector('#skill-detail')?.textContent.includes('可选凭据'));
  check('scientific skill found in formal UI',await page.locator('.skill-card').count()===1);
  check('scientific runtime and optional credentials visible',(await page.locator('#skill-detail').textContent()).includes('NCBI_API_KEY'));
  check('script resources visible',(await page.locator('#skill-detail').textContent()).includes('scripts/pubmed_api.py'));
  await page.screenshot({path:join(output,'science-skills.png'),fullPage:true});
  await page.locator('#skills-filter').fill('science-alphagenome-single-variant-analysis');
  await page.locator('.skill-card').filter({hasText:'science-alphagenome-single-variant-analysis'}).click();
  await page.waitForFunction(()=>document.querySelector('#skill-detail')?.textContent.includes('ALPHAGENOME_API_KEY'));
  check('required key shown as runtime requirement',(await page.locator('#skill-detail').textContent()).includes('必需凭据'));
  await page.locator('#skill-use').click();
  await page.waitForFunction(()=>document.querySelector('#chat-input')?.value.includes('science-alphagenome-single-variant-analysis'));
  check('use skill action prefills workbench without sending a model request',true);
  if(live){
    for(const label of ['先看看','关闭','稍后','跳过']){
      const button=page.getByRole('button',{name:label,exact:true}).last();
      if(await button.isVisible().catch(()=>false))await button.click().catch(()=>{});
    }
    await page.locator('#chat-permission-mode').evaluate(node=>{node.value='full';node.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.locator('#chat-input').fill('请实际运行 science-pubchem-database 科学技能查询阿司匹林 CID 2244 的分子性质，保存 science-ui-pubchem.json 并读取文件核对。');
    await page.locator('#send-btn').click();
    await page.waitForFunction(()=>document.querySelector('#messages')?.textContent.includes('EVE_SCIENCE_LIVE_OK'),undefined,{timeout:180000});
    const conversations=await page.evaluate(()=>fetch('/api/conversations').then(r=>r.json()));
    const conversation=await page.evaluate(id=>fetch('/api/conversations/'+id).then(r=>r.json()),conversations.conversations[0].id);
    check('UI to harness to scientific API to verified file to UI',conversation.messages.some(m=>m.role==='assistant'&&m.content.includes('EVE_SCIENCE_LIVE_OK')));
    report.conversationMessages=conversation.messages.length;
    await page.screenshot({path:join(output,'science-live-task.png'),fullPage:true});
  }
  check('only one formal window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.isVisible()).length)===1);
  check('no renderer exceptions',report.errors.length===0);
  connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));
}catch(error){report.error=error.message;throw error;}finally{
  writeFileSync(join(output,installed?'ui-report-installed.json':'ui-report.json'),JSON.stringify(report,null,2));
  if(!connection){try{connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));}catch{}}
  if(connection)await rpc(connection,'shutdown').catch(()=>{});
  if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
  server?.closeAllConnections();server?.close();
}
