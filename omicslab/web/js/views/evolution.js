import {api} from '../api.js?v=1.0.0';
import {esc} from '../util.js?v=1.0.0';
import {toastError} from '../ui.js?v=1.0.0';
import {getState} from '../store.js?v=1.0.0';

const labels={planned:'待确认',running:'运行中',failed:'未通过',completed:'实验结束',cancelled:'已取消',interrupted:'已中断'};

export async function mount(root){
  let disposed=false,timer=null,data=null,selected=null,busy=false;
  const scope=getState().workspaceId||'ws_main';
  const base='/api/evolution';
  const request=(path='',options={})=>api.request(`${base}${path}?scope=${encodeURIComponent(scope)}`,options);
  root.innerHTML='<section class="page"><header class="page-head"><h1 class="page-title">自我改进</h1></header>'+
    '<p class="eve-detail-note">在源码副本中改进指令、技能和 Python 源码；工具目录用于操作指导。回归通过的版本用于下一轮实验，当前安装保持不变。</p>'+
    '<p id="evolution-status" role="status"></p><form id="evolution-plan"><label for="evolution-goal">改进目标</label>'+
    '<textarea class="input" id="evolution-goal" required placeholder="例如：减少文献核验中的无效工具调用，保留引用与执行证据。"></textarea>'+
    '<button class="btn btn-sm" type="submit">生成方案</button></form><div id="evolution-plan-detail"></div>'+
    '<section><h2>实验记录</h2><div id="evolution-runs"></div></section><section id="evolution-progress"></section></section>';
  function render(){
    if(disposed||!data)return;
    const ready=data.readiness?.ready??(data.dependency.available&&data.validation_ready);
    root.querySelector('#evolution-status').textContent=ready?'Proteus 已就绪':
      !data.dependency.available?`请安装可选依赖：${data.dependency.install}`:'当前发行目录缺少基线测试，请在完整源码目录中运行实验。';
    if(data.readiness?.issues?.length)root.querySelector('#evolution-status').textContent=data.readiness.issues.map(issue=>`${issue.message} ${issue.action}`).join('\n');
    root.querySelector('#evolution-runs').innerHTML=data.runs.map(run=>`<button class="btn btn-ghost" data-evolution-pick="${esc(run.id)}">${esc(run.plan.goal)} · ${labels[run.status]||esc(run.status)}</button>`).join('')||'<p class="eve-muted">尚无实验</p>';
    const box=root.querySelector('#evolution-plan-detail');
    if(selected){
      const plan=selected.plan;
      box.innerHTML=`<h2>确认方案</h2><p>${esc(plan.goal)}</p><dl><dt>流程</dt><dd>${plan.phases.map(esc).join(' → ')}</dd><dt>范围</dt><dd>${plan.surfaces.map(esc).join('、')}</dd><dt>实验预算</dt><dd>${plan.policy.episodes} 轮 × ${plan.policy.seeds} 个种子；每轮 ${plan.policy.max_turns} 次模型调用</dd><dt>回归门禁</dt><dd>${plan.validation.map(esc).join('、')}</dd></dl>`+
        (selected.status==='planned'?`<button class="btn btn-sm" data-evolution-start ${ready&&!busy?'':'disabled'}>确认并开始</button>`:selected.status==='running'?'<button class="btn btn-sm" data-evolution-stop>停止实验</button>':`<p role="status">${labels[selected.status]||esc(selected.status)} ${esc(selected.error||'')}</p>`);
    }else box.replaceChildren();
  }
  async function load(){
    data=await request();
    if(disposed)return;
    if(selected){
      const detail=await request('/'+selected.id);
      if(disposed)return;
      selected=detail.run;
      root.querySelector('#evolution-progress').innerHTML=detail.progress.map(row=>`<details><summary>第 ${row.episode} 轮 · ${row.ok&&row.accepted?'门禁通过':'未通过'} · ${row.turns} 次调用</summary><ul>${(row.action_metadata||[]).map(action=>`<li>${esc(action.phase)} · ${esc(action.tool||'模型')} · ${esc(action.surface||'')}</li>`).join('')}</ul></details>`).join('');
    }
    render();
    clearTimeout(timer);
    if(!disposed&&data.runs.some(run=>run.status==='running'))timer=setTimeout(()=>load().catch(toastError),data.policy.poll_interval_ms);
  }
  root.querySelector('#evolution-plan').onsubmit=async event=>{
    event.preventDefault();if(busy)return;busy=true;
    try{selected=await request('/plans',{method:'POST',body:{goal:root.querySelector('#evolution-goal').value}});await load();}
    catch(error){toastError(error);}finally{busy=false;render();}
  };
  root.onclick=async event=>{
    const button=event.target.closest('button');if(!button||busy)return;
    try{
      busy=true;
      if(button.dataset.evolutionPick){selected=data.runs.find(run=>run.id===button.dataset.evolutionPick);await load();}
      else if(button.hasAttribute('data-evolution-start')){selected=await request(`/${selected.id}/start`,{method:'POST',body:{plan_hash:selected.plan_hash}});await load();}
      else if(button.hasAttribute('data-evolution-stop')){selected=await request(`/${selected.id}/stop`,{method:'POST',body:{}});await load();}
    }catch(error){toastError(error);}finally{busy=false;render();}
  };
  await load();
  return {destroy(){disposed=true;clearTimeout(timer);root.onclick=null;const form=root.querySelector('#evolution-plan');if(form)form.onsubmit=null;}};
}
