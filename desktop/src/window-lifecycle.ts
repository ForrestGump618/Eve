import {app,dialog,Menu,Tray,nativeImage,type BrowserWindow} from 'electron';
import {readFileSync} from 'node:fs';
import {atomicJson} from './security.js';

export type CloseAction='ask'|'quit'|'tray';
/** Window visibility never owns task lifetime. Explicit quit drains the daemon. */
export class WindowLifecycle {
  private tray:Tray|null=null;
  private deciding=false;
  private exiting=false;
  private action:CloseAction='ask';
  constructor(private readonly options:{path:string;icon:string;window:()=>BrowserWindow|null;active:()=>Promise<number>;shutdown:()=>Promise<void>;quit:()=>void}){
    try{const value=JSON.parse(readFileSync(options.path,'utf8')).closeAction;if(['ask','quit','tray'].includes(value))this.action=value;}catch{}
  }
  getCloseAction():CloseAction{return this.action;}
  setCloseAction(action:unknown):CloseAction{
    if(action!=='ask'&&action!=='quit'&&action!=='tray')throw new Error('Invalid close action');
    atomicJson(this.options.path,{closeAction:action});this.action=action;return action;
  }
  install():void{
    Menu.setApplicationMenu(null);
    let image=nativeImage.createFromPath(this.options.icon);
    if(image.isEmpty())image=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+XNkBbgAAAABJRU5ErkJggg==');
    this.tray=new Tray(image);
    this.tray.setToolTip('Eve · 后台任务与 SSH 工作区');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      {label:'显示主窗口',click:()=>this.show()},
      {label:'查看任务状态',click:()=>this.show(true)},
      {type:'separator'},
      {label:'彻底退出',click:()=>{void this.quit();}},
    ]));
    this.tray.on('double-click',()=>this.show());
  }
  attach(window:BrowserWindow):void{
    window.setMenuBarVisibility(false);
    window.on('close',event=>{
      if(this.exiting)return;
      event.preventDefault();
      void this.close(window);
    });
  }
  show(tasks=false):void{
    const window=this.options.window();if(!this.live(window))return;
    try{
      if(window.isMinimized())window.restore();
      window.show();window.focus();
      if(tasks&&this.live(window)&&window.webContents.getURL().startsWith('http://127.0.0.1:'))void window.webContents.executeJavaScript("location.hash='#/tasks2'").catch(()=>{});
    }catch{/* window was destroyed between visibility checks */}
  }
  private async close(window:BrowserWindow):Promise<void>{
    if(this.deciding||this.exiting)return;this.deciding=true;
    try{
      if(!this.live(window))return;
      let action=this.action;
      if(action==='ask'){
        const decision=!this.live(window)
          ? await dialog.showMessageBox({type:'question',title:'关闭Eve',message:'如何关闭Eve？',detail:'最小化到托盘后，后台任务与 SSH 连接继续运行。彻底退出会停止运行时并释放连接。',buttons:['退出程序','最小化到系统托盘','取消'],defaultId:1,cancelId:2,checkboxLabel:'记住我的选择（可在设置中修改）',checkboxChecked:false,noLink:true})
          : await dialog.showMessageBox(window,{type:'question',title:'关闭Eve',message:'如何关闭Eve？',detail:'最小化到托盘后，后台任务与 SSH 连接继续运行。彻底退出会停止运行时并释放连接。',buttons:['退出程序','最小化到系统托盘','取消'],defaultId:1,cancelId:2,checkboxLabel:'记住我的选择（可在设置中修改）',checkboxChecked:false,noLink:true});
        if(decision.response===2)return;
        action=decision.response===0?'quit':'tray';
        if(decision.checkboxChecked)this.setCloseAction(action);
      }
      if(action==='tray'){
        if(!this.tray){if(this.live(window))await dialog.showMessageBox(window,{type:'error',message:'系统托盘不可用，窗口保持打开。'});return;}
        if(this.live(window))window.hide();return;
      }
      await this.quit();
    }finally{this.deciding=false;}
  }
  async quit():Promise<void>{
    if(this.exiting)return;
    let active:number;
    try{active=await this.options.active();}catch{
      const result=await dialog.showMessageBox({type:'warning',message:'无法确认后台任务状态',detail:'连接不可用。可保留窗口检查任务，或退出界面并保留后台等待核对。',buttons:['保留窗口','退出界面并保留后台'],defaultId:0,cancelId:0,noLink:true});
      if(result.response!==1)return;
      this.exiting=true;this.dispose();this.options.quit();return;
    }
    if(active>0){
      const result=await dialog.showMessageBox({type:'warning',message:`仍有 ${active} 项任务未结束`,detail:'停止并退出会取消当前执行。已提交的远程命令可能需要重连后核对；不会自动重放。',buttons:['停止任务并退出','保留任务并最小化到托盘','取消'],defaultId:1,cancelId:2,noLink:true});
      if(result.response===1){const target=this.options.window();if(this.live(target))target.hide();return;}
      if(result.response!==0)return;
    }
    this.exiting=true;
    try{await this.options.shutdown();this.dispose();this.options.quit();}
    catch(error){this.exiting=false;this.show();await dialog.showMessageBox({type:'error',message:'后台尚未安全退出',detail:String(error).slice(0,500),buttons:['返回检查']});}
  }
  dispose():void{this.tray?.destroy();this.tray=null;}
  get isExiting():boolean{return this.exiting;}
  get trayAvailable():boolean{return this.tray!==null&&!this.tray.isDestroyed();}
  private live(window:BrowserWindow|null|undefined):window is BrowserWindow {
    try{return Boolean(window&&!window.isDestroyed()&&!window.webContents.isDestroyed());}catch{return false;}
  }
}
