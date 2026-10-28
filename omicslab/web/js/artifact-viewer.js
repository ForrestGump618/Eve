import {api} from './api.js?v=2.1.1';
import {openModal} from './ui.js?v=2.1.1';

// No same-origin, external network, form submission or host API.
// Native explainers may create opaque srcdoc children for frozen diagrams.
export function isolatedDocument(content) {
  const doc=new DOMParser().parseFromString(content,'text/html');
  doc.querySelectorAll('base').forEach(node=>node.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach(node=>node.remove());
  const policy=doc.createElement('meta');
  policy.httpEquiv='Content-Security-Policy';
  policy.content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src about:; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
  doc.head.prepend(policy);
  return '<!doctype html>\n'+doc.documentElement.outerHTML;
}

export async function openHtmlArtifact(workspaceId,path,title='交互页面') {
  if(!workspaceId)throw Error('此产物没有绑定工作区，请先选择原工作区');
  const result=await api.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts/html?path=${encodeURIComponent(path)}`);
  const frame=document.createElement('iframe');
  frame.className='artifact-frame';
  frame.title=title;
  frame.style.colorScheme=document.documentElement.dataset.theme==='dark'?'dark':'light';
  frame.setAttribute('sandbox','allow-scripts allow-downloads');
  frame.setAttribute('referrerpolicy','no-referrer');
  frame.srcdoc=isolatedDocument(result.content);
  const body=document.createElement('div');
  const note=document.createElement('p');note.className='artifact-note';
  note.textContent=`${path} · ${(result.bytes/1024).toFixed(0)} KB · 工作区文件`;
  body.append(note,frame);
  const blobUrl=URL.createObjectURL(new Blob([result.content],{type:'text/html;charset=utf-8'}));
  try{
    return openModal({title,size:'xl',node:body,bodyClass:'artifact-preview-body',
      actions:[
        {label:'查看源码',kind:'ghost',onClick:async()=>{
          const {openWorkspaceEditor}=await import('./workspace-editor.js?v=1.0.0');
          const data=await api.workspaces.get(workspaceId);
          await openWorkspaceEditor(data.workspace||data,path);return false;
        }},
        {label:'下载 HTML',kind:'ghost',onClick:()=>{
          const link=document.createElement('a');link.href=blobUrl;link.download=path.split(/[\\/]/).at(-1)||'artifact.html';
          document.body.append(link);link.click();link.remove();return false;
        }},
        {label:'关闭',kind:'primary'},
      ],onClose:()=>{frame.srcdoc='';frame.remove();URL.revokeObjectURL(blobUrl);}});
  }catch(error){frame.remove();URL.revokeObjectURL(blobUrl);throw error;}
}
