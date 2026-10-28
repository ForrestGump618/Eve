/** Real formal Electron, scoped APIs, kernel and viewers. Model decisions fixed. */
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core');
const {rpc}=await import('../dist/src/rpc.js');
const profile=mkdtempSync(join(tmpdir(),'eve-research-workbench-'));
const output=join(root,'release/research-acceptance');mkdirSync(output,{recursive:true});
const personal=join(process.env.APPDATA,'Eve/runtime/science-library');
if(existsSync(personal))cpSync(personal,join(profile,'runtime/science-library'),{recursive:true});
const env={...process.env,SUWEN_TEST_HOME:profile,SUWEN_WORKBENCH_DEPS:join(process.env.APPDATA,'Eve/python-env')};
delete env.ELECTRON_RUN_AS_NODE;
const installed=process.argv.includes('--installed');
const executablePath=installed?join(process.env.LOCALAPPDATA,'Programs/Eve/Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const launchArgs=installed?[]:[root];
const report={kind:'controlled model protocol; real Electron/API/Jupyter/input/viewer; no autonomous-science or SSH acceptance',
 checks:[],errors:[],profile,installed};
const check=(name,condition)=>{report.checks.push({name,passed:Boolean(condition)});if(!condition)throw Error(name);console.log('PASS',name);};
let app,connection,server;
try{
 server=createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;
   const {messages}=JSON.parse(raw),observations=messages.filter(m=>m.role==='tool');
   const last=observations.length?JSON.parse(observations.at(-1).content):null;
   const next=!observations.length;
   const data=next?{tool_calls:[{index:0,id:'read-real-fastq',type:'function',function:{name:'science_inspect',arguments:JSON.stringify({kind:'fastq',path:'reads.fastq'})}}]}:
    {content:last?.ok&&last.result?.reads===2?'EVE_RESEARCH_VERIFIED：两条读数，Q30 比例为 50%。这是基础质控，尚未开展完整测序分析。':'EVE_RESEARCH_FAILED '+JSON.stringify(last)};
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.end('data: '+JSON.stringify({choices:[{delta:data,finish_reason:next?'tool_calls':'stop'}],usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220}})+'\n\ndata: [DONE]\n\n');
  }catch(error){res.writeHead(500);res.end(String(error));}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 app=await _electron.launch({executablePath,args:[...launchArgs,'--native','--background'],env,timeout:60000});
 const shell=await app.firstWindow();await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 await shell.evaluate(baseUrl=>window.suwen.call('configure',{provider:'openai',baseUrl,apiKey:'fixture-only',model:'controlled-research-protocol',contextWindow:65536,maxOutput:2048}),baseUrl);
 await app.evaluate(({app})=>app.exit(0));app=null;
 app=await _electron.launch({executablePath,args:launchArgs,env,timeout:60000});
 let page;
 for(let n=0;n<180;n++){page=app.windows().find(p=>/^http:/.test(p.url()));if(page)break;await new Promise(r=>setTimeout(r,500));}
 if(!page)throw Error('Formal workbench did not open');
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.waitForSelector('#chat-input',{timeout:60000});
 const welcome=page.getByRole('button',{name:'先看看',exact:true});
 await welcome.waitFor({state:'visible',timeout:10000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
 if(await welcome.isVisible())await welcome.click();
 report.workspace=await page.evaluate(async()=>{
  const {getState}=await import('/js/store.js?v=2.1.1');const id=getState().workspaceId;
  const files={
   'reads.fastq':'@read1\nACGT\n+\nIIII\n@read2\nNNAA\n+\n!!!!\n',
   'seq.fa':'>alpha\nACGTNN\n>beta\nAC-TNN\n',
   'counts.csv':'gene,sampleA,sampleB\nG1,1,0\nG2,2,3\n',
   's.pdb':'ATOM      1  CA  ALA A   1      11.104  13.207   9.123  1.00 20.00           C  \nATOM      2  CA  GLY A   2      15.104  15.207  12.123  1.00 20.00           C  \n',
  };
  for(const [path,content] of Object.entries(files)){
   const response=await fetch(`/api/workspaces/${id}/files/write`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path,content})});
   if(!response.ok)throw Error(await response.text());
  }
  return id;
 });
 await page.evaluate(async()=>{(await import('/js/store.js?v=2.1.1')).navigate('research');});
 await page.waitForSelector('.science-lane',{timeout:30000});
 check('ten scientific lanes in formal workbench',await page.locator('.science-lane').count()===10);
 check('shared and personal skills enable lanes',await page.locator('[data-science-launch]:enabled').count()===10);
 await page.screenshot({path:join(output,'science-workbench.png'),fullPage:true});
 await page.locator('[data-science-env]').click();
 await page.waitForSelector('.science-dependencies',{timeout:60000});
 check('actual dependency presence displayed',(await page.locator('#science-environment').textContent()).includes('Python'));
 for(const [kind,path,selector,expected] of [
  ['fasta','seq.fa','.science-sequences','AC-TNN'],
  ['fastq','reads.fastq','.science-metrics','50.0%'],
  ['counts','counts.csv','.science-bars','sampleA'],
  ['structure','s.pdb','.science-structure',null],
 ]){
  await page.locator(`[data-science-kind="${kind}"]`).click();
  await page.locator('#science-path').fill(path);
  await page.getByRole('button',{name:'检查数据',exact:true}).click();
  await page.waitForSelector('#science-preview '+selector,{timeout:60000});
  check(kind+' renders actual scientific input',expected?(await page.locator('#science-preview').textContent()).includes(expected):await page.locator('canvas.science-structure').count()===1);
 }
 const before=await page.locator('canvas.science-structure').evaluate(canvas=>canvas.toDataURL());
 await page.locator('canvas.science-structure').focus();await page.keyboard.press('ArrowRight');
 check('coordinate preview is keyboard interactive',await page.locator('canvas.science-structure').evaluate(canvas=>canvas.toDataURL())!==before);
 await page.locator('canvas.science-structure').blur();
 await page.screenshot({path:join(output,'science-input-preview.png'),fullPage:true});
 await page.locator('[data-science-launch="ngs"]').click();
 await page.locator('#science-goal').fill('检查 reads.fastq 的真实读数和 Q30 比例。');
 await page.locator('#science-inputs').fill('reads.fastq，Phred+33；仅做基础检查。');
 await page.getByRole('button',{name:'启动任务',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#messages')?.textContent.includes('EVE_RESEARCH_VERIFIED'),undefined,{timeout:120000});
 check('guided workflow uses existing harness and actual bound-host tool',true);
 await page.screenshot({path:join(output,'science-task.png'),fullPage:true});
 check('one formal window',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.isVisible()).length)===1);
 check('no renderer exceptions',report.errors.length===0);
}catch(error){report.error=error.message;throw error;}finally{
 writeFileSync(join(output,installed?'ui-report-installed.json':'ui-report.json'),JSON.stringify(report,null,2));
 try{connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));}catch{}
 if(connection)await rpc(connection,'shutdown').catch(()=>{});
 if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
 server?.closeAllConnections();server?.close();
}
