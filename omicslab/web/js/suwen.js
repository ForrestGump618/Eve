/** Shared appearance and workspace-local layout preferences. Legacy keys remain readable. */
import { api } from './api.js?v=1.2.0';
import { getPref, setPref } from './util.js?v=1.2.0';
import { getState, navigate } from './store.js?v=1.2.0';
import { applyTheme, openModal } from './ui.js?v=1.2.0';

export function applyAppearance(settings){
 if(!settings)return;
 const root=document.documentElement;
 applyTheme(settings.theme,{persist:true});
 const fonts={system:'Inter, "Segoe UI Variable", "PingFang SC", "Microsoft YaHei", sans-serif',sans:'Arial, "Microsoft YaHei", sans-serif',mono:'"Cascadia Code", Consolas, "Microsoft YaHei", monospace'};
 root.style.setProperty('--font-sans',fonts[settings.font]||fonts.system);
 root.style.setProperty('--ui-font-size',`${settings.font_size||14}px`);
 root.style.setProperty('--accent',settings.accent||'#47b8a1');
 root.style.setProperty('--radius',`${settings.radius??12}px`);
 root.dataset.density=settings.density||'comfortable';root.dataset.mode=settings.mode||'research';
 setPref('homeRoute',settings.home||'workbench');
 setPref('paletteShortcut',settings.shortcuts?.palette||'k');
 setPref('agentAvatar',settings.avatar||'');
 setPref('agentName',settings.agent_name||'Eve助手');
 const name=document.querySelector('.brand-name');if(name)name.textContent='Eve';
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(getPref('theme',null)==='system')applyTheme('system',{persist:false});});

export async function initPlatform(){
 try{
  const scope=getState().workspaceId||'ws_main';
  const data=await api.request(`/api/platform/bootstrap?scope=${encodeURIComponent(scope)}`);
  applyAppearance(data.settings.appearance.value);
  if(!data.settings.appearance.value.onboarded&&!getPref('onboardingDismissed',false)){
   openModal({title:'开始使用 Eve',size:'md',html:'<div class="sw-onboarding"><p>连接模型，选择工作目录，即可开始任务。</p><ol><li>在设置中添加供应商与模型</li><li>选择本地文件夹或 SSH 远程目录</li><li>按需调整任务权限</li></ol></div>',actions:[
    {label:'先看看',kind:'ghost',onClick:()=>{setPref('onboardingDismissed',true);}},
    {label:'配置模型连接',kind:'primary',onClick:()=>{setPref('onboardingDismissed',true);navigate('connections');}},
   ]});
  }
 }catch(err){console.warn('[Eve] 平台设置不可用',err.message);}
}
