/** Real filesystem, registry, Python execution and public GitHub download.
 * No model fixture and no model claims: this verifies the actual tool boundary. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../dist/src/harness/store.js';
import {createToolServices} from '../dist/src/activities/tools.js';
import {createResearchWorker} from '../dist/src/research-worker.js';
import {createAgentTools} from '../dist/src/agent-tools.js';
import {SearchService} from '../dist/src/search.js';
import {installBundledSkills} from '../dist/src/bundled-skills.js';
const home=mkdtempSync(join(tmpdir(),'suwen-product-tools-')),workspace=join(home,'workspace');mkdirSync(workspace);
const store=new Store(join(home,'test.sqlite')),worker=createResearchWorker({python:'python',scriptPath:resolve('worker/research_worker.py')});
const report={kind:'real tools, worker and public GitHub; no model',at:new Date().toISOString(),checks:[],calls:[]};
const check=(name,ok)=>{report.checks.push({name,ok});if(!ok)throw Error(name);};
try{
 const services=createToolServices({home,store,worker});await installBundledSkills(services.skills,resolve('bundled-skills'));
 const tools=createAgentTools(services,new SearchService(),[],undefined,[workspace]);
 const call=async(name,args)=>{const at=Date.now();try{const result=await tools.execute(name,args,AbortSignal.timeout(120000));report.calls.push({name,args,result,durationMs:Date.now()-at});return result;}catch(e){report.calls.push({name,error:String(e.message),durationMs:Date.now()-at});throw e;}};
 await call('write_file',{path:'evidence.txt',content:'WORKSPACE_READ_OK\nvalue=7'});
 const read=await call('read_file',{path:'evidence.txt'});check('actual-file-read',read.content.includes('WORKSPACE_READ_OK'));
 const search=await call('search_files',{query:'value=7'});check('actual-file-search',search.matches[0].line===2);
 await call('write_file',{path:'evidence.txt',content:'updated',expectedSha256:read.sha256});check('actual-file-update',readFileSync(join(workspace,'evidence.txt'),'utf8')==='updated');
 const made=await call('skill_create',{name:'sum-e2e',description:'Sum input numbers',instructions:'Execute the declared Python entry with the numbers JSON input and report its actual sum.',script:'import json,sys\nprint(json.dumps({"sum":sum(json.loads(sys.argv[1])["numbers"])}))'});
 await call('skill_load',{id:made.skill.id});const execution=await call('skill_run',{id:made.skill.id,input:{numbers:[3,4,5]}});check('created-skill-actually-executes',JSON.parse(execution.result.stdout).sum===12);
 const local=join(workspace,'local-skill');mkdirSync(local);writeFileSync(join(local,'SKILL.md'),'# Local skill\nRead the actual workspace file and report the value.');writeFileSync(join(local,'skill.json'),JSON.stringify({name:'local-e2e',version:'1.0.0',description:'Local file instructions',entry:'SKILL.md',license:'MIT',permissions:[]}));
 const imported=await call('skill_install',{path:'local-skill'});check('local-skill-installs',imported.installed&&imported.executed===false);
 const jsonSkill=services.skills.list().find(x=>x.name==='json-transform');await call('skill_load',{id:jsonSkill.id});const jsonResult=await call('skill_run',{id:jsonSkill.id,input:{value:{keep:7,drop:8},keys:['keep']}});check('bundled-json-skill-actually-executes',JSON.stringify(JSON.parse(jsonResult.result.stdout).value)==='{"keep":7}');
 const upstream=await call('skill_install',{url:'https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/.agents/skills/dsh-error-handling'});
 check('github-skill-pinned-and-hashed',upstream.installed&&upstream.revision==='22ddee3792402c3e70ec5f86a63c3e3e895a2f60'&&upstream.files.every(x=>x.sha256.length===64));
 check('install-never-claims-execution',upstream.executed===false);
}catch(e){report.error=String(e.message);}
finally{await worker.close();store.close();writeFileSync(resolve('../docs/verification/product-340-20261026/tools-e2e.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks,error:report.error}));process.exitCode=report.error?1:0;}
