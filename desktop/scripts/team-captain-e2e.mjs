/** Actual Electron, task queue, native tools and persistent team; loopback model decisions. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron} from 'playwright-core';
import {rpc} from '../dist/src/rpc.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const packaged=process.argv.includes('--packaged');
const output=join(root,'release',packaged?'team-packaged':'team-source');mkdirSync(output,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'eve-captain-'));
const goal='EVE_TEAM_USER_GOAL: create team-evidence.txt containing EVE_EXECUTION_PROOF, verify it and summarize.';
const report={kind:'controlled model protocol; real Electron, daemon, team queue, file tool and discussion',packaged,checks:[],requests:[],errors:[]};
let app, page, connection, captainCalls=0;
const check=(name,ok)=>{report.checks.push({name,ok:Boolean(ok)});assert.ok(ok,name);console.log('PASS',name);};
const wait=async predicate=>{const end=Date.now()+120000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,200));}throw Error('Team acceptance timed out');};
const server=createServer(async(req,res)=>{
 if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'team-protocol-fixture'}]}));return;}
 try{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw), users=body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
  const worker=users.includes('团队成员：Executor'), reviewer=users.includes('团队成员：Independent verifier');
  const observations=body.messages.filter(m=>m.role==='tool');
  let call=null,content='';
  if(worker){
   const status=observations.find(m=>m.content.includes('"members"'));
   let id;try{const value=JSON.parse(status?.content||'{}');id=value.result?.items?.[0]?.id;}catch{}
   const plan=[['team_status',{}],['team_message',{id,recipient:'review',content:'EVE_DISCUSSION: check actual team-evidence.txt before accepting.'}],['write_file',{path:'team-evidence.txt',content:'EVE_EXECUTION_PROOF\n'}]];
   call=plan[observations.length];content='EVE_EXECUTION_PROOF: file saved; reviewer must read it.';
  }else if(reviewer){
   if(!observations.length)call=['read_file',{path:'team-evidence.txt'}];
   content='EVE_REVIEW_PROOF: actual file read and original goal checked.';
  }else{captainCalls++;content=captainCalls===1?'EVE_PLAN_READY: approve the saved team plan.':'EVE_CAPTAIN_SUMMARY_OK: executor and verifier results recorded; inspect the team evidence.';}
  report.requests.push({role:worker?'executor':reviewer?'reviewer':'captain',hasOriginalGoal:users.includes('EVE_TEAM_USER_GOAL'),hasDiscussion:users.includes('EVE_DISCUSSION'),tool:call?.[0]||null});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=call?{tool_calls:[{index:0,id:'call-'+report.requests.length,type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]}:{content};
  res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150}})+'\n\ndata: [DONE]\n\n');
 }catch(error){report.errors.push(error.message);res.writeHead(500);res.end('{}');}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=packaged?join(root,'release/win-unpacked/Eve.exe'):join(root,'node_modules/electron/dist/electron.exe');
const args=packaged?[]:[root];
const request=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{
 const response=await fetch(path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;
},{path,method,body});
try{
 app=await _electron.launch({executablePath,args:[...args,'--native','--background'],env,timeout:60000});
 const shell=await app.firstWindow();await shell.waitForFunction(()=>window.suwen&&document.getElementById('health'));
 await shell.evaluate(config=>window.suwen.call('configure',config),{provider:'openai',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture-only',model:'team-protocol-fixture',contextWindow:65536,maxOutput:2048});
 await app.close();app=null;
 app=await _electron.launch({executablePath,args,env,timeout:60000});
 await wait(async()=>{page=app.windows().find(p=>/^http:/.test(p.url()));return Boolean(page);});
 page.on('pageerror',e=>report.errors.push(e.message));await page.waitForSelector('#chat-input',{timeout:60000});
 check('default-team-mode',await page.locator('#chat-collaboration-mode').inputValue()==='team');
 await page.locator('#chat-permission-mode').evaluate(node=>{node.value='full';node.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.locator('#chat-input').fill(goal);await page.locator('#send-btn').click();
 let team;
 await wait(async()=>{team=(await request('/api/teams')).items.find(t=>t.user_goal?.includes('EVE_TEAM_USER_GOAL'));return team?.draft;});
 check('automatic-plan-and-no-preapproval-tasks',team.members.length===2&&team.members.every(m=>!m.task_id));
 const captain=team.captain_session;
 await wait(async()=>!(await request('/api/conversations/'+captain)).messages.every(m=>m.role!=='assistant'));
 await page.locator('#chat-team-open').click();await page.waitForSelector('[data-team-action="approve"]');
 await page.locator('[data-team-action="approve"]').click();
 await wait(async()=>{team=(await request('/api/teams')).items.find(t=>t.id===team.id);return team?.members.every(m=>m.task?.status==='succeeded');});
 check('persistent-members-executed-with-dependency',team.members[0].task.nodes.work.session_id!==team.members[1].task.nodes.work.session_id);
 const messages=await request(`/api/teams/${team.id}/messages`,'POST',{});
 check('original-task-broadcast',messages.items.some(m=>m.kind==='user_goal'&&m.content.includes('EVE_TEAM_USER_GOAL')));
 check('peer-discussion-and-results-to-captain',messages.items.some(m=>m.content.includes('EVE_DISCUSSION'))&&messages.items.filter(m=>m.kind==='task_result'&&m.recipient==='captain').length===2);
 check('executor-and-reviewer-received-original',report.requests.filter(r=>r.role!=='captain').every(r=>r.hasOriginalGoal));
 check('reviewer-received-discussion',report.requests.some(r=>r.role==='reviewer'&&r.hasDiscussion));
 await wait(async()=>{const conv=await request('/api/conversations/'+captain);return conv.messages.some(m=>m.role==='assistant'&&m.content.includes('EVE_CAPTAIN_SUMMARY_OK'));});
 check('captain-summary-back-in-original-conversation',true);
 const file=await request('/api/workspaces/ws_main/files/read?path=team-evidence.txt');
 check('real-file-readback',(file.text||file.content||'').includes('EVE_EXECUTION_PROOF'));
 await page.screenshot({path:join(output,'teams.png'),fullPage:true});
 check('no-page-errors',report.errors.length===0);report.success=true;
}catch(error){report.error=error.message;console.error(error.message);}
finally{
 try{connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));await rpc(connection,'shutdown');}catch{}
 if(app)await app.close().catch(()=>{});
 server.closeAllConnections();server.close();
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
}
process.exitCode=report.success?0:1;
