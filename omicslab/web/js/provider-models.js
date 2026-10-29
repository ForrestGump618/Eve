import {api,errorMessage} from './api.js?v=1.5.0';
import {esc,escAttr} from './util.js?v=1.5.0';

export function mountProviderModels(body,initial=[]){
 let selected=new Set(initial),available=[...selected],generation=0;
 const host=document.createElement('section');host.className='eve-provider-model-list';
 host.innerHTML=`<div class="eve-card-heading"><strong>可用模型</strong><button type="button" class="btn btn-sm" data-model-discover>获取模型列表</button></div><div class="eve-model-manual"><input class="input" aria-label="添加模型名称" placeholder="手动添加模型名称"/><button type="button" class="btn btn-sm" data-model-add>添加</button></div><p class="sw-muted" data-model-status>勾选常用模型，在对话中按供应商切换。</p><div class="eve-model-options"></div>`;
 body.querySelector('#provider-editor-model').closest('.sw-form-grid').after(host);
 const list=host.querySelector('.eve-model-options'),status=host.querySelector('[data-model-status]');
 const render=()=>{list.innerHTML=available.map(name=>`<label class="eve-model-option"><input type="checkbox" value="${escAttr(name)}" ${selected.has(name)?'checked':''}/><span>${esc(name)}</span><button type="button" class="btn btn-ghost btn-sm" data-model-default="${escAttr(name)}">设为首选</button></label>`).join('');};
 const reset=values=>{generation++;selected=new Set(values);available=[...selected];render();status.textContent='勾选常用模型，在对话中按供应商切换。';};
 host.onchange=event=>{if(event.target.matches('input[type=checkbox]')){if(event.target.checked)selected.add(event.target.value);else selected.delete(event.target.value);}};
 host.onclick=async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.modelDefault!==undefined){body.querySelector('#provider-editor-model').value=button.dataset.modelDefault;selected.add(button.dataset.modelDefault);render();}
  if(button.hasAttribute('data-model-add')){
   const input=host.querySelector('.eve-model-manual input'),name=input.value.trim();
   if(!name||name.length>160)return;
   if(!available.includes(name))available.push(name);selected.add(name);input.value='';render();
  }
  if(button.hasAttribute('data-model-discover')){
   const epoch=generation;button.disabled=true;status.textContent='正在向供应商查询…';
   try{
    const data=await api.request('/api/settings/models',{method:'POST',timeout:110000,body:{
     provider:body.querySelector('#provider-editor-provider').value,
     model:body.querySelector('#provider-editor-model').value,
     api_base:body.querySelector('#provider-editor-base').value,
     api_key:body.querySelector('#provider-editor-key').value}});
    if(epoch!==generation)return;
    available=[...new Set([...selected,...data.models])];render();
    status.textContent=`已获取 ${data.models.length} 个模型${data.truncated?'（列表已分页截断）':''}，勾选后保存。`;
   }catch(error){if(epoch===generation)status.textContent=errorMessage(error);}
   finally{button.disabled=false;}
  }
 };
 render();return {values:()=>[...selected],reset};
}
