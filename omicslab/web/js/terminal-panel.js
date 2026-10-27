import {esc,escAttr} from './util.js?v=2.1.1';
import {on,emit} from './bus.js?v=2.1.1';

// Session ownership belongs to the workspace, not to a route's DOM lifetime.
// Bounded retained renderers keep PTY output/state while visiting other panels.
const sessions=new Map(),pending=new Map(),selected=new Map();
const workspaceKey=workspace=>JSON.stringify([workspace.workspace_id,workspace.backend,workspace.resolved_path,workspace.remote]);
export function terminalSessions(workspace){
 const key=workspaceKey(workspace);
 return [...sessions.values()].filter(s=>s.workspaceKey===key);
}
export function selectTerminalSession(workspace,id){
 if(terminalSessions(workspace).some(s=>s.id===id))selected.set(workspaceKey(workspace),id);
}
export async function acquireTerminalSession(workspace,{fresh=false}={}){
 const key=workspaceKey(workspace),existing=terminalSessions(workspace);
 if(!fresh&&existing.length)return existing.find(s=>s.id===selected.get(key))||existing.at(-1);
 if(!fresh&&pending.has(key))return pending.get(key);
 if(sessions.size+pending.size>=8)throw new Error('已打开 8 个终端，请关闭不用的终端后重试。');
 const id=crypto.randomUUID(),pendingKey=fresh?id:key;
 const promise=(async()=>{
  const panel=await createTerminalPanel(workspace,{onClose:()=>{
   sessions.delete(id);if(selected.get(key)===id)selected.delete(key);
   emit('terminal:sessions',{workspaceId:workspace.workspace_id});
  }});
  const session={id,workspaceKey:key,panel,title:`终端 ${existing.length+1}`};
  sessions.set(id,session);selected.set(key,id);return session;
 })();
 pending.set(pendingKey,promise);
 try{return await promise;}finally{pending.delete(pendingKey);}
}
window.addEventListener('beforeunload',()=>{for(const s of sessions.values())s.panel.destroy();sessions.clear();});

function terminalTheme(){
 const styles=getComputedStyle(document.documentElement);
 const color=(name,fallback)=>styles.getPropertyValue(name).trim()||fallback;
 const light=document.documentElement.dataset.theme==='light';
 return {
  background:color('--panel',light?'#fafbfc':'#262626'),
  foreground:color('--text',light?'#303238':'#ececec'),
  cursor:color('--text',light?'#303238':'#ececec'),
  cursorAccent:color('--panel',light?'#fafbfc':'#262626'),
  selectionBackground:light?'#30323826':'#ffffff33',
  selectionInactiveBackground:light?'#30323814':'#ffffff1a',
  black:light?'#303238':'#414141',brightBlack:light?'#60656d':'#999999',
  red:light?'#b42331':'#f08080',brightRed:light?'#b42331':'#ff9999',
  green:light?'#246938':'#8dc891',brightGreen:light?'#246938':'#a7dda9',
  yellow:light?'#805b0c':'#d8ba75',brightYellow:light?'#805b0c':'#ead293',
  blue:light?'#305ca8':'#91b5ea',brightBlue:light?'#305ca8':'#adcbf6',
  magenta:light?'#86509b':'#c4a0d5',brightMagenta:light?'#86509b':'#dbb7ed',
  cyan:light?'#226b76':'#8ccbd1',brightCyan:light?'#226b76':'#a8dfe4',
  white:light?'#626873':'#d4d4d4',brightWhite:light?'#303238':'#f2f2f2',
 };
}

let renderer;
function script(src){
 return new Promise((resolve,reject)=>{
  const node=document.createElement('script');node.src=src;node.onload=resolve;node.onerror=()=>{node.remove();reject(new Error('终端组件加载失败'));};document.head.append(node);
 });
}
async function loadRenderer(){
 if(!renderer)renderer=(async()=>{
  const css=document.createElement('link');css.rel='stylesheet';css.href='vendor/xterm/xterm.css';document.head.append(css);
  await script('vendor/xterm/xterm.js');await script('vendor/xterm/addon-fit.js');
 })().catch(error=>{renderer=null;throw error;});
 return renderer;
}

/** One PTY per selected workspace. Tabs hide the same DOM; they never replay commands. */
export async function createTerminalPanel(workspace,{onClose=()=>{}}={}){
 await loadRenderer();
 const node=document.createElement('section');node.className='eve-terminal-panel';
 node.innerHTML=`<header><span class="terminal-status">连接中</span><span title="${escAttr(workspace.resolved_path||'')}">${esc(workspace.name||'')} · ${workspace.backend==='ssh'?'SSH':'PowerShell'}</span><button type="button" data-terminal-clear>清屏</button><button type="button" data-terminal-connect>重新连接</button><button type="button" data-terminal-close>关闭终端</button></header><div class="eve-terminal-screen" aria-label="交互终端"></div>`;
 const status=node.querySelector('.terminal-status');
 const terminal=new window.Terminal({screenReaderMode:true,cursorBlink:true,scrollback:3000,fontSize:13,fontFamily:'Cascadia Mono, Consolas, monospace',allowProposedApi:false,theme:terminalTheme()});
 const fit=new window.FitAddon.FitAddon();terminal.loadAddon(fit);terminal.open(node.querySelector('.eve-terminal-screen'));
 let socket=null,disposed=false,frame=0;
 const offTheme=on('theme:change',()=>{if(!disposed)terminal.options.theme=terminalTheme();});
 function resize(){
  if(disposed||!node.isConnected||!node.clientWidth||!node.clientHeight)return;
  fit.fit();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resize',cols:terminal.cols,rows:terminal.rows}));
 }
 function scheduleResize(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;resize();});}
 function disconnect(){if(socket){socket.onclose=null;socket.close();socket=null;}}
 function connect(){
  if(disposed)return;disconnect();status.textContent='连接中';
  const url=new URL('/ws/terminal',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  url.searchParams.set('workspace_id',workspace.workspace_id);url.searchParams.set('cols',terminal.cols);url.searchParams.set('rows',terminal.rows);
  const current=socket=new WebSocket(url);
  current.onmessage=event=>{
   if(socket!==current||disposed)return;
   let packet;try{packet=JSON.parse(event.data);}catch{status.textContent='协议错误';return;}
   if(packet.type==='output')terminal.write(packet.data);
   else if(packet.type==='ready'){status.textContent=`${packet.shell} · ${packet.pty?'PTY':'兼容通道'}`;resize();}
   else if(packet.type==='diagnostic'){status.textContent=packet.message;terminal.writeln(`\r\n${packet.message}`);}
   else if(packet.type==='exit')status.textContent='已结束';
  };
  current.onclose=()=>{if(socket===current){socket=null;status.textContent='已断开';}};
  current.onerror=()=>{if(socket===current)status.textContent='连接失败';};
 }
 const input=terminal.onData(data=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'input',data}));});
 const observer=new ResizeObserver(scheduleResize);observer.observe(node);
 node.querySelector('[data-terminal-clear]').onclick=()=>terminal.clear();
 node.querySelector('[data-terminal-connect]').onclick=()=>{terminal.writeln('\r\n—— 新终端会话 ——');connect();};
 connect();
 const panel={node,focus(){scheduleResize();terminal.focus();},destroy(){if(disposed)return;disposed=true;offTheme();cancelAnimationFrame(frame);observer.disconnect();disconnect();input.dispose();terminal.dispose();node.remove();}};
 node.querySelector('[data-terminal-close]').onclick=()=>{panel.destroy();onClose();};
 return panel;
}
