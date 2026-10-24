const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('suwen', Object.freeze({
 call:(method:string,params:unknown={})=>ipcRenderer.invoke('suwen:call',method,params)
}));
