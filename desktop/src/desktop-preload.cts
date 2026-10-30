const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('suwenDesktop',Object.freeze({
  getCloseAction:()=>ipcRenderer.invoke('suwen:desktop','getCloseAction'),
  setCloseAction:(action:string)=>ipcRenderer.invoke('suwen:desktop','setCloseAction',action),
  setWindowTheme:(theme:'light'|'dark')=>ipcRenderer.invoke('suwen:desktop','setWindowTheme',theme),
  retryStartup:()=>ipcRenderer.invoke('suwen:desktop','retryStartup'),
}));
