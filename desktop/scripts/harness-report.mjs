/** Regenerate evidence summaries without changing raw cohorts or acceptance rules.
 * Run after benchmark --phase=verified-final and final UI checks have finished. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {citationUrls} from '../dist/src/harness/agent-loop.js';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const out=resolve(root,'docs/verification/harness-20261025');
const read=name=>JSON.parse(readFileSync(resolve(out,name),'utf8'));
const save=(name,data)=>writeFileSync(resolve(out,name),JSON.stringify(data,null,2)+'\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const tasksBytes=readFileSync(resolve(root,'desktop/scripts/harness-tasks.json'));
const tasks=JSON.parse(tasksBytes),hash=sha(tasksBytes),before=read('baseline.json'),after=read('verified-final.json');
for(const cohort of [before,after]){
 if(!cohort.finishedAt||cohort.model!==after.model||cohort.taskSetSha256!==hash||cohort.results.length!==tasks.length||new Set(cohort.results.map(x=>x.id)).size!==tasks.length||tasks.some(x=>!cohort.results.some(y=>x.id===y.id)))throw new Error('Cohort incomplete, model differs or task set differs');
}
const traces=t=>t.trace?.length?t.trace:(t.events??[]).filter(x=>/^(tool\.|model\.|agent\.)/.test(x.type)&&x.data?.traceId).map(x=>({...x.data,type:x.type,at:x.at}));
const percentile=(xs,p)=>{const sorted=[...xs].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;};
const metrics=cohort=>{
 const events=cohort.results.flatMap(traces),failed=events.filter(x=>x.type==='tool.failed');
 const recovered=cohort.results.reduce((sum,t)=>sum+traces(t).filter((x,i,all)=>x.type==='tool.failed'&&all.slice(i+1).some(y=>y.type==='tool.completed'&&y.name===x.name)).length,0);
 return {...cohort.metrics,passed:cohort.results.filter(x=>x.status==='passed').length,total:cohort.results.length,toolCompleted:events.filter(x=>x.type==='tool.completed').length,toolFailed:failed.length,recovery:{recovered,failed:failed.length},successfulLatency:{count:cohort.results.filter(x=>x.status==='passed').length,p50Ms:percentile(cohort.results.filter(x=>x.status==='passed').map(x=>x.latencyMs),.5),p95Ms:percentile(cohort.results.filter(x=>x.status==='passed').map(x=>x.latencyMs),.95)}};
};
const b=metrics(before),a=metrics(after),mentions=after.results.flatMap(t=>t.verification?.citationUrls??[]);
const invalid=after.results.flatMap(t=>{const urls=new Set((t.sources??[]).flatMap(s=>citationUrls(s.url)));return (t.verification?.citationUrls??[]).filter(url=>!urls.has(url)).map(url=>({task:t.id,url}));});
const threshold=Math.ceil(tasks.length*.9),formal=read('formal-ui.json'),races=read('conversation-race-ui.json');
const realPassed=a.passed>=threshold&&invalid.length===0,formalPassed=formal.packaged===true&&formal.kind.startsWith('real external model')&&!formal.error&&formal.checks.length===8&&formal.checks.every(x=>x.ok);
const ui=existsSync(resolve(out,'streaming-ui-verified.json'))?read('streaming-ui-verified.json'):null;
const routes=existsSync(resolve(out,'workbench-routes-verified.json'))?read('workbench-routes-verified.json'):null;
const routesPassed=routes?.summary?.status==='PASS'&&routes.summary.checks.PASS===34;
const streamPassed=Boolean(ui&&ui.findings.length===0&&ui.scenarios.composer?.pass?.draftPreserved&&ui.scenarios.composer.pass.composerStable&&ui.scenarios.scroll?.pass?.scrollUpStable&&ui.scenarios.scroll.pass.composerStable&&['concurrent','persistence'].every(name=>ui.scenarios[name]?.pass&&Object.values(ui.scenarios[name].pass).every(x=>x===true)));
const racePassed=!races.error&&races.checks.length===4&&races.checks.every(x=>x.ok);
const windows=read('window-lifecycle-fixed.json'),windowsPackaged=read('window-lifecycle-packaged.json');
const windowsPassed=[windows,windowsPackaged].every(r=>r.results.length===4&&r.results.every(x=>x.ok&&x.errors.length===0));
const unitLog=readFileSync(resolve(out,'verified-window-unit-tests.txt'),'utf8');
const count=label=>{const match=unitLog.match(new RegExp(`^ℹ ${label} (\\d+)\\r?$`,'m'));if(!match)throw new Error('Missing unit result '+label);return Number(match[1]);};
const unit={passed:count('pass'),skipped:count('skipped'),failed:count('fail'),evidence:'verified-window-unit-tests.txt'};
const pythonLog=readFileSync(resolve(out,'resumed-python-tests.txt'),'utf8');
if(!/261 passed/.test(pythonLog)||!readFileSync(resolve(out,'verified-rpc-integration.txt'),'utf8').includes('42 passed, 0 failed, 42 checks'))throw new Error('Regression evidence missing');
const packageJson=JSON.parse(readFileSync(resolve(root,'desktop/package.json'),'utf8'));
const installerPath=resolve(root,`desktop/release/SuWen-Setup-${packageJson.version}-win-x64.exe`);
const installer=readFileSync(installerPath);
const release={version:packageJson.version,path:installerPath,bytes:installer.length,sha256:sha(installer),signed:false,cleanWindowsVmInstall:'NOT_RUN',baselineInstallerRetained:true,packagedUiE2E:formalPassed?'8/8 real external model + real PubMed, formal-ui.json':'NOT_PASSED',buildProvenance:'Working tree; unrelated concurrent omicslab/cli.py and omicslab/integrations files preserved and not owned by this change.',buildCommand:'npx --no-install electron-builder --win nsis --x64 --config.electronDist=node_modules/electron/dist'};
save('release.json',release);writeFileSync(resolve(out,'SHA256SUMS.txt'),`${release.sha256}  SuWen-Setup-${release.version}-win-x64.exe\n`);
save('comparison.json',{model:after.model,taskSetSha256:hash,baseline:b,initialAfter:read('final.json').metrics,resumedBeforeCitationFix:metrics(read('resumed-final.json')),after:a,acceptance:realPassed&&formalPassed?'FIXED_COHORT_AND_FORMAL_REAL_MODEL_PASSED':'NOT_MET',toolSuccessRate:a.toolCompleted/(a.toolCompleted+a.toolFailed),toolRecoverySameName:a.recovery,citationProvenance:{verifiedUrlMentions:mentions.length,uniqueUrls:new Set(mentions).size,invalid,semanticAccuracy:'not exhaustively validated'},uiExceptions:{baseline:['scrollUpDrift=14363.3px','scroll-scenario composerDelta=1078px','persistence scenario timed out'],after:ui?{findings:ui.findings,composer:ui.scenarios.composer?.composerMaxDeltaPx,scroll:ui.scenarios.scroll?.scroll,persistence:ui.scenarios.persistence?.pass}:'NOT_RUN'}});
save('acceptance.json',{status:realPassed&&formalPassed&&routesPassed&&streamPassed&&racePassed&&windowsPassed&&unit.failed===0?'FIXED_COHORT_AND_CORE_UI_PASSED_WITH_LIMITATIONS':'INCOMPLETE',at:new Date().toISOString(),realTasks:{passed:a.passed,total:a.total,target:threshold,evidence:'verified-final.json'},unit,python:{passed:261,failed:0,evidence:'resumed-python-tests.txt'},rpcIntegration:{passed:42,failed:0,evidence:'verified-rpc-integration.txt'},formalPackaged:{passed:formal.checks.filter(x=>x.ok).length,failed:formal.checks.filter(x=>!x.ok).length,realModel:formalPassed,evidence:'formal-ui.json'},workbenchRoutes:{passed:routes?.summary?.checks?.PASS??0,failed:routes?.summary?.checks?.FAIL??0,evidence:'workbench-routes-verified.json'},conversationRace:{passed:races.checks.filter(x=>x.ok).length,failed:races.checks.filter(x=>!x.ok).length,evidence:'conversation-race-ui.json'},windowLifecycle:{passed:windowsPassed,evidence:['window-lifecycle-fixed.json','window-lifecycle-packaged.json']},streaming:{passed:streamPassed,findings:ui?.findings??null,evidence:'streaming-ui-verified.json'},installer:release,finalRealModelRevalidation:'Completed for unchanged final model/tool source; subsequent UI and window-only fixes validated separately.',allRequestedP0CapabilitiesClosed:false,remainingScope:'See open-issues.md: continuous virtualization, semantic Skill matching, all scientific routes, broader MCP interoperability and clean Windows install are not fully validated.'});
const csv=v=>'"'+String(v??'').replaceAll('"','""')+'"';
const rows=[['id','category','prompt','required_tools','baseline','initial_after','resumed_before_fix','after','latency_before_ms','latency_after_ms','model','evidence','unverified']];
for(const task of tasks){const t=after.results.find(x=>x.id===task.id),old=before.results.find(x=>x.id===task.id);rows.push([task.id,task.category,task.prompt,task.tools.join('|'),old.status,read('final.json').results.find(x=>x.id===task.id)?.status,read('resumed-final.json').results.find(x=>x.id===task.id)?.status,t.status,old.latencyMs,t.latencyMs,after.model,`verified-final.json#${task.id}`,t.status==='passed'?'':t.error]);}
writeFileSync(resolve(out,'test-matrix.csv'),rows.map(row=>row.map(csv).join(',')).join('\n')+'\n');
const sourceHashes=read('source-sha256.json');for(const path of Object.keys(sourceHashes))sourceHashes[path]=sha(readFileSync(resolve(root,path)));save('source-sha256.json',sourceHashes);
console.log(JSON.stringify({realTasks:a.passed+'/'+a.total,formalPassed,routesPassed,streamPassed,racePassed,windowsPassed,toolSuccessRate:a.toolCompleted/(a.toolCompleted+a.toolFailed),citations:mentions.length,invalidCitations:invalid.length,releaseSha256:release.sha256}));
if(read('acceptance.json').status==='INCOMPLETE')process.exitCode=1;
