import {esc,escAttr,setPref} from '../util.js?v=1.2.0';
import {navigate} from '../store.js?v=1.2.0';
import {openModal,toastError} from '../ui.js?v=1.2.0';

const kinds={fasta:'序列',fastq:'FASTQ 质控',counts:'计数矩阵',structure:'蛋白结构'};
const names={reads:'读数',bases:'碱基数',lengthMin:'最短读长',lengthMax:'最长读长',gcFraction:'GC 比例',
 nFraction:'N 比例',q30Fraction:'Q30 比例',meanPhred:'平均 Phred',features:'特征数',zeroFraction:'零值比例',atomCount:'原子数'};
const labels={numpy:'NumPy',pandas:'pandas',scipy:'SciPy',matplotlib:'Matplotlib',scanpy:'Scanpy',anndata:'AnnData',scvi:'scvi-tools',Bio:'Biopython',rdkit:'RDKit',allotropy:'Allotropy',pysam:'pysam',pydeseq2:'PyDESeq2',torch:'PyTorch'};
const metric=(key,value)=>`<div class="science-metric"><span>${esc(names[key]||key)}</span><strong>${esc(key.endsWith('Fraction')?(value*100).toFixed(1)+'%':Number(value).toLocaleString(undefined,{maximumFractionDigits:2}))}</strong></div>`;

export async function mountScienceWorkbench(root,{request}){
 const controller=new AbortController();let disposed=false,kind='fasta',busy=false;
 root.innerHTML=`<section class="sw-card"><header><div><h2>科学工作台</h2><p class="sw-muted">选择研究流程，或先检查当前工作区的数据。</p></div><button type="button" class="btn btn-sm" data-science-env>检查执行环境</button></header><div id="science-host" class="sw-muted">读取工作区…</div><div id="science-environment" aria-live="polite"></div></section>
 <div id="science-lanes" class="science-lanes" aria-label="科研流程"></div>
 <section class="sw-card"><header><h3>数据检查与预览</h3><span class="sw-badge">只读 · 本地 / SSH</span></header>
 <div class="science-kind" role="group" aria-label="数据类型">${Object.entries(kinds).map(([id,label])=>`<button type="button" class="btn btn-sm ${id===kind?'is-active':''}" data-science-kind="${id}" aria-pressed="${id===kind}">${label}</button>`).join('')}</div>
 <form id="science-inspect-form" class="science-path"><label class="sw-field"><span>当前工作区内的文件路径</span><input class="input" id="science-path" required autocomplete="off" placeholder="例如 data/sequences.fasta"/></label><button type="submit" class="btn btn-primary">检查数据</button></form>
 <p class="sw-muted">文本预览上限 5 MB。FASTQ 按 Phred+33 检查；完整分析在科研流程中运行。</p>
 <div id="science-preview" aria-live="polite"></div></section>`;
 const output=root.querySelector('#science-preview'),env=root.querySelector('#science-environment');
 let workflows=[];
 async function load(){
  const data=await request('/science');if(disposed)return;
  workflows=data.workflows;
  root.querySelector('#science-host').textContent=`${data.backend==='ssh'?'远程 SSH':'本地'} · ${data.root} · ${data.skills} 个技能`;
  root.querySelector('#science-lanes').innerHTML=workflows.map(flow=>{
   const ready=flow.skills.filter(s=>s.installed&&s.enabled);
   return `<article class="sw-card science-lane"><h3>${esc(flow.label)}</h3><p>${esc(flow.description)}</p><div class="science-lane-footer"><span class="sw-muted">${ready.length}/${flow.skills.length} 项技能已启用</span><button type="button" class="btn btn-sm" data-science-launch="${escAttr(flow.id)}" ${ready.length?'':'disabled'}>开始</button></div><details><summary>技能与交付</summary><ul>${flow.skills.map(s=>`<li><button type="button" class="btn btn-ghost btn-sm" data-science-skill="${escAttr(s.name)}" ${s.installed?'':'disabled'}>${esc(s.name)}</button><small>${!s.installed?'未安装':!s.enabled?'已停用':s.executable?'含计算入口':'流程指引'}</small></li>`).join('')}</ul><p>${flow.deliverables.map(esc).join(' · ')}</p></details></article>`;
  }).join('');
 }
 root.addEventListener('click',async event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.scienceKind){
   kind=target.dataset.scienceKind;
   root.querySelectorAll('[data-science-kind]').forEach(node=>{node.classList.toggle('is-active',node===target);node.setAttribute('aria-pressed',String(node===target));});
  }
  if(target.dataset.scienceSkill)navigate('skills',{skillName:target.dataset.scienceSkill});
  if(target.hasAttribute('data-science-env')){
   if(target.disabled)return;target.disabled=true;env.textContent='正在检查当前主机…';
   try{
    const data=await request('/science/inspect','POST',{kind:'environment'});if(disposed)return;
    env.innerHTML=`<p>Python ${esc(data.python)} · 当前主机内核与 PATH，独立技能环境另行检查。</p><div class="science-dependencies">${Object.entries({...data.modules,...data.tools}).map(([name,available])=>`<span class="sw-badge" data-available="${available}">${esc(labels[name]||name)} · ${available?'已发现':'未发现'}</span>`).join('')}</div><p class="sw-muted">这里只检测可用性，未安装软件，也未提交计算任务。</p>`;
   }catch(error){if(!disposed){env.textContent='环境检查失败，未切换执行主机。';toastError(error.message);}}
   finally{target.disabled=false;}
  }
  if(target.dataset.scienceLaunch){
   const flow=workflows.find(x=>x.id===target.dataset.scienceLaunch);
   openModal({title:flow.label,size:'lg',html:`<label class="sw-field"><span>研究问题</span><textarea class="input" id="science-goal" rows="4" maxlength="8000"></textarea></label><label class="sw-field"><span>文件路径、样本信息与约束</span><textarea class="input" id="science-inputs" rows="3" maxlength="4000"></textarea></label><p class="sw-muted">任务使用当前工作区，默认请求批准。开始后可在任务中继续补充要求。</p>`,actions:[{label:'取消'},{label:'启动任务',kind:'primary',onClick:async({body})=>{
    try{
     const result=await request('/science/launch','POST',{lane:flow.id,goal:body.querySelector('#science-goal').value,inputs:body.querySelector('#science-inputs').value});
     if(disposed)return true;
     setPref('activeConversationId',result.session_id);navigate('workbench');return true;
    }catch(error){toastError(error.message);return false;}
   }}]});
  }
 },{signal:controller.signal});
 root.querySelector('#science-inspect-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;
  const button=event.submitter,selected=kind;
  button.disabled=true;output.textContent='正在检查数据…';
  try{
   const data=await request('/science/inspect','POST',{kind:selected,path:root.querySelector('#science-path').value.trim()});
   if(disposed)return;
   output.innerHTML=preview(data);
   if(data.kind==='structure')mountStructure(output.querySelector('canvas'),data.atoms,controller.signal);
  }catch(error){if(!disposed){output.textContent='检查未通过：'+error.message;toastError(error.message);}}
  finally{busy=false;button.disabled=false;}
 },{signal:controller.signal});
 await load();
 return {destroy(){disposed=true;controller.abort();}};
}

function preview(data){
 const metrics=Object.entries(data).filter(([key,value])=>key in names&&typeof value==='number');
 let html=`<div class="science-metrics">${metrics.map(([key,value])=>metric(key,value)).join('')}</div>`;
 if(data.records)html+=`<div class="science-sequences" aria-label="序列预览">${data.records.map(record=>`<div><strong>${esc(record.id)}</strong><small>${record.length} 位 · ${record.alphabet==='protein'?'蛋白':'核酸'}${record.previewTruncated?' · 预览已截断':''}</small><pre>${[...record.sequence].map(c=>`<span data-base="${/[ACGT]/.test(c)?c:'other'}">${esc(c)}</span>`).join('')}</pre></div>`).join('')}</div><p class="sw-muted">保留输入序列与缺口；等长序列不代表已完成生物学比对。</p>`;
 if(data.librarySizes){
  const max=Math.max(1,...data.librarySizes);
  html+=`<div class="science-bars" aria-label="样本文库大小">${data.samples.map((name,i)=>`<div><span>${esc(name)}</span><meter min="0" max="${max}" value="${data.librarySizes[i]}">${data.librarySizes[i]}</meter><strong>${Number(data.librarySizes[i]).toLocaleString()}</strong></div>`).join('')}</div>`;
 }
 if(data.atoms)html+=`<canvas class="science-structure" width="900" height="400" aria-label="PDB 三维坐标预览，可拖动旋转" tabindex="0"></canvas><p class="sw-muted">拖动旋转，方向键微调。显示首个模型的 ${data.atoms.length}/${data.atomCount} 个原子；不推断化学键或结构质量。</p>`;
 const note=data.kind==='fastq'?'基础质量检查按 Phred+33 解释；未检查接头、重复、污染或实验设计。':data.kind==='counts'?'这是原始计数检查，尚未开展差异分析；仍需样本分组、独立生物重复与协变量。':'输入已检查，科学结论仍需复核。';
 return html+`<p class="sw-muted">${note}</p><details><summary>来源与校验值</summary><p>${esc(data.workspace)} / ${esc(data.path)}</p><code>${esc(data.sha256)}</code><p>${Number(data.bytes).toLocaleString()} 字节</p></details>`;
}

function mountStructure(canvas,atoms,signal){
 let yaw=0,pitch=0,drag=null;
 const center=[0,1,2].map(axis=>atoms.reduce((sum,a)=>sum+a.xyz[axis],0)/atoms.length);
 const points=atoms.map(a=>({element:a.element,xyz:a.xyz.map((x,i)=>x-center[i])}));
 const extent=Math.max(1,...points.map(a=>Math.hypot(...a.xyz)));
 function draw(){
  const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);
  const projected=points.map(a=>{
   const [x,y,z]=a.xyz,xx=x*Math.cos(yaw)-z*Math.sin(yaw),zz=x*Math.sin(yaw)+z*Math.cos(yaw);
   return {x:xx,y:y*Math.cos(pitch)-zz*Math.sin(pitch),z:y*Math.sin(pitch)+zz*Math.cos(pitch),element:a.element};
  }).sort((a,b)=>a.z-b.z);
  for(const p of projected){
   ctx.fillStyle=({N:'#597ca7',O:'#be6b68',S:'#b59b50'})[p.element]||'#85918f';
   ctx.beginPath();ctx.arc(w/2+p.x/extent*h*.42,h/2-p.y/extent*h*.42,2.5+(p.z/extent+1)*1.5,0,Math.PI*2);ctx.fill();
  }
 }
 canvas.addEventListener('pointerdown',event=>{drag=[event.clientX,event.clientY];canvas.setPointerCapture(event.pointerId);},{signal});
 canvas.addEventListener('pointermove',event=>{if(!drag)return;yaw+=(event.clientX-drag[0])*.01;pitch+=(event.clientY-drag[1])*.01;drag=[event.clientX,event.clientY];draw();},{signal});
 for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,()=>{drag=null;},{signal});
 canvas.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();yaw+=event.key==='ArrowLeft'?-.1:event.key==='ArrowRight'?.1:0;pitch+=event.key==='ArrowUp'?-.1:event.key==='ArrowDown'?.1:0;draw();},{signal});
 draw();
}
