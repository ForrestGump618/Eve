import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareContextAsync} from '../src/context-async.js';
import {queryContextAsync} from '../src/context-query.js';
import type {ContextSummary} from '../src/context.js';

test('dashboard recalls verified source after compaction without replaying a tool',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'eve-context-inspect-'));
 const options={directory,model:'deepseek-v4.1-flash-economy',contextWindow:64000,outputTokens:256,accounting:'estimate' as const};
 try{
  await prepareContextAsync(options,{force:true,messages:[
   {role:'user',content:'Read /remote/研究.csv and preserve failed attempts.'},
   {role:'assistant',content:'Evidence: sha256=abc; negative result: no causal conclusion.'},
   {role:'user',content:'Compare results.'},
  ]});
  const data=await queryContextAsync(options,'inspect') as unknown as {estimated:boolean;compositionAccounting:string;snapshots:ContextSummary[];messageCount:number};
  assert.equal(data.estimated,true);
  assert.equal(data.compositionAccounting,'utf8-bytes-upper-bound');
  assert.equal(data.messageCount,3);
  const source=data.snapshots[0]!.userGoals[0]!.source;
  const recalled=await queryContextAsync(options,'source',source) as {content:string};
  assert.match(recalled.content,/研究.csv/);
  await assert.rejects(queryContextAsync(options,'source',{...source,sha256:'0'.repeat(64)}));
 }finally{rmSync(directory,{recursive:true,force:true});}
});

