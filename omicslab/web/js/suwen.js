/** Shared appearance and workspace-local layout preferences. Legacy keys remain readable. */
import { api } from './api.js?v=1.4.0';
import { getPref, setPref } from './util.js?v=1.4.0';
import { getState, navigate } from './store.js?v=1.4.0';
import { applyTheme, openModal } from './ui.js?v=1.4.0';

export function applyAppearance(settings){
 if(!settings)return;
 const root=document.documentElement;
 applyTheme(settings.theme,{persist:true});
 const fonts={system:'Inter, "Segoe UI Variable", "PingFang SC", "Microsoft YaHei", sans-serif',sans:'Arial, "Microsoft YaHei", sans-serif',mono:'"Cascadia Code", Consolas, "Microsoft YaHei", monospace'};
 root.style.setProperty('--font-sans',fonts[settings.font]||fonts.system);
 root.style.setProperty('--ui-font-size',`${settings.font_size||14}px`);
 root.style.setProperty('--accent',settings.accent||'#3157D5');
 root.style.setProperty('--radius',`${settings.radius??12}px`);
 root.dataset.density=settings.density||'comfortable';root.dataset.mode=settings.mode||'research';
 setPref('homeRoute',settings.home||'dashboard');
 setPref('paletteShortcut',settings.shortcuts?.palette||'k');
 setPref('agentAvatar',settings.avatar||'');
 setPref('agentName',settings.agent_name||'Eve');
 const name=document.querySelector('.brand-name');if(name)name.textContent='Eve';
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(getPref('theme',null)==='system')applyTheme('system',{persist:false});});

export async function initPlatform(){
 try{
  const scope=getState().workspaceId||'ws_main';
  const data=await api.request(`/api/platform/bootstrap?scope=${encodeURIComponent(scope)}`);
  applyAppearance(data.settings.appearance.value);
  if(!data.settings.appearance.value.onboarded&&!getPref('onboardingDismissed',false)){
   const onboarding=openModal({
    title:'连接模型',
    size:'sm',
    bodyClass:'sw-onboarding-body',
    html:'<div class="sw-onboarding"><p class="sw-onboarding-purpose">连接后即可对话和运行任务。</p><label class="sw-onboarding-optout"><input type="checkbox" data-onboarding-optout checked/><span>下次不再提示</span></label></div>',
    actions:[
     {label:'连接模型',kind:'primary',onClick:()=>navigate('settings')},
    ],
    onClose:()=>setPref('onboardingDismissed',onboarding.body.querySelector('[data-onboarding-optout]')?.checked===true),
   });
   onboarding.el.querySelector('.modal')?.classList.add('sw-onboarding-modal');
  }
 }catch(err){console.warn('[Eve] 平台设置不可用',err.message);}
}
