/** Controlled provider decisions; actual formal Electron, APIs, vault, tools and disk. */
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core'),{rpc}=await import('../dist/src/rpc.js');
const profile=mkdtempSync(join(tmpdir(),'eve-reliability-'));
const output=join(root,'release/reliability-acceptance');mkdirSync(output,{recursive:true});
const installed=process.argv.includes('--installed');
const env={...process.env,SUWEN_TEST_HOME:profile,SUWEN_WORKBENCH_DEPS:join(process.env.APPDATA,'Eve/python-env')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=installed?join(process.env.LOCALAPPDATA,'Programs/Eve/Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const launchArgs=installed?[]:[root];
const report={kind:'controlled model; real formal Electron/API/files/skills; no paid-model quality claim',installed,checks:[],errors:[],profile};
let app,server,connection,toolRequestAt=0,finishAt=0,sawLoaded=false,requests=0;
const check=(name,condition)=>{report.checks.push({name,passed:Boolean(condition)});console.log(condition?'PASS':'FAIL',name);if(!condition)throw Error(name);};
const navigate=async(page,route)=>page.evaluate(async route=>(await import('/js/store.js?v=2.1.1')).navigate(route),route);
try{
 server=createServer(async(req,res)=>{
  if(req.method==='GET'){
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'controlled-fast'},{id:'controlled-deep'}]}));return;
  }
  try{
   let raw='';for await(const chunk of req)raw+=chunk;
   const {messages}=JSON.parse(raw);requests++;
   sawLoaded||=messages.some(m=>m.role==='tool'&&m.content.includes('"instructions"'));
   const wrote=messages.some(m=>m.role==='tool'&&m.content.includes('"verified":true'));
   res.writeHead(200,{'content-type':'text/event-stream'});
   const send=data=>res.write('data: '+JSON.stringify({choices:[{delta:data,finish_reason:null}]})+'\n\n');
   if(!wrote){
    send({content:'我已收到任务，正在将结果写入当前工作区。'});
    await new Promise(r=>setTimeout(r,2500));
    toolRequestAt=Date.now();
    send({tool_calls:[{index:0,id:'actual-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'reliability-result.md',content:'# Checked result\nActual workspace write.\n'})}}]});
    res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:300,completion_tokens:30}})+'\n\ndata: [DONE]\n\n');
   }else{
    await new Promise(r=>setTimeout(r,2500));finishAt=Date.now();
    res.end('data: '+JSON.stringify({choices:[{delta:{content:'EVE_RELIABILITY_VERIFIED：文件已写入并回读校验。'},finish_reason:'stop'}],usage:{prompt_tokens:300,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');
   }
  }catch(error){res.end('data: '+JSON.stringify({error:{message:String(error)}})+'\n\n');}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 app=await _electron.launch({executablePath,args:[...launchArgs,'--native','--background'],env,timeout:60000});
 const shell=await app.firstWindow();await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 await shell.evaluate(baseUrl=>window.suwen.call('configure',{provider:'openai',baseUrl,apiKey:'fixture-only',model:'controlled-fast',contextWindow:65536,maxOutput:2048}),baseUrl);
 await app.evaluate(({app})=>app.exit(0));app=null;
 app=await _electron.launch({executablePath,args:launchArgs,env,timeout:60000});
 let page;
 for(let n=0;n<180;n++){page=app.windows().find(p=>/^http:/.test(p.url()));if(page)break;await new Promise(r=>setTimeout(r,500));}
 if(!page)throw Error('Formal workbench failed to open');
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.waitForSelector('#chat-input',{timeout:90000});
 const welcome=page.getByRole('button',{name:'先看看',exact:true});
 await welcome.waitFor({state:'visible',timeout:10000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
 if(await welcome.isVisible())await welcome.click();
 check('default light theme',await page.evaluate(()=>document.documentElement.dataset.theme==='light'));
 await navigate(page,'settings');await page.locator('[data-action="provider-add"]').first().click();
 await page.locator('#provider-editor-provider').selectOption('openai');
 await page.locator('#provider-editor-base').fill(baseUrl);
 await page.locator('#provider-editor-key').fill('fixture-only');
 check('provider key input is masked',await page.locator('#provider-editor-key').getAttribute('type')==='password');
 await page.locator('[data-model-discover]').click();
 await page.waitForFunction(()=>document.querySelector('[data-model-status]')?.textContent.includes('已获取 2'));
 check('real provider model list appears in app',await page.locator('.eve-model-option').count()>=2);
 for(const model of ['controlled-fast','controlled-deep'])await page.locator(`.eve-model-option input[value="${model}"]`).check();
 await page.locator('[data-model-default="controlled-fast"]').click();
 await page.locator('#provider-editor-test').uncheck();
 await page.locator('#provider-editor-default').check();
 await page.screenshot({path:join(output,installed?'models-installed.png':'models.png')});
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForSelector('#provider-editor-provider',{state:'detached'});
 const models=await page.evaluate(async()=>(await(await fetch('/api/settings')).json()).providers);
 check('multiple models persisted for one provider',models.openai.models.includes('controlled-fast')&&models.openai.models.includes('controlled-deep'));
 await navigate(page,'workbench');await page.waitForSelector('#chat-input');
 await page.locator('#new-conv').click();
 await page.locator('#chat-skills-open').click();
 await page.waitForSelector('.eve-task-skill input');
 await page.locator('[data-skill-query]').fill('biomedical-discovery');
 await page.waitForSelector('.eve-task-skill input[value="biomedical-discovery"]');
 const skillName=await page.locator('.eve-task-skill input').first().inputValue();
 await page.locator('.eve-task-skill input').first().check();
 await page.getByRole('button',{name:'加入当前任务',exact:true}).click();
 await page.locator('#chat-input').fill(`[选用技能: ${skillName}]\n写入文件 reliability-result.md，并核对实际内容。`);
 await page.locator('#chat-permission-mode').selectOption('full');
 await page.locator('#send-btn').click();
 await page.waitForFunction(()=>document.querySelector('#messages')?.textContent.includes('正在将结果写入'),undefined,{timeout:90000});
 check('intermediate model text visible before completion',finishAt===0);
 await page.screenshot({path:join(output,installed?'running-installed.png':'running.png')});
 await page.waitForFunction(()=>document.querySelector('#messages')?.textContent.includes('EVE_RELIABILITY_VERIFIED'),undefined,{timeout:90000});
 check('selected skill loaded into real model request',sawLoaded);
 check('tool and followup requests reached provider',requests===2&&toolRequestAt>0&&finishAt>toolRequestAt);
 await page.waitForSelector('.eve-file-changes:not([hidden])');
 await page.locator('.eve-file-changes summary').click();
 await page.locator('[data-change]').first().click();
 await page.waitForSelector('.eve-diff');
 check('actual file patch rendered',await page.locator('.eve-diff').textContent().then(t=>t.includes('+Actual workspace write.')));
 await page.screenshot({path:join(output,installed?'file-changes-installed.png':'file-changes.png')});
 await page.getByRole('button',{name:'关闭',exact:true}).last().click();
 check('only one formal product window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.isVisible()).length)===1);
 check('no renderer exceptions',report.errors.length===0);
 report.skill=skillName;
}catch(error){report.error=error.message;console.error(error);process.exitCode=1;}finally{
 report.requests=requests;
 writeFileSync(join(output,installed?'ui-installed.json':'ui.json'),JSON.stringify(report,null,2));
 try{connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));}catch{}
 if(connection)await rpc(connection,'shutdown').catch(()=>{});
 if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
 server?.closeAllConnections();server?.close();
}
