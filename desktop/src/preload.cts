const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('suwen', Object.freeze({
 call:(method:string,params:unknown={})=>ipcRenderer.invoke('suwen:call',method,params),
 // Incremental streaming events; see docs/architecture/streaming-events.md.
 onEvent:(handler:(batch:unknown)=>void)=>{
  if(typeof handler!=='function')throw new Error('onEvent requires a function');
  const listener=(_event:unknown,payload:unknown)=>handler(payload);
  ipcRenderer.on('suwen:events',listener);
  return ()=>ipcRenderer.removeListener('suwen:events',listener);
 },
 // Daemon connection lifecycle (reconnecting | restored | lost) for streaming UI recovery.
 onConnection:(handler:(state:unknown)=>void)=>{
  if(typeof handler!=='function')throw new Error('onConnection requires a function');
  const listener=(_event:unknown,payload:unknown)=>handler(payload);
  ipcRenderer.on('suwen:connection',listener);
  return ()=>ipcRenderer.removeListener('suwen:connection',listener);
 },
 // Managed workbench runtime install progress (phase/message/percent).
 onWorkbench:(handler:(event:unknown)=>void)=>{
  if(typeof handler!=='function')throw new Error('onWorkbench requires a function');
  const listener=(_event:unknown,payload:unknown)=>handler(payload);
  ipcRenderer.on('suwen:workbench',listener);
  return ()=>ipcRenderer.removeListener('suwen:workbench',listener);
 }
}));
