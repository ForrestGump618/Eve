import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {SkillLibrary} from '../src/skill-library.js';
import {SkillRegistry} from '../src/domain/tools.js';
import {Store} from '../src/harness/store.js';

function fixture(t:any,count=601){
 const root=mkdtempSync(join(tmpdir(),'eve-library-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const text='Research instructions\n'+'x'.repeat(40000),data=Buffer.from(text),sha=createHash('sha256').update(data).digest('hex');
 const packed=gzipSync(data);
 const skills=Array.from({length:count},(_,i)=>({id:'builtin:'+i,name:i===0?'pubmed':'skill-'+i,
  description:i===0?'literature research review':'deterministic fixture '+i,version:'git-fixture',
  source:'fixture',license:'MIT',sha256:sha,files:{'SKILL.md':sha},omittedResources:[]}));
 writeFileSync(join(root,'library.pack'),packed);
 writeFileSync(join(root,'index.json'),JSON.stringify({version:1,skills,objects:{[sha]:{offset:0,length:packed.length,bytes:data.length}}}));
 return {root,text,sha};
}
test('metadata discovery scales past 500 without loading instruction bodies',t=>{
 const {root}=fixture(t),library=new SkillLibrary(root);
 assert.equal(library.skills.length,601);
 assert.equal(library.search('文献')[0].id,'builtin:0');
 assert.deepEqual(library.search('zxqv-no-match'),[]);
 assert.equal(library.stats().physicalReads,0);
});
test('personal overlays use their own offsets and join discovery without loading resources',t=>{
 const {root,text}=fixture(t,1),extra=fixture(t,1);
 const index=JSON.parse(readFileSync(join(extra.root,'index.json'),'utf8'));
 index.skills[0].id='personal:one';index.skills[0].name='science-lab-bindingdb-skill';
 writeFileSync(join(extra.root,'index.json'),JSON.stringify(index));
 const library=new SkillLibrary(root,[extra.root]);
 assert.equal(library.skills.length,2);
 assert.equal(library.search('science-lab-bindingdb-skill')[0].id,'personal:one');
 assert.equal(library.stats().physicalReads,0);
 assert.equal(library.read('personal:one','SKILL.md'),text);
 assert.equal(library.stats().physicalReads,1);
 assert.throws(()=>new SkillLibrary(root,[root]),/Duplicate/);
});
test('resource reads are cached and paths must be declared',t=>{
 const {root,text}=fixture(t),library=new SkillLibrary(root);
 assert.equal(library.read('builtin:0','SKILL.md'),text);
 assert.equal(library.read('builtin:1','SKILL.md'),text);
 assert.equal(library.stats().physicalReads,1);
 for(const path of ['../SKILL.md','__proto__','/SKILL.md'])assert.throws(()=>library.read('builtin:0',path));
 assert.ok(library.stats().cachedBytes<=4_000_000);
});
test('a modified compressed resource cannot pass the recorded digest',t=>{
 const {root,text}=fixture(t),library=new SkillLibrary(root);
 writeFileSync(join(root,'library.pack'),gzipSync(Buffer.from(text.replace('Research','Tampered'))));
 assert.throws(()=>library.read('builtin:0','SKILL.md'));
});
test('registry pagination, disable persistence and exact instruction continuation',t=>{
 const {root,text}=fixture(t),store=new Store(':memory:');t.after(()=>store.close());
 const registry=new SkillRegistry({store,home:root});registry.mountLibrary(root);
 assert.equal(registry.list().length,601);
 registry.enable('builtin:0',false);assert.deepEqual(registry.search('文献'),[]);
 registry.enable('builtin:0',true);
 const first=registry.load('builtin:0') as any;
 let complete=first.instructions,next=first.nextStartChar;
 while(next!==null){const page=registry.readResource('builtin:0','SKILL.md',next) as any;complete+=page.content;next=page.nextStartChar;}
 assert.equal(complete,text);
 assert.equal(registry.list()[0].enabled,true);
 assert.equal(registry.libraryStats()?.physicalReads,1);
});
test('shipped pack contains discoverable science skills with intact resources',()=>{
 const library=new SkillLibrary(resolve('skill-library'));
 assert.ok(library.skills.length>=250);
 const skill=library.search('single cell scanpy')[0];
 assert.ok(skill);
 assert.ok(library.read(skill.id,'SKILL.md').length>100);
 for(const s of library.skills)for(const path of Object.keys(s.files))library.read(s.id,path);
 assert.ok(library.stats().cachedBytes<=4_000_000);
});
test('an explicitly named installed skill wins over broad library keyword matches',async t=>{
 const {root}=fixture(t),store=new Store(':memory:');t.after(()=>store.close());
 const registry=new SkillRegistry({store,home:root});registry.mountLibrary(resolve('skill-library'));
 const source=join(root,'csv-source');mkdirSync(source);
 writeFileSync(join(source,'SKILL.md'),'# CSV analysis\nCompute a CSV mean.');
 writeFileSync(join(source,'skill.json'),JSON.stringify({name:'csv-analysis',version:'1.0.0',entry:'SKILL.md',license:'MIT',permissions:[]}));
 const skill=await registry.install({path:source,confirm:true});
 assert.equal((registry.search('csv-analysis') as any[])[0].id,skill.id);
});
test('large resource directories paginate without decoding script bodies',t=>{
 const {root,sha}=fixture(t,1);
 const index=JSON.parse(readFileSync(join(root,'index.json'),'utf8'));
 for(let i=0;i<93;i++)index.skills[0].files[`references/${i}.md`]=sha;
 writeFileSync(join(root,'index.json'),JSON.stringify(index));
 const store=new Store(':memory:');t.after(()=>store.close());
 const registry=new SkillRegistry({store,home:root});registry.mountLibrary(root);
 const first=registry.resources('builtin:0') as any,second=registry.resources('builtin:0',first.nextResourceOffset) as any,
  third=registry.resources('builtin:0',second.nextResourceOffset) as any;
 assert.equal(first.resources.length,40);assert.equal(second.resources.length,40);assert.equal(third.resources.length,13);
 assert.equal(third.nextResourceOffset,null);assert.equal(registry.libraryStats()?.physicalReads,0);
});
test('skill discovery uses exact prefixes, exposes MinerU, and invalidates list caches',async t=>{
 const root=mkdtempSync(join(tmpdir(),'eve-cache-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=new Store(':memory:');t.after(()=>store.close());
 const registry=new SkillRegistry({store,home:root});registry.mountLibrary(resolve('skill-library'));
 assert.equal((registry.search('pdf') as any[]).some(skill=>skill.name==='mineru'),true);
 assert.equal((registry.search('ocr') as any[]).some(skill=>skill.name==='mineru'),true);
 const mineru=registry.list().find(skill=>skill.name==='mineru');
 assert.ok(mineru);
 assert.equal(mineru.license,'Apache-2.0');
 assert.match(mineru.source,/opendatalab\/MinerU\/tree\/b7f3dd0c5f6e6d66a298239ffd02b328b873918e/);
 const instructions=registry.readResource(mineru.id,'SKILL.md') as any;
 assert.match(instructions.content,/#|MinerU/i);
 const license=registry.readResource(mineru.id,'EVE-UPSTREAM-LICENSE.txt') as any;
 assert.match(license.content,/Apache License/i);
 await registry.enable(mineru.id,false);
 assert.equal(registry.get(mineru.id).enabled,false);
 assert.equal((registry.search('mineru') as any[]).some(skill=>skill.id===mineru.id),false);
 await registry.enable(mineru.id,true);
 assert.equal(registry.get(mineru.id).enabled,true);
 assert.equal((registry.search('mineru') as any[]).some(skill=>skill.id===mineru.id),true);
});
