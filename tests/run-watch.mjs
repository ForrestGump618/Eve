import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunFailureObserver} from '../omicslab/web/js/run-watch.js';

test('run failures notify once, not on elapsed-time refresh or historical startup',()=>{
 const notices=[];const observe=createRunFailureObserver(rows=>notices.push(rows),{startedAt:100000});
 const run={run_id:'r',session_id:'s',created_at:90,status:'running'};
 observe([{run_id:'old',created_at:80,status:'failed'},run]);assert.equal(notices.length,0);
 observe([{...run,status:'failed',elapsed:10}]);assert.equal(notices.length,1);
 observe([{...run,status:'failed',elapsed:20}]);assert.equal(notices.length,1);
 observe([{run_id:'fresh',session_id:'s',created_at:110,status:'interrupted'}]);assert.equal(notices.length,2);
 observe([{...run,run_id:'cancelled',status:'cancelled'}]);assert.equal(notices.length,2);
});
