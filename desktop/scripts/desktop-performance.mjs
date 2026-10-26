/** Paired actual Electron owner/daemon measurements; no model requests. */
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),require=createRequire(join(root,'package.json'));
const {_electron}=require('playwright-core'),{rpc}=await import('../dist/src/rpc.js');
const baselineFile=join(root,'../docs/verification/release-1.0/baseline-source.txt');
const baseline=process.argv.find(x=>x.startsWith('--baseline='))?.slice(11)??(existsSync(baselineFile)?readFileSync(baselineFile,'utf8').trim():null);
if(!baseline)throw Error('Pass --baseline=PATH to a separately built baseline source checkout');
const formal=process.argv.includes('--formal');
const only=process.argv.find(x=>x.startsWith('--only='))?.slice(7);
const output=process.argv.find(x=>x.startsWith('--output='))?.slice(9);
const idleMs=Number(process.argv.find(x=>x.startsWith('--idle-ms='))?.slice(10)??10_000);
if(!Number.isFinite(idleMs)||idleMs<1_000||idleMs>120_000)throw Error('--idle-ms must be between 1000 and 120000');
const report={kind:formal?`paired real formal workbench, daemon, legacy bridge and renderers; hidden idle for ${idleMs/1000} seconds`:`paired real Electron native diagnostic console and daemon; hidden idle for ${idleMs/1000} seconds; formal renderer excluded`,runs:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function counters(ids){
  const unique=[...new Set(ids.map(Number).filter(Number.isSafeInteger))];
  if(!unique.length)return [];
  const command=`$rows=@(Get-Process -Id @(${unique.join(',')}) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,@{n='cpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}}); if($rows.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject @($rows) -Compress}`;
 const result=spawnSync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8'});
 if(result.status!==0)throw Error('OS process counters unavailable');
 const data=JSON.parse(result.stdout);return Array.isArray(data)?data:[data];
}
async function threadDeltas(pid,windowMs){
  const command=String.raw`
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class SuWenThreadTimes {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenThread(uint access,bool inherit,uint id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetThreadTimes(IntPtr handle,out long creation,out long exit,out long kernel,out long user);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationThread(IntPtr handle,int infoClass,out IntPtr info,int infoLength,IntPtr returnLength);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Dictionary<uint,long> Sample(int pid) {
    var values=new Dictionary<uint,long>();
    using(var process=Process.GetProcessById(pid)) foreach(ProcessThread thread in process.Threads) {
      var handle=OpenThread(0x0040,false,(uint)thread.Id);
      if(handle==IntPtr.Zero)continue;
      try { long creation,exit,kernel,user; if(GetThreadTimes(handle,out creation,out exit,out kernel,out user))values[(uint)thread.Id]=kernel+user; }
      finally { CloseHandle(handle); }
    }
    return values;
  }
  public static long StartAddress(uint id) {
    var handle=OpenThread(0x0040,false,id);
    if(handle==IntPtr.Zero)return 0;
    try { IntPtr address; return NtQueryInformationThread(handle,9,out address,IntPtr.Size,IntPtr.Zero)==0?address.ToInt64():0; }
    finally { CloseHandle(handle); }
  }
}
'@
$previous=[SuWenThreadTimes]::Sample(${Number(pid)})
$totals=@{}
$addresses=@{}
$deadline=[DateTime]::UtcNow.AddMilliseconds(${Math.max(250,Number(windowMs))})
while([DateTime]::UtcNow -lt $deadline){
  Start-Sleep -Milliseconds 100
  $current=[SuWenThreadTimes]::Sample(${Number(pid)})
  foreach($threadId in $current.Keys){
    if($previous.ContainsKey($threadId)){
      if(!$totals.ContainsKey($threadId)){$totals[$threadId]=[long]0;$addresses[$threadId]=[SuWenThreadTimes]::StartAddress([uint32]$threadId)}
      $totals[$threadId]+=[Math]::Max(0,$current[$threadId]-$previous[$threadId])
    }
  }
  $previous=$current
}
$rows=@()
foreach($threadId in $totals.Keys){$rows+=@{id=[int]$threadId;cpuMs=[Math]::Round($totals[$threadId]/10000.0,3);startAddress=$addresses[$threadId]}}
ConvertTo-Json -InputObject @($rows) -Compress`;
  return await new Promise((resolveResult,rejectResult)=>{
    const child=spawn('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
    const timer=setTimeout(()=>{child.kill();rejectResult(new Error('Thread sampling timed out'));},Math.max(15_000,windowMs+10_000));
    child.on('error',rejectResult);
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0)return rejectResult(new Error(`Thread sampling failed: ${stderr.slice(-500)}`));
      try{const data=JSON.parse(stdout||'[]');resolveResult(Array.isArray(data)?data:[data]);}catch{rejectResult(new Error('Thread sampling returned invalid JSON'));}
    });
  });
}
function processTree(rootPid){
  const command=`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) -Compress`;
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8',timeout:30000});
  if(result.status!==0)return[];
  const rows=JSON.parse(result.stdout||'[]');
  const children=new Map();
  for(const row of rows){const parent=Number(row.ParentProcessId);if(!children.has(parent))children.set(parent,[]);children.get(parent).push({pid:Number(row.ProcessId),parent,name:String(row.Name)});}
  const found=[],queue=[Number(rootPid)],seen=new Set();
  while(queue.length){const parent=queue.shift();if(seen.has(parent))continue;seen.add(parent);for(const child of children.get(parent)??[]){found.push(child);queue.push(child.pid);}}
  return found;
}
function processModules(pid){
  const command=String.raw`
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$process=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
$rows=@()
if($process){foreach($module in $process.Modules){
  $info=$module.FileVersionInfo
  $signature=$null
  try{$signature=Get-AuthenticodeSignature -LiteralPath $module.FileName -ErrorAction Stop}catch{}
  $rows+=@{
    name=[string]$module.ModuleName
    base=[long]$module.BaseAddress.ToInt64()
    size=[int]$module.ModuleMemorySize
    company=[string]$info.CompanyName
    product=[string]$info.ProductName
    version=[string]$info.FileVersion
    signature=[string]$signature.Status
    signer=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Subject}else{''}
  }
}}
ConvertTo-Json -InputObject @($rows) -Compress`;
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8',timeout:15_000});
  if(result.status!==0)return[];
  const data=JSON.parse(result.stdout||'[]');return Array.isArray(data)?data:[data];
}
function attributeThreads(threads,modules){
  return threads.map(thread=>{
    const address=Number(thread.startAddress);
    const module=modules.find(item=>address>=Number(item.base)&&address<Number(item.base)+Number(item.size));
    return {
      id:thread.id,
      cpuMs:thread.cpuMs,
      module:module?{
        name:module.name,
        offset:address-Number(module.base),
        company:module.company,
        product:module.product,
        version:module.version,
        signature:module.signature,
        signer:module.signer,
      }:null,
    };
  });
}
function counterMap(rows){return new Map(rows.map(row=>[Number(row.Id),row]));}
function processReading(role,pid,before,after,elapsedMs,extra={}){
  const first=before.get(pid),last=after.get(pid);
  return {
    role,pid,
    processName:last?.ProcessName??first?.ProcessName??null,
    workingSetMB:last?Math.round(last.WorkingSet64/1048576*10)/10:null,
    cpuOneCorePercent:first&&last&&elapsedMs>0?Math.max(0,(Number(last.cpuMs)-Number(first.cpuMs))/elapsedMs*100):null,
    ...extra,
  };
}
for(const [label,directory] of [['before',join(baseline,'desktop')],['after',root]].filter(([label])=>!only||label===only)){
 const profile=mkdtempSync(join(tmpdir(),'suwen-performance-'));writeFileSync(join(profile,'desktop-window.json'),JSON.stringify({closeAction:'quit'}));
  let app,connection,page;const entry={label,scope:report.kind};
 try{
  const env={...process.env,SUWEN_TEST_HOME:profile};delete env.ELECTRON_RUN_AS_NODE;
  const started=performance.now();app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:formal?[directory]:[directory,'--native'],env});
   if(formal){for(let i=0;i<180;i++){page=app.windows().find(p=>p.url().startsWith('http://127.0.0.1:'));if(page)break;await sleep(500);}if(!page)throw Error('Formal workbench unavailable');await page.waitForSelector('#chat-input',{timeout:60000});}
   else{page=await app.firstWindow();await page.waitForFunction(()=>window.suwen&&document.getElementById('health'));}
  entry.startupMs=Math.round(performance.now()-started);
  connection=JSON.parse(readFileSync(join(profile,'runtime/connection.json'),'utf8'));entry.daemonPid=connection.pid;entry.stage='create-tasks';
  const tasks=[];for(let i=0;i<10;i++)tasks.push(await rpc(connection,'create',{name:'measurement-'+i,steps:[{id:'echo',kind:'echo',input:{text:'sample-data-'.repeat(80)}}]}));
   let tasksCompleted=false;
   for(let i=0;i<150;i++){const current=await rpc(connection,'snapshot');tasksCompleted=tasks.every(task=>current.tasks.find(item=>item.id===task.id)?.status==='completed');if(tasksCompleted)break;await sleep(100);}
   if(!tasksCompleted)throw Error('Ten measurement tasks did not complete within 15 seconds');
  entry.stage='snapshot';const latency=[];let snapshot;
  for(let i=0;i<5;i++){const start=performance.now();snapshot=await rpc(connection,'snapshot');latency.push(performance.now()-start);}
  entry.fullSnapshotBytes=Buffer.byteLength(JSON.stringify(snapshot));entry.fullSnapshotLatencyMs=latency;
  entry.stage='single-snapshot';if(label==='after'){
   const start=performance.now(),task=await rpc(connection,'task.snapshot',{id:tasks[0].id});entry.singleTaskSnapshotBytes=Buffer.byteLength(JSON.stringify(task));entry.singleTaskSnapshotMs=performance.now()-start;
  }
   entry.stage='idle';
   const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>({id:window.id,pid:window.webContents.getOSProcessId(),title:window.getTitle(),url:window.webContents.getURL()})));
   entry.windowCount=windows.length;entry.rendererPids=[...new Set(windows.map(window=>window.pid))];
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await sleep(1500);
   const mainPid=await app.evaluate(()=>process.pid);entry.mainPid=mainPid;
   const healthBefore=await rpc(connection,'health');
   const legacyPid=Number(healthBefore.legacy?.pid);
   const measuredIds=[mainPid,connection.pid,...entry.rendererPids,...(Number.isSafeInteger(legacyPid)&&legacyPid>0?[legacyPid]:[])];
   const descendantsBefore=processTree(connection.pid);
   const before=counters([...measuredIds,...descendantsBefore.map(process=>process.pid)]);
   const mainBefore=await app.evaluate(()=>({cpu:process.cpuUsage(),electron:process.getCPUUsage(),eventLoop:performance.eventLoopUtilization()}));
   const wall=performance.now();
   const daemonThreadsPromise=threadDeltas(connection.pid,idleMs);
   const mainThreadsPromise=threadDeltas(mainPid,idleMs);
   await sleep(idleMs);
  const healthAfter=await rpc(connection,'health');
  const mainAfter=await app.evaluate((_electron,before)=>({
    cpu:process.cpuUsage(before.cpu),
    electron:process.getCPUUsage(),
    eventLoop:performance.eventLoopUtilization(before.eventLoop),
  }),{cpu:mainBefore.cpu,eventLoop:mainBefore.eventLoop});
  const descendantsAfter=processTree(connection.pid);
  const after=counters([...measuredIds,...descendantsBefore.map(process=>process.pid),...descendantsAfter.map(process=>process.pid)]),elapsed=performance.now()-wall;
  const first=counterMap(before),last=counterMap(after);
  const [daemonThreads,mainThreads]=await Promise.all([daemonThreadsPromise,mainThreadsPromise]);
  const [daemonModules,mainModules]=[processModules(connection.pid),processModules(mainPid)];
  entry.daemonThreadSample=attributeThreads(daemonThreads.filter(thread=>thread.cpuMs>0).sort((a,b)=>b.cpuMs-a.cpuMs).slice(0,20),daemonModules);
  entry.mainThreadSample=attributeThreads(mainThreads.filter(thread=>thread.cpuMs>0).sort((a,b)=>b.cpuMs-a.cpuMs).slice(0,20),mainModules);
  entry.daemonThreadCount=daemonThreads.length;
  const daemonStart=healthBefore.cpuUsageMs,daemonEnd=healthAfter.cpuUsageMs;
  const daemonCpu=daemonStart&&daemonEnd
    ? ((daemonEnd.user+daemonEnd.system)-(daemonStart.user+daemonStart.system))/elapsed*100
    : null;
  const daemonEluBefore=healthBefore.eventLoopUtilization,daemonEluAfter=healthAfter.eventLoopUtilization;
  entry.idleWindowMs=Math.round(elapsed);
  entry.processes=[
    processReading('main',mainPid,first,last,elapsed,{electronReportedPercent:mainAfter.electron.percentCPUUsage,eventLoopUtilization:mainAfter.eventLoop.utilization}),
    processReading('daemon',connection.pid,first,last,elapsed,{daemonSelfCpuOneCorePercent:daemonCpu,eventLoopUtilization:daemonEluBefore&&daemonEluAfter?((daemonEluAfter.active-daemonEluBefore.active)/((daemonEluAfter.active-daemonEluBefore.active)+(daemonEluAfter.idle-daemonEluBefore.idle))):null}),
    ...entry.rendererPids.map(pid=>processReading('renderer',pid,first,last,elapsed)),
    ...(Number.isSafeInteger(legacyPid)&&legacyPid>0?[processReading('legacy-bridge',legacyPid,first,last,elapsed)]:[]),
  ];
  const workingSets=entry.processes.map(process=>process.workingSetMB).filter(Number.isFinite);
  entry.trackedWorkingSetMB=Math.round(workingSets.reduce((sum,value)=>sum+value,0)*10)/10;
  entry.daemonRpcCallsDuringIdle=Object.fromEntries(Object.keys(healthAfter.rpcCalls??{}).map(name=>[name,(healthAfter.rpcCalls?.[name]??0)-(healthBefore.rpcCalls?.[name]??0)]).filter(([,value])=>value!==0));
  entry.daemonCpuUsageRaw={before:daemonStart??null,after:daemonEnd??null};
  entry.scheduler=healthAfter.scheduler??null;
  const descendantsByPid=new Map([...descendantsBefore,...descendantsAfter].map(process=>[process.pid,process]));
  entry.daemonDescendants=[...descendantsByPid.values()].map(process=>({
    ...process,
    workingSetMB:last.get(process.pid)?Math.round(last.get(process.pid).WorkingSet64/1048576*10)/10:null,
    cpuOneCorePercent:first.has(process.pid)&&last.has(process.pid)?Math.max(0,(Number(last.get(process.pid).cpuMs)-Number(first.get(process.pid).cpuMs))/elapsed*100):null,
  }));
  entry.mainTimerLag=await app.evaluate(()=>new Promise(resolve=>{const delays=[];let last=performance.now();const timer=setInterval(()=>{const now=performance.now();delays.push(Math.max(0,now-last-10));last=now;if(delays.length===50){clearInterval(timer);delays.sort((a,b)=>a-b);resolve({p50Ms:delays[24],p95Ms:delays[47]});}},10);}));
  entry.rendererTimerLag=await page.evaluate(()=>new Promise(resolve=>{const delays=[];let last=performance.now();const timer=setInterval(()=>{const now=performance.now();delays.push(Math.max(0,now-last-10));last=now;if(delays.length===50){clearInterval(timer);delays.sort((a,b)=>a-b);resolve({p50Ms:delays[24],p95Ms:delays[47]});}},10);}));
 }catch(error){entry.error=error.message;try{entry.daemonLog=readFileSync(join(profile,'runtime/daemon.log'),'utf8').slice(-4000);}catch{}}
 finally{try{if(connection)await rpc(connection,'shutdown');}catch{}if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
 report.runs.push(entry);console.log(JSON.stringify(entry));
}
const reportPath=output?resolve(root,output):join(root,'../docs/verification/release-1.0/'+(formal?'desktop-performance-formal.json':'desktop-performance.json'));
writeFileSync(reportPath,JSON.stringify(report,null,2));
process.exit(report.runs.some(r=>r.error)?1:0);
