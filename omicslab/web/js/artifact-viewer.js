import {api} from './api.js?v=2.1.1';
import {artifactConfig} from './artifact-config.js';
import {getArtifactSidebar} from './artifact-tabs.js';

// Each srcdoc gets an opaque origin. A trusted outer frame also blocks the
// artifact's own frame navigation, which its document CSP alone cannot do.
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

const renderers = new Map();

/** Only application/plugin code registers renderers; artifact content cannot. */
export function registerArtifactRenderer(type, render) {
  if (!type || typeof render !== 'function') throw TypeError('预览器需要类型和渲染函数');
  if (renderers.has(type)) throw Error(`预览器已注册：${type}`);
  renderers.set(type, render);
  return () => { if (renderers.get(type) === render) renderers.delete(type); };
}

function checkContent(content) {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > artifactConfig.maxBytes) {
    throw Error('产物不是文本或超过预览大小限制');
  }
}

function isolatedFrame(content, title) {
  const frame = document.createElement('iframe');
  frame.className = 'artifact-frame';
  frame.title = title;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  const shell = new DOMParser().parseFromString(isolatedDocument(''), 'text/html');
  const style = shell.createElement('style');
  style.textContent = 'html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}';
  shell.head.append(style);
  const child = shell.createElement('iframe');
  child.title = title;
  child.setAttribute('sandbox', 'allow-scripts');
  child.setAttribute('referrerpolicy', 'no-referrer');
  child.srcdoc = isolatedDocument(content);
  shell.body.append(child);
  frame.srcdoc = '<!doctype html>\n' + shell.documentElement.outerHTML;
  return frame;
}

registerArtifactRenderer('html', async (artifact, {signal}) => {
  const {workspaceId, path, title = '交互页面'} = artifact;
  let content = artifact.content;
  if (content === undefined) {
    if (!workspaceId || !path) throw Error('此产物没有绑定工作区，请先选择原工作区');
    const result = await api.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts/html?path=${encodeURIComponent(path)}`,
      {signal, timeout: artifactConfig.requestTimeoutMs});
    content = result.content;
  }
  checkContent(content);
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
  const frame = isolatedFrame(content, title);
  const body = document.createElement('div');
  body.className = 'artifact-document';
  const note = document.createElement('p');
  note.className = 'artifact-note';
  note.textContent = path || title;
  const toolbar = document.createElement('div');
  toolbar.className = 'artifact-toolbar';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'btn btn-ghost btn-sm';
  reload.textContent = '重新加载';
  reload.addEventListener('click', () => { frame.srcdoc = frame.srcdoc; }, {signal});
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'btn btn-ghost btn-sm';
  download.textContent = '下载 HTML';
  const blobUrl = URL.createObjectURL(new Blob([content], {type: 'text/html;charset=utf-8'}));
  download.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = path?.split(/[\\/]/).at(-1) || 'artifact.html';
    document.body.append(link); link.click(); link.remove();
  }, {signal});
  toolbar.append(reload, download);
  if (workspaceId && path) {
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'btn btn-ghost btn-sm';
    source.textContent = '查看源码';
    source.addEventListener('click', async () => {
      source.disabled = true;
      try {
        const {openWorkspaceEditor} = await import('./workspace-editor.js?v=1.0.0');
        const data = await api.request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {signal});
        if (!signal.aborted) await openWorkspaceEditor(data.workspace || data, path);
      } catch (error) {
        if (!signal.aborted) { note.textContent = `无法打开源码：${error.message}`; note.setAttribute('role', 'alert'); }
      } finally { source.disabled = false; }
    }, {signal});
    toolbar.prepend(source);
  }
  body.append(note, toolbar, frame);
  return {node: body, dispose: () => {
    frame.srcdoc = ''; frame.remove(); URL.revokeObjectURL(blobUrl);
  }};
});

for (const type of ['text', 'json']) registerArtifactRenderer(type, artifact => {
  checkContent(artifact.content);
  const node = document.createElement('pre');
  node.className = 'artifact-text';
  node.textContent = type === 'json' ? JSON.stringify(JSON.parse(artifact.content), null, 2) : artifact.content;
  return {node};
});

export function openArtifact(artifact) {
  const render = renderers.get(artifact.type);
  if (!render) throw Error(`暂不支持此产物类型：${artifact.type}`);
  if (!artifact.id && (!artifact.workspaceId || !artifact.path)) throw Error('产物需要稳定的标识或工作区路径');
  return getArtifactSidebar().open({
    id: JSON.stringify([artifact.type, artifact.workspaceId || '', artifact.id || artifact.path]),
    title: artifact.title || artifact.path || '工作产物',
    render: context => render(artifact, context),
  });
}

// Preserve the existing chat-card and project-file entry point.
export async function openHtmlArtifact(workspaceId, path, title = '交互页面') {
  if (!workspaceId) throw Error('此产物没有绑定工作区，请先选择原工作区');
  return openArtifact({type: 'html', workspaceId, path, title});
}
