import {api} from './api.js?v=1.4.0';
import {esc,escAttr} from './util.js?v=1.4.0';
import {openModal,toastError} from './ui.js?v=1.4.0';

export async function chooseComposerSkills(input){
 const data=await api.skills.list(),skills=(data.skills||data).filter(s=>s.enabled!==false);
 const chosen=new Set(),modal=openModal({title:'为当前任务选择技能',size:'lg',html:'<input class="input" data-skill-query aria-label="搜索任务技能" placeholder="搜索名称、科研方向或工具…"/><p class="sw-muted">最多选择三项。发送任务时加载原始技能，计算依赖仍在当前工作区检查。</p><div class="eve-task-skill-list"></div>',actions:[
  {label:'取消',kind:'ghost'},
  {label:'加入当前任务',kind:'primary',onClick:()=>{
   if(!chosen.size)return false;
   input.value=`[选用技能: ${[...chosen].join(', ')}]\n`+input.value.replace(/^\[选用技能:[^\n]*\]\n/,'');
   input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();return true;
  }}]});
 const list=modal.body.querySelector('.eve-task-skill-list'),query=modal.body.querySelector('[data-skill-query]');
 const render=()=>{
  const words=query.value.toLowerCase().trim();
  const visible=skills.filter(s=>(s.name+' '+s.description).toLowerCase().includes(words)).slice(0,80);
  list.innerHTML=visible.map(s=>`<label class="eve-task-skill"><input type="checkbox" value="${escAttr(s.name)}" ${chosen.has(s.name)?'checked':''}/><span><strong>${esc(s.name)}</strong><small>${esc((s.description||'').slice(0,200))}</small></span><small>${s.executable?'计算入口':'流程指引'}</small></label>`).join('')||'<p class="sw-muted">没有匹配的技能</p>';
 };
 list.onchange=event=>{const name=event.target.value;if(!name)return;if(event.target.checked){if(chosen.size>=3){event.target.checked=false;toastError('一次最多选择三项技能');return;}chosen.add(name);}else chosen.delete(name);};
 query.oninput=render;render();query.focus();
}
