/** Actual Electron UI, persistent API, artifact gates and the existing Agent loop.
 * The enclosing driver labels controlled protocol and live model runs separately. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

export async function researchAcceptance({page,workspace,check,out,live}){
 const full=process.argv.includes('--research-full');
 if(full&&!live)throw Error('Full research acceptance requires a real model');
 const scope=await page.locator('#project-workspace').inputValue(),suffix='?scope='+encodeURIComponent(scope);
 await page.evaluate(()=>{location.hash='#/research';});
 await page.waitForSelector('[data-research="new"]');
 check('research-entry-opens-concrete-module-map',await page.getByText('DeepScientist 与 Eve 的模块对应',{exact:true}).count()===1);
 await page.click('[data-research="new"]');
 await page.fill('#quest-title','CSV workflow acceptance');
 await page.fill('#quest-question',full?
  '这是小型合成分类流程验收，不是科学发现。实际读取 sample.csv 的 value 列，标签由 value>=4 得到。scout 梳理数据并写 quest-scout.md。baseline 用真实 Python 读取 CSV，以始终预测0为基线计算 accuracy，写 baseline-metrics.json。hypothesis 写阈值分类可改进基线的假设与边界。experiment 用真实 Python 读取 CSV，以 value>=4 预测并计算 accuracy，写 experiment-metrics.json。两个指标文件必须实际由代码计算，结构为 {"dataset":"csv-demo-v1","protocol":"same-file-v1","metrics":{"accuracy":数值}}。analysis 读取两份指标并比较。write 写 report.md，保留合成数据、样本很小和无科学外推的局限。每阶段按需加载合适技能、真实执行当前阶段，research_record 仅登记当前阶段的实际产物和结论；baseline/experiment 必须提交 metrics_path。不要重复已登记阶段，不要自己结题。':
  '在当前工作区 sample.csv 上检查数据和研究流程。scout 阶段必须实际读取 sample.csv，按需加载 baseline 技能，创建 quest-scout.md，再用 research_record 登记 scout 阶段。只验证流程，不声称科学发现。');
 await page.fill('#quest-dataset','csv-demo-v1');await page.fill('#quest-protocol','same-file-v1');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.locator('.modal-backdrop').waitFor({state:'detached'});
 await page.waitForSelector('.eve-stage-map');
 check('quest-form-persists-seven-stages',await page.locator('.eve-stage').count()===7);
 const quest=await page.evaluate(suffix=>fetch('/api/platform/quests'+suffix).then(r=>r.json()).then(r=>r.items[0]),suffix);
 const post=(path,body)=>page.evaluate(async({path,body})=>{
  const response=await fetch('/api/platform'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 },{path:path+suffix,body});
 const waitForFinal=async(stage)=>{
  const started=Date.now();
  while(Date.now()-started<120000){
   const approve=page.locator('.approval-card:not(.is-approved):not(.is-denied) .approve-btn');
   if(await approve.count())await approve.first().click();
   const run=await page.evaluate(async({id,suffix,stage})=>{
    const q=(await fetch('/api/platform/quests'+suffix).then(r=>r.json())).items.find(q=>q.id===id);
    const result=await fetch('/api/runs/'+q.stages.find(s=>s.id===stage).run_id).then(r=>r.json());return result.run||result;
   },{id:quest.id,suffix,stage});
   if(['succeeded','completed','failed','cancelled','interrupted'].includes(run.status))return run;
   await page.waitForTimeout(400);
  }
  throw Error('Research final verification timeout: '+stage);
 };
 const blocked=await post(`/quests/${quest.id}/record`,{stage:'experiment',artifacts:['sample.csv'],summary:'Cannot skip'});
 check('real-api-rejects-skipping-baseline',blocked.status===422);
 await page.click('[data-research="launch"][data-stage="scout"]');
 await page.waitForSelector('.eve-stage[data-status="running"]');
 await page.click('[data-research="chat"]');
 await page.waitForSelector('#chat-input');
 const started=Date.now();let done=false;
 while(Date.now()-started<240000){
  const approve=page.locator('.approval-card:not(.is-approved):not(.is-denied) .approve-btn');
  if(await approve.count()){await approve.first().click();await page.waitForTimeout(100);}
  const result=await page.evaluate(({id,suffix})=>fetch('/api/platform/quests'+suffix).then(r=>r.json()).then(r=>r.items.find(q=>q.id===id)),{id:quest.id,suffix});
  if(result.stages[0].status==='recorded'){done=true;break;}
  if(['failed','cancelled','interrupted'].includes(result.stages[0].status))throw Error('Research run failed: '+result.stages[0].status);
  await page.waitForTimeout(400);
 }
 check('launched-stage-uses-real-tools-and-records-artifact',done);
 if(!done)throw Error('Research stage did not record evidence within time budget');
 const run=await waitForFinal('scout');
 check('research-agent-final-answer-passes-harness-verification',['succeeded','completed'].includes(run.status));
 if(!['succeeded','completed'].includes(run.status))throw Error('Research evidence recorded but Agent failed final verification');
 await page.evaluate(()=>{location.hash='#/research';});await page.waitForSelector('.eve-stage[data-status="recorded"]');
 check('recorded-evidence-is-visible-with-hash',(await page.locator('.eve-stage').first().textContent()).includes('quest-scout.md'));
 if(full){
  for(const stage of ['baseline','hypothesis','experiment','analysis','write']){
   await page.click(`[data-research="launch"][data-stage="${stage}"]`);
   await page.waitForSelector('.eve-stage[data-status="running"]');
   await page.locator(`[data-research="chat"]`).last().click();await page.waitForSelector('#chat-input');
   const started=Date.now();let complete=false,current;
   while(Date.now()-started<240000){
    const approve=page.locator('.approval-card:not(.is-approved):not(.is-denied) .approve-btn');
    if(await approve.count()){await approve.first().click();await page.waitForTimeout(100);}
    current=await page.evaluate(({id,suffix})=>fetch('/api/platform/quests'+suffix).then(r=>r.json()).then(r=>r.items.find(q=>q.id===id)),{id:quest.id,suffix});
    const step=current.stages.find(s=>s.id===stage);
    if(step.status==='recorded'){complete=true;break;}
    if(['failed','cancelled','interrupted'].includes(step.status))throw Error('Full research stage failed: '+stage);
    await page.waitForTimeout(400);
   }
   if(!complete)throw Error('Full research stage timeout: '+stage);
   const step=current.stages.find(s=>s.id===stage);
   const state=await waitForFinal(stage);
   check('real-model-'+stage+'-passes-final-verification',['succeeded','completed'].includes(state.status));
   if(!['succeeded','completed'].includes(state.status))throw Error('Full research final verification failed: '+stage);
   if(['baseline','experiment'].includes(stage))check('real-model-'+stage+'-actually-executes-code',(await page.locator('#messages').textContent()).includes('run_shell'));
   await page.evaluate(()=>{location.hash='#/research';});await page.waitForSelector('.eve-stage[data-status="recorded"]');
  }
  const actual=await page.evaluate(({id,suffix})=>fetch('/api/platform/quests'+suffix).then(r=>r.json()).then(r=>r.items.find(q=>q.id===id)),{id:quest.id,suffix});
  check('actual-classification-baseline-and-experiment-match-data',Math.abs(actual.stages[1].measured.accuracy-1/3)<1e-9&&actual.stages[3].measured.accuracy===1);
 }else{
 // These are explicitly imported test artifacts, not fabricated model measurements.
 writeFileSync(join(workspace,'baseline-metrics.json'),JSON.stringify({dataset:'csv-demo-v1',protocol:'same-file-v1',metrics:{accuracy:.7}}));
 writeFileSync(join(workspace,'experiment-metrics.json'),JSON.stringify({dataset:'csv-demo-v1',protocol:'same-file-v1',metrics:{accuracy:.8}}));
 for(const stage of ['baseline','hypothesis','experiment','analysis','write']){
  await page.click(`[data-research="record"][data-stage="${stage}"]`);
  await page.fill('#quest-paths','sample.csv');await page.fill('#quest-summary','Imported fixture evidence; no scientific validity claim.');
  if(['baseline','experiment'].includes(stage))await page.fill('#quest-metric-path',stage+'-metrics.json');
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.locator('.modal-backdrop').waitFor({state:'detached'});
 }
 }
 check('metric-comparison-visible',await page.locator('.eve-stage').nth(3).textContent().then(x=>x.includes('"delta"')));
 await page.click('[data-research="record"][data-stage="finalize"]');
 await page.fill('#quest-paths','sample.csv');await page.fill('#quest-summary','Human-reviewed test workflow only.');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 check('finalize-without-human-approval-keeps-dialog',await page.locator('#quest-approved').isVisible());
 await page.check('#quest-approved');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.locator('.modal-backdrop').waitFor({state:'detached'});
 const final=await page.evaluate(({id,suffix})=>fetch('/api/platform/quests'+suffix).then(r=>r.json()).then(r=>r.items.find(q=>q.id===id)),{id:quest.id,suffix});
 check('human-reviewed-closure-still-labels-science-unverified',final.status==='completed'&&final.scientific_status==='unverified'&&final.stages.every(s=>s.status==='recorded'));
 check('quest-artifact-provenance-has-real-run',Boolean(final.stages[0].run_id)&&final.stages[0].evidence.every(e=>/^[a-f0-9]{64}$/.test(e.sha256)));
 await page.reload();await page.waitForSelector('.eve-stage[data-status="recorded"]');
 check('quest-survives-page-reload',await page.locator('.eve-stage[data-status="recorded"]').count()===7);
 await page.screenshot({path:join(out,`research-${full?'full-':''}${live?'live':'controlled'}.png`)});
}
