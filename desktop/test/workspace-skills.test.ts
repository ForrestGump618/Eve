import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkspaceFiles,userFileGrants} from '../src/workspace-files.js';
import {Store} from '../src/harness/store.js';
import {SkillRegistry} from '../src/domain/tools.js';
import {installBundledSkills} from '../src/bundled-skills.js';
import {createSkill} from '../src/skill-authoring.js';
import {createResearchWorker} from '../src/research-worker.js';
const signal=()=>new AbortController().signal;
test('workspace files paginate, search, refuse escape, and protect unseen updates',async()=>{
 const root=mkdtempSync(join(tmpdir(),'suwen-files-')),other=mkdtempSync(join(tmpdir(),'suwen-outside-'));
 writeFileSync(join(root,'data.txt'),Array.from({length:900},(_,i)=>`line${i+1}`).join('\n'));
 writeFileSync(join(other,'outside.txt'),'private');
 const files=new WorkspaceFiles([root],[]);
 assert.equal((await files.list() as any).entries[0].name,'data.txt');
 const first=await files.read('data.txt',1,40) as any;assert.equal(first.nextStartLine,41);assert.equal(first.endLine,40);
 assert.match((await files.read('data.txt',41,10) as any).content,/^line41\n/);
 const found=await files.search('line899','.',signal()) as any;assert.equal(found.matches[0].line,899);
 await assert.rejects(files.read(join(other,'outside.txt')),/outside/);
 await assert.rejects(files.write('data.txt','changed'),/matching expectedSha256/);
 await files.write('data.txt','changed',first.sha256);assert.equal(readFileSync(join(root,'data.txt'),'utf8'),'changed');
 await assert.rejects(files.write('data.txt','stale',first.sha256),/matching/);
 await files.write('new.txt','created');assert.equal(readFileSync(join(root,'new.txt'),'utf8'),'created');
 const exact=new WorkspaceFiles([],[join(other,'outside.txt')]);assert.equal((await exact.read('outside.txt') as any).content,'private');
 await assert.rejects(exact.list(other),/outside/);
 if(process.platform==='win32')assert.deepEqual(await userFileGrants(`请读取 ${join(root,'data.txt')} 并总结`),[join(root,'data.txt')]);
});
test('all built-in workbench workflows seed into the native registry and load with runtime adaptation',async()=>{
 const home=mkdtempSync(join(tmpdir(),'eve-workflow-seed-')),store=new Store(join(home,'test.sqlite'));
 try{
  const registry=new SkillRegistry({home,store});
  const root=resolve('dist/bundled-skills');
  const first=await installBundledSkills(registry,root) as any;
  await installBundledSkills(registry,root);
  assert.equal(first.count,35);assert.equal(registry.list().length,35);
  for(const name of ['biomedical-discovery','primer-design','remote-compute-ssh','statistical-rigor']){
   const skill=registry.list().find(s=>s.name===name)!;assert.ok(skill);
   assert.match((registry.load(skill.id) as any).instructions,/Eve 运行适配/);
   assert.equal(skill.executable,false);
  }
 }finally{store.close();}
});
test('bundled skills seed idempotently and generated skills actually execute',async()=>{
 const home=mkdtempSync(join(tmpdir(),'suwen-skill-test-')),store=new Store(join(home,'test.sqlite'));
 const worker=createResearchWorker({python:'python',scriptPath:resolve('worker/research_worker.py')});
 try{
  const registry=new SkillRegistry({home,store,worker});
  const bundled=resolve('bundled-skills');await installBundledSkills(registry,bundled);await installBundledSkills(registry,bundled);
  assert.equal(registry.list().length,8);
  const creator=registry.list().find(x=>x.name==='skill-creator')!;
  assert.match((registry.readResource(creator.id,'references/openai_yaml.md') as any).content,/interface/);
  assert.throws(()=>registry.readResource(creator.id,'../SKILL.md'),/Unknown/);
  const mean=registry.list().find(x=>x.name==='descriptive-stats')!;assert.ok(mean);
  const value=await registry.run(mean.id,{numbers:[2,4,6]},signal()) as any;assert.equal(JSON.parse(value.result.stdout).mean,4);
  const made=await createSkill(registry,{name:'sum-values',description:'sum numeric input',instructions:'Read the numbers input and calculate its sum using the run entry.',script:'import sys,json\nprint(json.dumps({"sum":sum(json.loads(sys.argv[1])["numbers"])}))'},signal()) as any;
  const result=await registry.run(made.skill.id,{numbers:[3,4,5]},signal()) as any;assert.equal(JSON.parse(result.result.stdout).sum,12);
  const disabled=await registry.enable(mean.id,false);await installBundledSkills(registry,bundled);assert.equal(registry.get(disabled.id).enabled,false);
 }finally{await worker.close();store.close();}
});
