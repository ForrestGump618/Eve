/** Real Electron/IPC regression: pending conversation reads must not undo a new
 * conversation or overwrite a newer selection. No model fixture or API needed. */
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core');
const {rpc}=await import('../dist/src/rpc.js');
const {readFileSync}=await import('node:fs');
const profile=mkdtempSync(join(tmpdir(),'suwen-conversation-race-'));
const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
const report={kind:'real isolated Electron and daemon IPC; no model requests',checks:[],at:new Date().toISOString()};
let app;
try{
 app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--native'],env,timeout:60000});
 const page=await app.firstWindow();
 await page.waitForFunction(()=>window.suwen&&typeof newConversation==='function'&&document.getElementById('health')?.textContent?.includes('后台运行'));
 report.checks=await page.evaluate(async()=>{
   const checks=[];
   const create=async title=>{const got=await window.suwen.call('conversation.create',{title,mode:'chat'});return conversationOf(got)?.id;};
   const a=await create('race-A'),b=await create('race-B');
   if(!a||!b)throw new Error('Actual conversation.create did not return ids');
   await openConversation(a);
   const read=refreshConversationRecord();newConversation();await read;
   checks.push({name:'late-get-cannot-restore-old-conversation',ok:S.conversationId===null&&S.conversation===null});
   const list=loadConversations();newConversation();await list;await loadConversations();
   checks.push({name:'refresh-list-keeps-explicit-new-conversation',ok:S.conversationId===null&&S.conversation===null});
   const openingA=openConversation(a),openingB=openConversation(b);await Promise.all([openingA,openingB]);
   checks.push({name:'latest-selection-owns-conversation-data',ok:S.conversationId===b&&S.conversation?.id===b});
   openEvidence();newConversation();
   checks.push({name:'new-conversation-clears-old-inspector-and-scroll-intent',ok:!S.evidenceOpen&&S.stream.scrollPinned&&S.stream.userIntent==='down'});
   return checks;
 });
}catch(e){report.error=String(e.message);}
finally{
 try{const connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));await rpc(connection,'shutdown');}catch{}
 if(app)await app.close().catch(()=>{});
 writeFileSync(resolve(root,'../docs/verification/harness-20261025/conversation-race-ui.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
 process.exit(report.error||report.checks.some(x=>!x.ok)?1:0);
}
