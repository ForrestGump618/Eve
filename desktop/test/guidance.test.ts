import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/harness/store.js';
import {listGuidance,changeGuidance,takeGuidance} from '../src/guidance.js';

test('candidate edits, withdrawal, deletion, durable delivery and task isolation',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'suwen-guidance-')),'state.sqlite');let store=new Store(path);
 const a=store.createTask({name:'A',steps:[{id:'echo',kind:'echo'}]}),b=store.createTask({name:'B',steps:[{id:'echo',kind:'echo'}]});
 let item=changeGuidance(store,a.id,{action:'candidate',content:'draft',quote:'original'})[0]!;
 assert.deepEqual(takeGuidance(store,a.id),[]);
 assert.throws(()=>changeGuidance(store,b.id,{messageId:item.id,expectedVersion:item.version,action:'delete'}));
 item=changeGuidance(store,a.id,{messageId:item.id,expectedVersion:item.version,action:'edit',content:'revised'})[0]!;
 assert.equal(item.quote,'original');
 item=changeGuidance(store,a.id,{messageId:item.id,expectedVersion:item.version,action:'send'})[0]!;
 item=changeGuidance(store,a.id,{messageId:item.id,expectedVersion:item.version,action:'withdraw'})[0]!;
 assert.deepEqual(takeGuidance(store,a.id),[]);
 changeGuidance(store,a.id,{messageId:item.id,expectedVersion:item.version,action:'delete'});
 changeGuidance(store,a.id,{action:'send',content:'deliver'});store.close();store=new Store(path);
 assert.equal(takeGuidance(store,a.id)[0]!.content,'deliver');assert.deepEqual(takeGuidance(store,a.id),[]);
 const delivered=listGuidance(store,a.id)[0]!;
 assert.throws(()=>changeGuidance(store,a.id,{messageId:delivered.id,expectedVersion:delivered.version,action:'delete'}),/already/);
 assert.deepEqual(listGuidance(store,b.id),[]);store.cancelTask(a.id);
 assert.throws(()=>changeGuidance(store,a.id,{action:'send',content:'too late'}),/ended/);store.close();
});
