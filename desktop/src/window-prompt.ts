import {type BrowserWindow,type WebContents} from 'electron';

interface WindowPrompt {
  title:string;
  detail:string;
  buttons:string[];
  cancelId:number;
  defaultId:number;
  checkboxLabel?:string;
}
interface WindowDecision {response:number;checkboxChecked:boolean}

/** Render inside the existing window. No extra product window or privileged
 * renderer API: only this main-process-initiated question can return a choice.
 * The isolated world keeps the resolver separate from workbench scripts. */
function renderPrompt(options:WindowPrompt):Promise<WindowDecision>{
  return new Promise(resolve=>{
    const previous=document.activeElement;
    const host=document.createElement('eve-window-prompt');
    const shadow=host.attachShadow({mode:'open'});
    const style=document.createElement('style');
    style.textContent=`
      :host{font:14px/1.6 "Segoe UI",system-ui,sans-serif;color:var(--text,#292b30)}
      dialog{box-sizing:border-box;width:min(480px,calc(100vw - 40px));margin:auto;padding:26px;
        color:inherit;background:var(--panel,#fff);border:1px solid var(--border,#e2e4e8);
        border-radius:16px;box-shadow:0 18px 65px #151a2520;animation:enter .14s ease-out}
      dialog::backdrop{background:#18202b38}
      h2{margin:0 0 10px;font-size:19px;font-weight:600;line-height:1.4;letter-spacing:-.3px}
      p{margin:0;color:var(--text-2,#656971);white-space:pre-wrap;overflow-wrap:anywhere}
      label{display:flex;align-items:center;gap:8px;margin-top:20px;color:var(--text-2,#656971);cursor:pointer;font-size:13px}
      input{width:15px;height:15px;margin:0;accent-color:var(--text,#35373c)}
      footer{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:24px}
      button{font:inherit;font-size:13px;min-height:36px;padding:7px 13px;border-radius:8px;
        border:1px solid var(--border,#e2e4e8);background:var(--bg-soft,#f5f6f8);color:inherit;cursor:pointer}
      button:hover{filter:brightness(.96)}button:focus-visible,input:focus-visible{outline:2px solid var(--text-3,#878d97);outline-offset:3px}
      button[data-primary]{background:var(--text,#303238);color:var(--panel,#fff);border-color:transparent}
      @keyframes enter{from{opacity:0;transform:translateY(5px) scale(.985)}to{opacity:1;transform:none}}
      @media(prefers-reduced-motion:reduce){dialog{animation:none}}
    `;
    const dialog=document.createElement('dialog');
    dialog.setAttribute('aria-modal','true');
    dialog.setAttribute('aria-labelledby','eve-close-title');
    dialog.setAttribute('aria-describedby','eve-close-detail');
    const heading=document.createElement('h2');heading.id='eve-close-title';heading.textContent=options.title;
    const detail=document.createElement('p');detail.id='eve-close-detail';detail.textContent=options.detail;
    dialog.append(heading,detail);
    let checkbox:HTMLInputElement|undefined;
    if(options.checkboxLabel){
      const label=document.createElement('label');
      checkbox=document.createElement('input');checkbox.type='checkbox';
      label.append(checkbox,document.createTextNode(options.checkboxLabel));dialog.append(label);
    }
    let finished=false;
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(options.cancelId);}
    };
    const finish=(response:number)=>{
      if(finished)return;finished=true;
      window.removeEventListener('keydown',onKey,true);
      dialog.close();host.remove();
      if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});
      resolve({response,checkboxChecked:checkbox?.checked??false});
    };
    const footer=document.createElement('footer');
    options.buttons.forEach((text,index)=>{
      const button=document.createElement('button');button.type='button';button.textContent=text;
      button.dataset.response=String(index);
      if(index===options.defaultId){button.dataset.primary='';button.autofocus=true;}
      button.addEventListener('click',()=>finish(index));footer.append(button);
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(options.cancelId);});
    dialog.addEventListener('close',()=>finish(options.cancelId));
    dialog.append(footer);shadow.append(style,dialog);document.documentElement.append(host);
    window.addEventListener('keydown',onKey,true);
    dialog.showModal();
  });
}

export async function showWindowPrompt(window:BrowserWindow|null,options:WindowPrompt):Promise<WindowDecision>{
  const cancelled={response:options.cancelId,checkboxChecked:false};
  let contents:WebContents;
  try{
    if(!window||window.isDestroyed()||window.webContents.isDestroyed())return cancelled;
    contents=window.webContents;
    if(window.isMinimized())window.restore();
    window.show();window.focus();
  }catch{return cancelled;}
  let abandon:()=>void=()=>{};
  const lost=new Promise<WindowDecision>(resolve=>{abandon=()=>resolve(cancelled);});
  const navigating=(_event:unknown,_url:string,isInPlace:boolean,isMainFrame:boolean)=>{if(isMainFrame&&!isInPlace)abandon();};
  contents.once('destroyed',abandon);
  contents.once('render-process-gone',abandon);
  contents.on('did-start-navigation',navigating);
  try{
    const result=await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(1004,[{code:`(${renderPrompt.toString()})(${JSON.stringify(options)})`}]),
      lost,
    ]);
    return result&&Number.isInteger(result.response)&&result.response>=0&&result.response<options.buttons.length
      ?{response:result.response,checkboxChecked:result.checkboxChecked===true}:cancelled;
  }catch{return cancelled;}
  finally{
    contents.removeListener('destroyed',abandon);
    contents.removeListener('render-process-gone',abandon);
    contents.removeListener('did-start-navigation',navigating);
  }
}
