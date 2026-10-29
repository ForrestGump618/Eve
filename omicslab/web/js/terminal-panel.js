import {esc,escAttr} from './util.js?v=1.5.0';
import {on,emit} from './bus.js?v=1.5.0';
import {terminalPolicy as policy,terminalAppearance,TerminalOutputBuffer} from './terminal-policy.js?v=1.5.0';

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
 if(sessions.size+pending.size>=policy.maxSessions)throw new Error(`已打开 ${policy.maxSessions} 个终端，请关闭不用的终端后重试。`);
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

function appearance(){return terminalAppearance(getComputedStyle(document.documentElement));}

let renderer;
function script(src){
 return new Promise((resolve,reject)=>{
  const node=document.createElement('script');node.src=src;
  const finish=error=>{clearTimeout(timer);node.onload=null;node.onerror=null;if(error){node.remove();reject(error);}else resolve();};
  const timer=setTimeout(()=>finish(new Error('终端组件加载超时')),policy.scriptTimeoutMs);
  node.onload=()=>finish();node.onerror=()=>finish(new Error('终端组件加载失败'));document.head.append(node);
 });
}
async function loadRenderer(){
 if(!renderer)renderer=(async()=>{
  if(!document.querySelector('link[data-terminal-style]')){
   const css=document.createElement('link');css.rel='stylesheet';css.href='vendor/xterm/xterm.css';css.dataset.terminalStyle='';document.head.append(css);
  }
  if(!window.Terminal)await script('vendor/xterm/xterm.js');
  if(!window.FitAddon)await script('vendor/xterm/addon-fit.js');
 })().catch(error=>{renderer=null;throw error;});
 return renderer;
}

/** One PTY per selected workspace. Tabs hide the same DOM; they never replay commands. */
export async function createTerminalPanel(workspace,{onClose=()=>{}}={}){
 await loadRenderer();
 const node=document.createElement('section');node.className='eve-terminal-panel';
 node.innerHTML=`<header><span class="terminal-status">连接中</span><span title="${escAttr(workspace.resolved_path||'')}">${esc(workspace.name||'')} · ${workspace.backend==='ssh'?'SSH':'PowerShell'}</span><button type="button" data-terminal-clear>清屏</button><button type="button" data-terminal-connect>重新连接</button><button type="button" data-terminal-close>关闭终端</button></header><div class="eve-terminal-screen" aria-label="交互终端"></div>`;
 const status=node.querySelector('.terminal-status');
 const terminal=new window.Terminal({screenReaderMode:true,cursorBlink:true,cols:policy.cols,rows:policy.rows,scrollback:policy.scrollback,fontSize:policy.fontSize,allowProposedApi:false,...appearance()});
 const fit=new window.FitAddon.FitAddon();terminal.loadAddon(fit);terminal.open(node.querySelector('.eve-terminal-screen'));
 let socket=null,output=null,disposed=false,frame=0,retryTimer=0,connectTimer=0,retries=0;
 const offTheme=on('theme:change',()=>{if(!disposed){Object.assign(terminal.options,appearance());scheduleResize();}});
 function resize(){
  if(disposed||!node.isConnected||!node.clientWidth||!node.clientHeight)return;
  fit.fit();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resize',cols:terminal.cols,rows:terminal.rows}));
 }
 function scheduleResize(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;resize();});}
 function disconnect(){
  clearTimeout(retryTimer);clearTimeout(connectTimer);output?.dispose();output=null;
  if(socket){socket.onmessage=null;socket.onclose=null;socket.onerror=null;socket.close();socket=null;}
 }
 function connect(notice=''){
  if(disposed)return;disconnect();status.textContent='连接中';
  const url=new URL('/ws/terminal',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  url.searchParams.set('workspace_id',workspace.workspace_id);url.searchParams.set('cols',terminal.cols);url.searchParams.set('rows',terminal.rows);
  url.searchParams.set('flow',policy.flowProtocol);
  const current=socket=new WebSocket(url);
  let ended=false,recover=false,failed=false,readyAt=0;
  const buffer=output=new TerminalOutputBuffer({
   write:(data,done)=>terminal.write(data,done),
   acknowledge:seq=>{if(!disposed&&socket===current&&current.readyState===WebSocket.OPEN)current.send(JSON.stringify({type:'ack',seq}));},
   onError:message=>{if(!disposed&&socket===current){failed=true;ended=true;status.textContent=message;current.close();}},
  });
  if(notice)buffer.notice(notice);
  connectTimer=setTimeout(()=>{if(socket===current){status.textContent='终端连接超时';current.close();}},policy.connectTimeoutMs);
  current.onmessage=event=>{
   if(socket!==current||disposed||failed)return;
   let packet;try{packet=JSON.parse(event.data);if(!packet||typeof packet!=='object')throw new Error();}catch{buffer.fail('终端协议错误');return;}
   if(packet.type==='output')buffer.enqueue(packet.data,packet.seq);
   else if(packet.type==='ready'){
    clearTimeout(connectTimer);buffer.negotiate(packet.flow_control);if(failed)return;
    readyAt=Date.now();status.textContent=`${packet.shell} · ${packet.pty?'PTY':'兼容通道'}`;resize();
   }
   else if(packet.type==='diagnostic'){recover=['ssh_connection_lost','channel_error'].includes(packet.code);status.textContent=packet.message;buffer.notice(`\r\n${packet.message}\r\n`);}
   else if(packet.type==='exit'){ended=true;status.textContent=recover?'连接中断':'已结束';}
  };
  current.onclose=()=>{if(socket===current){
   clearTimeout(connectTimer);socket=null;if(failed)return;
   if(readyAt&&Date.now()-readyAt>policy.retry.stableMs)retries=0;
   if(!disposed&&workspace.backend==='ssh'&&(!ended||recover)&&retries<policy.retry.attempts){
    const delay=Math.min(policy.retry.maxMs,policy.retry.baseMs*2**retries++);status.textContent=`${Math.ceil(delay/1000)} 秒后重连 (${retries}/${policy.retry.attempts})`;
    retryTimer=setTimeout(()=>connect('\r\n—— 重连新终端，旧命令未重放 ——\r\n'),delay);
   }else status.textContent=ended&&!recover?'已结束':'已断开 · 点击重新连接';
  }};
  current.onerror=()=>{if(socket===current)status.textContent='连接失败';};
 }

 const input=terminal.onData(data=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'input',data}));});
 const observer=new ResizeObserver(scheduleResize);observer.observe(node);
 node.querySelector('[data-terminal-clear]').onclick=()=>terminal.clear();
 node.querySelector('[data-terminal-connect]').onclick=()=>{retries=0;connect('\r\n—— 新终端会话 ——\r\n');};
 connect();
 const panel={node,focus(){scheduleResize();terminal.focus();},destroy(){if(disposed)return;disposed=true;offTheme();cancelAnimationFrame(frame);observer.disconnect();disconnect();input.dispose();terminal.dispose();node.remove();}};
 node.querySelector('[data-terminal-close]').onclick=()=>{panel.destroy();onClose();};
 return panel;
}
