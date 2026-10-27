/** Eve platform: every control talks to a real, scoped service. */
import { api, errorMessage } from '../api.js?v=2.1.1';
import { getState, navigate } from '../store.js?v=2.1.1';
import { esc, escAttr, getPref, setPref } from '../util.js?v=2.1.1';
import { icon } from '../icons.js?v=2.1.1';
import { openModal, closeAllModals, toastError, toastSuccess, toastWarn, confirmDialog, spinnerHtml } from '../ui.js?v=2.1.1';
import { applyAppearance } from '../suwen.js?v=2.1.1';
import { renderChannels } from './channel-setup.js?v=2.1.1';
import {mountResearchWorkspace} from './research-workspace.js?v=1.0.0';

const GROUPS={
 settings:[['models','智能模型','brain'],['appearance','外观与交互','eye'],['permissions','权限与执行','shield'],['budget','资源与用量','cpu'],['vision','视觉复核','figures'],['advanced','版本与迁移','settings']],
 extensions:[['mcp','MCP 服务','layers'],['skill','Skills','skills'],['agent','Agent 角色','brain'],['channel','消息渠道','chat']],
 tasks2:[['tasks','持续任务','jobs'],['schedule','自动化','clock'],['debate','多 Agent 讨论','chat']],
 knowledge:[['knowledge','记忆与知识库','memory'],['memory','检索设置','settings']],
 research:[['quests','科研工作区','layers'],['research','证据与验证','shield'],['experiments','实验比较','layers'],['biomni','生物工具','skills'],['review','视觉检查记录','eye']],
 workflow:[['workflow','工作流编排','layers']],artifacts:[['artifact','产物与版本','files']],diagnostics:[['diagnostics','系统诊断','cpu']],
};
const TITLES={settings:['设置','默认简单，需要时再深入。'],extensions:['能力中心','连接工具、专业技能与消息入口。'],tasks2:['任务中心','工作持续运行，过程随时可查。'],knowledge:['知识与记忆','只检索当前工作区，保留原始来源。'],research:['科研与证据','结论必须有来源，验证必须可复查。'],workflow:['工作流','把重复工作变成可检查的步骤。'],artifacts:['产物中心','文件、来源和历史版本在一起。'],diagnostics:['系统诊断','真实状态、用量和错误，随时可见。']};
const labels={fast:'快速',balanced:'均衡',deep:'深度',queued:'排队中',running:'执行中',paused:'已暂停',interrupted:'待恢复',failed:'失败',succeeded:'执行完成',cancelled:'已取消',waiting_approval:'等待审批',needs_review:'证据待复核',budget_limited:'预算已用尽',installed:'已安装',missing:'文件缺失',disabled:'已停用',configured:'已配置',external_dependency:'需要外部适配器',connected:'已连接',error:'连接失败'};
function badge(value){return `<span class="sw-badge status-${escAttr(value)}">${esc(labels[value]||value||'尚未检测')}</span>`;}
function field(label,id,value='',placeholder='',type='text'){return `<label class="sw-field"><span>${esc(label)}</span><input class="input" id="${id}" type="${type}" value="${escAttr(value)}" placeholder="${escAttr(placeholder)}" /></label>`;}
function area(label,id,value='',rows=5){return `<label class="sw-field"><span>${esc(label)}</span><textarea class="input sw-code" id="${id}" rows="${rows}">${esc(typeof value==='string'?value:JSON.stringify(value,null,2))}</textarea></label>`;}
function select(label,id,options,value){return `<label class="sw-field"><span>${esc(label)}</span><select class="input" id="${id}">${options.map(([v,l])=>`<option value="${escAttr(v)}" ${value===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;}
function button(action,text,kind='',id=''){return `<button class="btn ${kind||'btn-ghost'} btn-sm" data-action="${action}" ${id?`data-id="${escAttr(id)}"`:''}>${esc(text)}</button>`;}
function blank(title,hint=''){return `<div class="sw-empty">${icon('layers',{size:30})}<h3>${esc(title)}</h3><p>${esc(hint)}</p></div>`;}
function code(value){return `<pre class="sw-json">${esc(typeof value==='string'?value:JSON.stringify(value,null,2))}</pre>`;}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export async function mount(root){
 const events=new AbortController();
 const listen=(type,handler)=>root.addEventListener(type,handler,{signal:events.signal});
 const route=GROUPS[getState().route]?getState().route:'settings';
 const groups=GROUPS[route];const [title,subtitle]=TITLES[route];
 let section=groups[0][0],disposed=false,timer=0,bootstrap,items=[],flow={name:'新工作流',nodes:[]},channelView=null,skillPage=0,skillQuery='';
 const scope=()=>getState().workspaceId||'ws_main';
 const request=(path,method='GET',body)=>api.request(`/api/platform${path}${path.includes('?')?'&':'?'}scope=${encodeURIComponent(scope())}`,{method,...(body===undefined?{}:{body}),timeout:180000});
 root.innerHTML=`<div class="sw-page"><header class="sw-page-head"><div><div class="sw-eyebrow">Eve</div><h1>${esc(title)}</h1></div><span class="sw-scope">${icon('folder',{size:14})}${esc(getState().workspace?.name||scope())}</span></header><div class="sw-center"><aside class="sw-secondary"><input class="input" id="sw-search" placeholder="搜索设置与能力…" aria-label="搜索设置与能力"/><nav>${groups.map(([key,label,ico])=>`<button class="sw-section ${key===section?'is-active':''}" data-section="${key}">${icon(ico,{size:16})}<span>${label}</span></button>`).join('')}</nav></aside><main class="sw-content" id="sw-content">${spinnerHtml('正在连接平台服务…')}</main></div></div>`;
 const content=root.querySelector('#sw-content');
 function val(id){return content.querySelector('#'+id)?.value??'';}
 function checked(id){return Boolean(content.querySelector('#'+id)?.checked);}
 function json(id){return JSON.parse(val(id)||'{}');}
 async function config(key){return (await request(`/config/${key}`)).value;}
 async function save(key,value){await request(`/config/${key}`,'PUT',{value});toastSuccess('设置已保存，即时生效');bootstrap=await request('/bootstrap');applyAppearance(bootstrap.settings.appearance.value);}
 async function load(){
  if(disposed)return;
  channelView?.destroy();channelView=null;
  content.innerHTML=spinnerHtml('正在读取…');
  try{
   if(!bootstrap)bootstrap=await request('/bootstrap');
   if(section==='models')await models();
   else if(['appearance','permissions','budget','vision','memory'].includes(section))await settings(section);
   else if(section==='advanced')await advanced();
   else if(section==='channel')channelView=await renderChannels(content,{request,scope,reload:load});
   else if(section==='quests')channelView=await mountResearchWorkspace(content,{request});
   else if(section==='tasks')await tasks();
   else if(section==='debate')await debate();
   else if(section==='knowledge')await knowledge();
   else if(section==='research')await research();
   else if(section==='experiments')await experiments();
   else if(section==='biomni')await biomni();
   else if(section==='workflow')await workflow();
   else if(section==='diagnostics')await diagnostics();
   else await registry(section);
  }catch(err){content.innerHTML=blank('操作未完成',errorMessage(err))+button('reload','重试');}
 }
 async function openProviderEditor(providerId=''){
  const data=await api.settings.get();const providers=Object.values(data.providers||{});const selected=providers.find(p=>p.id===providerId)||providers[0]||{};
  const modelOptions=[selected.default_model,...(selected.models||[])].filter(Boolean).filter((m,i,a)=>a.indexOf(m)===i);
  const providerSelect=providers.map(p=>`<option value="${escAttr(p.id)}" ${p.id===selected.id?'selected':''}>${esc(p.label||p.id)}</option>`).join('');
  const html=`<div class="eve-provider-editor"><div class="eve-provider-step"><span class="eve-provider-step-number">1</span><div><strong>选择供应商</strong><small>每个供应商独立保存连接状态，其他 Key 不会被覆盖。</small></div></div><label class="sw-field"><span>供应商</span><select id="provider-editor-provider">${providerSelect}</select></label><div class="eve-provider-step"><span class="eve-provider-step-number">2</span><div><strong>填写模型连接</strong><small>先测试，再决定是否设为默认路由。</small></div></div><div class="sw-form-grid">${field('模型名称','provider-editor-model',selected.default_model||modelOptions[0]||'','例如 deepseek-chat')}${field('API Base（自定义端点必填）','provider-editor-base',selected.api_base||'','留空使用供应商默认地址')}</div>${field('API Key','provider-editor-key', '',selected.has_key?'已保存，留空保持不变':'粘贴 API Key','','password')}<label class="sw-check"><input type="checkbox" id="provider-editor-default" ${data.llm?.provider===selected.id?'checked':''}/>设为默认供应商与模型</label><label class="sw-check"><input type="checkbox" id="provider-editor-test" checked/>保存后立即测试连接</label></div>`;
  const modal=modalForm('添加 / 编辑供应商',html,async body=>{
    const provider=modalValue(body,'provider-editor-provider'),model=modalValue(body,'provider-editor-model').trim(),base=modalValue(body,'provider-editor-base').trim(),key=modalValue(body,'provider-editor-key').trim(),activate=body.querySelector('#provider-editor-default')?.checked===true;
    const meta=providers.find(p=>p.id===provider)||{};
    if(meta.needs_model&&!model)throw new Error('该供应商需要填写模型名称');
    if(meta.needs_api_base&&!base)throw new Error('该供应商需要填写 API Base');
    if(!meta.no_key_required&&!meta.has_key&&!key)throw new Error('请填写 API Key');
    const payload={provider,model,api_base:base,key,activate};
    const saved=await api.settings.saveKeys(payload);
    if(body.querySelector('#provider-editor-test')?.checked){const tested=await api.settings.testLLM({provider,model,api_base:base,api_key:key});if(!tested?.ok)throw new Error(tested?.error||'连接测试失败');}
    toastSuccess(activate?'供应商已保存并设为默认':'供应商连接已保存');
    await models();
    return saved;
  },'保存并测试');
  modal?.body?.querySelector('#provider-editor-provider')?.addEventListener('change',(event)=>{
    const next=providers.find(p=>p.id===event.target.value)||{};
    const model=next.default_model||(next.models||[])[0]||'';
    const modelInput=modal.body.querySelector('#provider-editor-model');
    const baseInput=modal.body.querySelector('#provider-editor-base');
    const keyInput=modal.body.querySelector('#provider-editor-key');
    if(modelInput)modelInput.value=model;
    if(baseInput)baseInput.value=next.api_base||'';
    if(keyInput)keyInput.placeholder=next.has_key?'已保存，留空保持不变':'粘贴 API Key';
  });
 }
 async function models(){
  const c=await config('models');const data=await api.settings.get().catch(()=>({}));const providers=Object.values(data.providers||{});const active=data.llm||{};
  const cards=providers.filter(p=>p.id!=='mock').map(p=>{const isActive=active.provider===p.id;const model=isActive&&active.model?active.model:(p.default_model||p.models?.[0]||'');return `<article class="eve-provider-card ${p.configured?'is-configured':'is-pending'} ${isActive?'is-default':''}"><div class="eve-provider-card-head"><div><span class="eve-provider-family">${esc(p.family||'兼容 API')}</span><h3>${esc(p.label||p.id)}</h3></div><span class="sw-badge ${p.configured?'status-configured':'status-missing'}">${p.configured?'已连接':'未连接'}</span></div><p>${esc(p.hint||`${(p.models||[]).length||1} 个建议模型`)}</p><div class="eve-provider-meta"><code>${esc(model||'待填写模型')}</code>${isActive?'<span class="eve-default-mark">默认路由</span>':''}</div><div class="sw-inline">${button('provider-edit',p.configured?'编辑连接':'添加连接','btn-primary',p.id)}${p.configured&&!isActive?button('provider-default','设为默认','',`${p.id}::${model}`):''}</div></article>`;}).join('');
  content.innerHTML=`<section class="sw-card sw-hero"><h2>模型连接</h2><p>多个供应商可以同时保存。当前任务只使用启动时选定的模型，切换默认路由不会中断运行中的任务。</p><div class="sw-mode-grid">${[['fast','快速','日常问答与简单处理'],['balanced','均衡','分析、写作与大多数工作'],['deep','深度','复杂问题与科研推理']].map(([id,label,desc])=>`<button class="sw-mode ${c.mode===id?'is-active':''}" data-action="mode" data-id="${id}">${icon(id==='fast'?'wand':id==='deep'?'brain':'layers',{size:22})}<strong>${label}</strong><span>${desc}</span></button>`).join('')}</div><div class="sw-inline">${button('provider-add','添加供应商','btn-primary')}${button('model-test','测试当前默认模型')}<span class="sw-muted">当前默认：${esc(active.provider||'未设置')} / ${esc(active.model||'未设置')}</span></div></section><section class="sw-card eve-provider-manager"><div class="sw-toolbar"><div><h3>供应商连接</h3><p class="sw-muted">Key 按供应商独立保存，支持 DeepSeek、OpenAI、Anthropic、通义、Ollama、自定义端点等。</p></div>${button('provider-add','添加供应商','btn-primary')}</div><div class="eve-provider-grid">${cards||blank('还没有供应商连接','添加一个供应商开始使用 Eve。')}</div></section><section class="sw-card"><h3>路由策略</h3>${select('优先考虑','model-strategy',[['quality','质量'],['latency','响应速度'],['cost','经济'],['privacy','本地隐私']],c.strategy)}<p class="sw-muted">隐私策略禁止路由到远程模型。速度与经济策略按已测延迟、价格和可用模型排序。</p><details><summary>高级：角色模型、能力与备用连接</summary>${area('角色模型：text / reasoning / vision / embedding / code','model-roles',c.roles)}${area('模型能力（按模型名；temperature、max_output、token_parameter）','model-caps',c.capabilities)}${area('备用模型列表（provider、model）','model-fallbacks',c.fallbacks,3)}${field('上下文窗口（字符预算采用保守估算）','model-context',c.context_window,'','number')}</details><label class="sw-check"><input type="checkbox" id="sage-verification" ${c.sage_verification?'checked':''}/>Sage-A1.5 自检（仅该模型，需兼容服务）</label><label class="sw-check"><input type="checkbox" id="sage-orchestration" ${c.orchestration?'checked':''}/>启用并行子任务（受现有权限与预算约束）</label>${button('save-models','保存路由配置','btn-primary')}</section>`;
 }
 async function settings(key){
  const c=await config(key);let html='';
  if(key==='appearance')html=`<div class="sw-form-grid">${select('主题','theme',[['system','跟随系统'],['light','浅色'],['dark','深色']],c.theme)}${select('字体','font',[['system','系统字体'],['sans','无衬线'],['mono','等宽']],c.font)}${field('字号','font-size',c.font_size,'','number')}${field('强调色','accent',c.accent,'','color')}${select('界面密度','density',[['comfortable','舒适'],['compact','紧凑']],c.density)}${field('圆角','radius',c.radius,'','number')}${select('工作模式','ui-mode',[['research','科研'],['minimal','极简'],['developer','开发者']],c.mode)}${select('默认首页','home',[['workbench','工作台'],['tasks2','任务中心'],['research','科研证据'],['knowledge','知识与记忆']],c.home)}${field('助手名称','agent-name',c.agent_name)}${field('助手头像（单个字符或 Emoji）','avatar',c.avatar)}${field('命令面板快捷键（Ctrl / ⌘ + 字母）','shortcut-palette',c.shortcuts?.palette||'k')}</div><p class="sw-muted">面板宽度和隐藏状态分别保存到当前工作区，可从工作台“布局”调整。</p>${button('reset-layout','恢复当前工作区布局')}`;
  if(key==='permissions')html=`<div class="sw-notice">权限在工具执行前检查。Python 与 Shell 仍有系统级能力，目录隔离不等于安全沙箱。可通过 sandbox_python 选择断网 Docker 隔离执行；需要可用的 Docker 与指定镜像。</div><div class="sw-form-grid">${Object.entries(c).filter(([k])=>k!=='tools').map(([k,v])=>select({files:'文件系统',shell:'Shell',network:'外部网络',browser:'浏览器',messages:'消息发送',mcp:'MCP',memory:'记忆',skills:'技能',agents:'Agent 协作',python:'Python',system:'环境信息',notebook:'Notebook',jobs:'后台进程'}[k]||k,'permission-'+k,[['deny','禁止使用'],['read_only','只读'],['ask','需确认'],['allow','允许执行']],v)).join('')}</div><details><summary>逐工具权限覆盖</summary>${area('工具名 → 权限','permission-tools',c.tools)}</details>`;
  if(key==='budget')html=`<div class="sw-notice">按工作区设置并发数。运行时保留取消、超时与 Token 预算，停止原因可在运行记录中查看。</div><div class="sw-form-grid">${field('任务并发数','budget-concurrency',c.concurrency,'','number')}</div><details><summary>费用统计价格（可选，不影响自动停止策略）</summary>${area('模型名 → 每百万输入 / 输出 Token 价格','budget-prices',c.prices)}</details>`;
  if(key==='vision')html=`<label class="sw-check"><input type="checkbox" id="vision-enabled" ${c.enabled?'checked':''}/>启用独立视觉复核</label><label class="sw-check"><input type="checkbox" id="vision-auto" ${c.auto_review?'checked':''}/>图表生成后自动复核</label><div class="sw-form-grid">${field('视觉模型','vision-model',c.model)}${field('API Base URL','vision-base',c.api_base)}${field('加密凭据引用','vision-ref',c.credential_ref,'例如 vision')}${field('最多修正轮次','vision-repairs',c.max_repairs,'','number')}</div>${button('credential','保存视觉 API Key')}<p class="sw-muted">视觉模型可检查布局与文字；不能仅凭图片确认科学事实。缺少原始数据会标记人工复核。</p>`;
  if(key==='memory')html=`<label class="sw-check"><input type="checkbox" id="memory-enabled" ${c.enabled?'checked':''}/>启用当前工作区记忆</label><label class="sw-check"><input type="checkbox" id="memory-auto" ${c.auto_capture?'checked':''}/>选择性保存较长的任务结论（默认关闭）</label>${select('检索方式','memory-embedding',[['keyword','本地关键词与中文二元词检索'],['api','关键词 + 独立嵌入 API']],c.embedding)}<div class="sw-form-grid">${field('Embedding API Base URL','memory-url',c.embedding_url)}${field('Embedding 模型','memory-model',c.embedding_model)}${field('检索条数','memory-top',c.top_k,'','number')}${field('记忆有效天数','memory-retention',c.retention_days,'','number')}</div>${button('embedding-key','保存 Embedding API Key')}${button('reembed','重新嵌入当前工作区')}<p class="sw-muted">API 嵌入会向指定服务发送文本；敏感凭据会被筛出。默认本地检索不会传出知识正文。</p>`;
  if(key==='appearance' && window.suwenDesktop){
   const closeAction=await window.suwenDesktop.getCloseAction();
   html+=`<div class="sw-field"><label>关闭窗口时</label><select class="input" id="desktop-close-action"><option value="ask">每次询问</option><option value="tray">最小化到系统托盘</option><option value="quit">退出程序</option></select><p class="sw-muted">退出前会提示未完成任务；托盘保持后台任务和 SSH 连接。</p></div>`;
   queueMicrotask(()=>{const node=content.querySelector('#desktop-close-action');if(node){node.value=closeAction;node.addEventListener('change',async()=>{try{await window.suwenDesktop.setCloseAction(node.value);toastSuccess('关闭方式已保存');}catch(error){toastError(errorMessage(error));}});}});
  }
  content.innerHTML=`<section class="sw-card"><h2>${esc(groups.find(g=>g[0]===key)?.[1]||key)}</h2>${html}<div class="sw-form-footer">${button('save-'+key,'保存并应用','btn-primary')}${button('reset-config','恢复默认值')}</div></section>`;
 }
 async function advanced(){
  content.innerHTML=`<section class="sw-card"><h2>配置与迁移</h2><p>Schema V2 与旧版数据目录并存。配置修改保留版本，升级前已备份旧设置与任务数据库。</p><div class="sw-inline">${button('export-config','导出脱敏配置','btn-primary')}${button('import-config','导入配置')}${button('backup','备份平台数据库')}${button('connections','旧版连接设置')}</div><input type="file" id="config-file" accept=".json" hidden/><details><summary>查看配置历史与回滚</summary>${select('设置分类','history-section',Object.keys(bootstrap.settings).map(k=>[k,k]),'models')}${button('config-history','载入历史版本')}<div id="sw-history"></div></details><details><summary>迁移记录</summary>${code(bootstrap.migration)}</details></section>`;
 }
 async function tasks(){
  items=(await request('/tasks')).items;
  content.innerHTML=`<div class="sw-toolbar"><div><h2>任务不会随页面关闭而终止</h2><p>后端需要保持运行；中断的当前节点需要检查后恢复。</p></div>${button('new-task','新建任务','btn-primary')}${button('reload','刷新')}</div><div class="sw-stack">${items.length?items.map(task=>`<article class="sw-card sw-task"><header><div><span class="sw-overline">${esc(task.id)}</span><h3>${esc(task.title)}</h3></div>${badge(task.status)}</header><div class="sw-progress">${task.workflow.nodes.map(n=>`<span class="${escAttr(task.nodes[n.id]?.status||'pending')}" title="${escAttr(n.id)}"></span>`).join('')}</div>${task.error?`<p class="sw-error">${esc(task.error)}</p>`:''}<div class="sw-inline">${button('task-detail','查看步骤与结果','',task.id)}${['queued','running'].includes(task.status)?button('task-pause','暂停','',task.id)+button('task-cancel','取消','',task.id):''}${['paused','failed','interrupted','budget_limited','needs_review'].includes(task.status)?button('task-resume','检查后恢复','btn-primary',task.id):''}${task.status==='waiting_approval'?button('task-approve','批准节点','btn-primary',task.id):''}</div></article>`).join(''):blank('还没有持续任务','创建一个任务，或从工作流模板发起。')}</div>`;
 }
 async function debate(){content.innerHTML=`<section class="sw-card"><div class="sw-kicker">SCIENTIFIC ROUNDTABLE</div><h2>允许分歧，也要求给出结论。</h2><p>参与者互读观点，裁判提出争议；下一轮可以质疑裁判。保留少数意见与证据缺口。</p>${area('研究问题','debate-question','',4)}${area('参与 Agent ID 数组','debate-agents',['hypothesis-smith','evidence-critic'],3)}${field('讨论轮数（最多 5）','debate-rounds',2,'','number')}${button('start-debate','创建讨论任务','btn-primary')}</section>`;}
 async function registry(kind){
  const data=await request(`/registry/${kind}`+(kind==='skill'?`?limit=32&offset=${skillPage*32}&q=${encodeURIComponent(skillQuery)}`:''));items=data.items;
  const names={mcp:'MCP 服务',skill:'Skills',agent:'Agent',channel:'消息渠道',schedule:'自动化',artifact:'产物快照',review:'视觉检查'};
  const create=kind==='review'?'':button('new-'+kind,kind==='artifact'?'登记文件快照':kind==='skill'?'安装技能':kind==='mcp'?'安装 MCP 服务':'添加'+(names[kind]||kind),'btn-primary');
  content.innerHTML=`<div class="sw-toolbar"><div><h2>${names[kind]||kind}</h2><p>${kind==='mcp'?'stdio / Streamable HTTP，服务故障与平台隔离。':kind==='channel'?'WebChat、Telegram 可用；其他平台需外部协议或适配器。':kind==='artifact'?'记录文件摘要、任务来源与可恢复版本。':'真实安装与运行状态，依赖不足会明确显示。'}</p></div>${create}${kind==='mcp'?button('import-mcp','导入 JSON'):''}${button('reload','刷新')}</div><div class="sw-grid">${items.map(item=>`<article class="sw-card"><header><div><span class="sw-overline">${esc(item.transport||item.adapter||item.version||item.id)}</span><h3>${esc(item.name||item.title||item.path||item.id)}</h3></div>${badge(typeof item.status==='object'?item.status?.status:item.status||(!item.enabled&&['mcp','channel','skill'].includes(kind)?'disabled':item.enabled?'configured':'snapshot'))}</header>${item.description?`<p>${esc(item.description)}</p>`:''}${item.status?.error?`<p class="sw-error">${esc(item.status.error)}</p>`:''}${kind==='channel'&&item.capabilities?.reason?`<p class="sw-muted">${esc(item.capabilities.reason)}</p>`:''}${kind==='schedule'?`<p>下次执行：${new Date(item.next_run*1000).toLocaleString()}</p>`:''}${kind==='artifact'?`<p>${esc(item.bytes)} bytes · ${esc(item.digest?.slice(0,16))}</p>`:''}<div class="sw-inline">${kind==='mcp'?button('mcp-discover','测试并发现工具','',item.id)+button('mcp-test','工具测试','',item.id):''}${kind==='channel'?button('channel-test','测试连接','',item.id)+button('channel-message','收发测试','',item.id):''}${kind==='skill'?button('skill-detail','查看与使用','',item.id):''}${['mcp','channel','skill','schedule'].includes(kind)?button('toggle-record',item.enabled?'停用':'启用','',item.id):''}${['mcp','channel','agent'].includes(kind)?button('edit-record','编辑','',item.id):''}${(['skill','artifact'].includes(kind)&&item.runtime!=='desktop')?button('record-history','版本历史','',item.id):''}${kind==='artifact'?`<a class="btn btn-ghost btn-sm" target="_blank" href="/api/workspaces/${encodeURIComponent(scope())}/files/raw?path=${encodeURIComponent(item.path)}">预览文件</a>`:''}${kind!=='review'?button('remove-record','移除','',item.id):''}</div><details><summary>${kind==='mcp'?'能力、权限与诊断':'详细记录'}</summary>${code(item)}</details></article>`).join('')}</div>${!items.length?blank('尚未添加'+(names[kind]||kind),'添加后可以检测、启停和查看详细状态。'):''}`;
  if(kind==='skill'){
   content.insertAdjacentHTML('afterbegin',`<div class="sw-toolbar"><input class="input" id="skill-query" placeholder="搜索已安装技能…" value="${escAttr(skillQuery)}"/>${button('skill-search','搜索')}<span>${data.total} 项 · 第 ${skillPage+1} 页</span>${skillPage?button('skill-prev','上一页'):''}${(skillPage+1)*32<data.total?button('skill-next','下一页'):''}</div>`);
  }
  if(kind==='skill')content.innerHTML+=`<section class="sw-card"><h2>Scientific Agent 方法技能</h2><p>预装的是带来源的操作方法；上游组件与 API 的安装状态单独显示。</p><div class="sw-grid">${data.scientific.map(s=>`<article class="sw-method"><h3>${esc(s.name)}</h3>${badge(s.status)}<p>${esc(s.description)}</p><span class="sw-muted">上游：${esc(s.upstream_status)} · ${esc(s.version)}</span><p><a target="_blank" rel="noopener" href="${escAttr(s.source)}">查看原始来源 ↗</a></p><details><summary>依赖与运行要求</summary>${code(s.dependencies)}</details></article>`).join('')}</div></section>`;
 }
 async function knowledge(){
  items=(await request('/knowledge')).items;
  content.innerHTML=`<div class="sw-toolbar"><div><h2>可检索的项目知识</h2><p>自动记忆默认关闭；每条信息保留类型与来源。</p></div>${button('new-memory','添加记忆','btn-primary')}${button('upload-source','导入文档')}${button('export-memory','导出')}</div><div class="sw-search-row"><input class="input" id="memory-query" placeholder="搜索当前工作区的记忆、知识与来源…"/>${button('search-memory','混合检索')}</div><input type="file" id="source-file" accept=".txt,.md,.pdf,.docx,.csv,.json,.py" hidden/><div id="memory-results" class="sw-stack">${items.length?items.map(memoryCard).join(''):blank('当前工作区还没有记忆','添加笔记，或导入 Markdown、PDF、Word 等知识源。')}</div>`;
 }
 function memoryCard(item){return `<article class="sw-card"><header><h3>${esc(item.title)}</h3>${badge(item.kind)}</header><p class="sw-memory-body">${esc(item.text.slice(0,500))}</p><div class="sw-muted">${esc(item.source||'用户记忆')} ${esc(item.locator||'')}${item.score!==undefined?' · relevance '+esc(item.score):''}</div>${item.conflicts?.length?'<p class="sw-error">检测到同标题的不同内容，请检查冲突。</p>':''}<div class="sw-inline">${button('edit-memory','查看 / 编辑','',item.id)}${button('delete-memory','删除','',item.id)}</div></article>`;}
 async function research(){
  const data=await request('/research');items=data.claims;
  content.innerHTML=`<section class="sw-card sw-hero"><div class="sw-kicker">EVIDENCE BEFORE CONCLUSIONS</div><h2>让每一项发现，都能回到证据。</h2><p>文献元数据、代码运行与科学验证是不同层次。执行成功不会自动把生物学结论标为成立。</p><div class="sw-metrics"><div><strong>${data.sources.length}</strong><span>可追溯来源</span></div><div><strong>${data.claims.length}</strong><span>登记结论</span></div><div><strong>${data.gates.filter(g=>g.status==='needs_review').length}</strong><span>待复核运行</span></div></div></section><div class="sw-toolbar">${button('literature','检索文献','btn-primary')}${button('record-claim','登记结论')}${button('reload','刷新')}</div><div class="sw-stack">${data.claims.map(c=>`<article class="sw-card"><header><h3>${esc(c.statement)}</h3>${badge(c.validation_status)}</header><p>类型：${esc(c.kind)} · 来源 ${c.sources.length} 条 · 运行 ${esc(c.run||'未关联')}</p>${code(c.checks)}<p class="sw-muted">${esc(c.limitations)}</p><div class="sw-inline">${button('verify-claim','执行独立指标检查','',c.id)}${button('review-claim','人工复核','',c.id)}</div></article>`).join('')||blank('还没有登记的结论','科研 Agent 可在执行过程中登记结论，系统在任务结束时检查证据状态。')}</div><details class="sw-card"><summary>证据门禁与来源列表</summary>${code(data.gates)}${code(data.sources)}</details>`;
 }
 async function experiments(){items=(await request('/experiments')).items;
  content.innerHTML=`<section class="sw-card"><h2>让候选方案接受同一把尺子。</h2><p>读取工作区中实际的 JSON 指标文件。只有数据集、评估协议和目标指标一致，才允许比较；排序不会自动验证科学结论。</p>${button('new-experiment','登记实验','btn-primary')}${button('compare-experiments','比较已登记实验')}<div class="sw-stack">${items.map(item=>`<article class="sw-card"><label class="sw-check"><input type="checkbox" data-exp-id="${escAttr(item.id)}"/>选择实验</label><h3>${esc(item.name)}</h3><p>${esc(item.dataset)} · ${esc(item.protocol)} · ${esc(item.metric)} = ${esc(item.score)}</p><details><summary>来源与指标摘要</summary>${code(item)}</details></article>`).join('')||blank('尚无实验记录','先运行分析，将指标保存为 JSON，再登记比较。')}</div></section>`;
 }
 async function biomni(){const data=await request('/biomedical');content.innerHTML=`<section class="sw-card"><div class="sw-kicker">BIOMEDICAL TOOLBOX</div><h2>检索规划 + 代码执行 + 证据检查</h2><p>借鉴 Biomni 的工具检索与可执行分析模式。本地轻量实现已接入Eve工具链；不会假称安装了完整 Biomni E1 或数据湖。</p>${badge(data.upstream_installed?'upstream_detected':'upstream_not_installed')}<a href="${escAttr(data.source)}" target="_blank" rel="noopener"> Biomni 官方仓库 ↗</a><div class="sw-search-row"><input class="input" id="bio-query" placeholder="例如：DNA 质量检查、蛋白注释、证据验证…"/>${button('bio-search','检索工具')}</div><div id="bio-results">${code(data.tools)}</div><div class="sw-inline">${button('sequence','DNA 序列检查')}${button('protein','UniProt 查询')}${button('literature','文献检索')}</div></section>`;}
 async function diagnostics(){const d=await request('/diagnostics');content.innerHTML=`<div class="sw-toolbar"><div><h2>系统运行中</h2><p>诊断读取真实状态；模型与外部服务测试会独立进行。</p></div>${button('reload','健康检查','btn-primary')}${button('export-diagnostics','导出报告')}</div><div class="sw-metrics">${[['队列',d.tasks.queued||0],['运行任务',d.tasks.running||0],['异常',d.tasks.failed||0],['累计 Token',d.usage.tokens||0]].map(([l,v])=>`<div><strong>${esc(v)}</strong><span>${l}</span></div>`).join('')}</div><section class="sw-card"><h3>组件状态</h3><div class="sw-status-grid"><div>Agent Runtime ${badge(d.runtime)}</div><div>Model Gateway ${badge(d.gateway)}</div><div>模型 ${badge(d.model.provider==='mock'?'mock_test_mode':d.model.configured?'configured':'unconfigured')}</div><div>MCP 服务 ${d.mcp.length}</div><div>消息渠道 ${d.channels.length}</div><div>OS 安全沙箱 ${badge(d.sandbox.binary_available?'docker_daemon_not_probed':'docker_unavailable')}</div></div>${button('model-test','实测当前模型连接')}<details><summary>资源、用量与依赖</summary>${code(d.resources)}${code(d.usage)}${code(d.external_dependencies)}${code(d.sandbox)}</details></section><section class="sw-card"><h3>最近日志与追踪</h3>${d.logs.length?d.logs.map(log=>`<div class="sw-log"><time>${new Date(log.created*1000).toLocaleString()}</time><strong>${esc(log.kind)}</strong>${code(log.data)}</div>`).join(''):blank('暂无异常记录')}</section>`;}
 async function workflow(){
  items=(await request('/registry/workflow')).items;
  content.innerHTML=`<div class="sw-toolbar"><div><h2>可检查、可恢复的执行步骤</h2><p>依赖关系控制串行与并行；节点拖动调整画布位置。</p></div>${button('new-flow','新建流程','btn-primary')}${button('draft-flow','从目标生成初稿')}${button('import-flow','导入模板')}<input type="file" id="flow-file" accept=".json" hidden/></div><div class="sw-flow-editor"><div class="sw-inline">${field('流程名称','flow-name',flow.name||'新工作流')}${button('add-node','添加节点')}${button('save-flow','保存模板','btn-primary')}</div><div class="sw-flow-canvas" id="flow-canvas"></div></div><section class="sw-card"><h3>已保存模板</h3>${items.map(f=>`<div class="sw-list-row"><strong>${esc(f.name||f.id)}</strong><span>${f.nodes.length} 个节点</span>${button('load-flow','编辑','',f.id)}${button('run-flow','创建任务','btn-primary',f.id)}${button('export-flow','导出','',f.id)}</div>`).join('')||blank('还没有模板','先添加模型、工具、条件、审批或输出节点。')}</section>`;
  renderCanvas();
 }
 function renderCanvas(){const canvas=content.querySelector('#flow-canvas');if(!canvas)return;
  canvas.innerHTML=flow.nodes.length?`<svg class="sw-flow-lines" width="1600" height="900" aria-hidden="true">${flow.nodes.flatMap((n,i)=>(n.depends_on||[]).map(dep=>{const from=flow.nodes.findIndex(x=>x.id===dep);if(from<0)return '';const a=flow.nodes[from].position||{x:24+(from%4)*260,y:24+Math.floor(from/4)*180};const b=n.position||{x:24+(i%4)*260,y:24+Math.floor(i/4)*180};return `<path d="M${a.x+215},${a.y+55} C${a.x+245},${a.y+55} ${b.x-30},${b.y+55} ${b.x},${b.y+55}"/>`;})).join('')}</svg>`+flow.nodes.map((n,i)=>{const pos=n.position||{x:24+(i%4)*260,y:24+Math.floor(i/4)*180};return `<article class="sw-flow-node" style="left:${Number(pos.x)}px;top:${Number(pos.y)}px" data-node="${escAttr(n.id)}"><div class="sw-flow-grab">${icon('layers',{size:14})}${esc(n.type)}<span>⠿</span></div><h4>${esc(n.id)}</h4><p>${esc((n.prompt||n.tool||n.text||'等待配置').slice(0,60))}</p>${button('edit-node','编辑','',n.id)}${button('delete-node','移除','',n.id)}</article>`;}).join(''):blank('添加第一个步骤','依赖相同前置节点的步骤会并行运行。');
 }
 function modalForm(title,html,onSave,label='保存'){return openModal({title,size:'lg',html:`<div class="sw-modal-form">${html}</div>`,actions:[{label:'取消',kind:'ghost'},{label,kind:'primary',onClick:async({body})=>{try{await onSave(body);return true;}catch(err){toastError(errorMessage(err));return false;}}}]});}
 function modalValue(body,id){return body.querySelector('#'+id)?.value??'';}
 function modalJSON(body,id){return JSON.parse(modalValue(body,id)||'{}');}
 async function newRecord(kind,item={}){
  // Capability installation flows replace one another. A completed request may
  // render its new card a moment before the previous modal's exit animation
  // finishes, so an immediate second click must not create two backdrops.
  closeAllModals();
  let html='';
  if(kind==='mcp')html=field('服务名称','record-name',item.name)+select('连接方式','record-transport',[['stdio','stdio 本地进程'],['http','Streamable HTTP']],item.transport||'stdio')+select('工具权限','record-read-only',[['true','只读：仅调用标注为 readOnlyHint 的工具'],['false','可写：每次调用遵循请求批准 / 帮我审核 / 完全权限']],String(item.read_only!==false))+field('命令（stdio，仅填写可执行文件）','record-command',item.command,'python / node')+area('参数数组（stdio）','record-args',item.args||[],3)+field('服务 URL（HTTP）','record-url',item.url,'https://server.example/mcp')+area('允许工作区 ID 数组','record-workspaces',item.workspaces||[scope()],2)+area('允许 Agent ID 数组（空数组表示当前已授权工作区内所有 Agent）','record-agents',item.agents||[],2)+area('高级：env_refs / header_refs / 工具白名单','record-extra',{env_refs:item.env_refs||{},header_refs:item.header_refs||{},tools:item.tools||[]},3)+'<label class="sw-check"><input type="checkbox" id="record-verify" checked/>安装后立即连接服务并发现真实工具；只有验证成功才显示安装成功。</label><p class="sw-muted">stdio 命令必须已在本机安装；HTTP 凭据通过 env_refs 或 header_refs 引用加密凭据。安装不会自动执行任何工具。</p>';
  if(kind==='agent')html=field('Agent 名称','record-name',item.name)+field('角色描述','record-description',item.description)+area('角色指令','record-instructions',item.instructions||'',5)+area('工具组','record-toolsets',item.toolsets||['files','python','skills','system','research','network','mcp'],3)+area('允许技能名称（空数组不限制）','record-skills',item.skills||[],2)+field('独立模型（留空沿用路由）','record-model',item.model)+field('独立 Provider（留空沿用默认）','record-provider',item.provider);
  if(kind==='channel')html=field('渠道名称','record-name',item.name)+select('适配器','record-adapter',[['webchat','WebChat 本地消息'],['telegram','Telegram Bot'],['wechat','微信：需外部适配器'],['wecom','企业微信：需外部适配器'],['feishu','飞书：需外部适配器'],['qq','QQ：需外部适配器'],['openclaw','OpenClaw：需桥接适配器']],item.adapter||'webchat')+field('绑定工作区','record-workspace',item.workspace||scope())+field('绑定 Agent','record-agent',item.agent||'lead')+area('授权联系人 ID 数组（默认拒绝陌生人）','record-contacts',item.contacts||[],2)+field('Token 的加密凭据引用','record-credential',item.credential_ref)+field('Webhook 共享密钥的凭据引用','record-webhook',item.webhook_ref)+'<p class="sw-muted">默认只读，禁止主动发送。需要更高权限时，在确认配置后单独启用。</p>'+area('高级权限','record-extra',{read_only:item.read_only!==false,allow_send:!!item.allow_send},2);
  if(kind==='schedule')html=field('自动化名称','record-name',item.name)+field('执行间隔（分钟，至少 1）','record-interval',(item.interval||3600)/60,'','number')+area('任务参数（prompt / workflow_id）','record-task',item.task||{prompt:'汇总当前项目的待解决问题'},4);
  modalForm(item.id?'编辑配置':kind==='mcp'?'安装 MCP 服务':'添加'+kind,html,async body=>{
    const get=id=>modalValue(body,'record-'+id);let data;
    if(kind==='mcp')data={name:get('name'),transport:get('transport'),read_only:get('read-only')!=='false',command:get('command'),args:modalJSON(body,'record-args'),url:get('url'),workspaces:modalJSON(body,'record-workspaces'),agents:modalJSON(body,'record-agents'),...modalJSON(body,'record-extra'),enabled:item.id?item.enabled!==false:true};
    if(kind==='agent')data={name:get('name'),description:get('description'),instructions:get('instructions'),toolsets:modalJSON(body,'record-toolsets'),skills:modalJSON(body,'record-skills'),model:get('model'),provider:get('provider')};
    if(kind==='channel')data={name:get('name'),adapter:get('adapter'),workspace:get('workspace'),agent:get('agent'),contacts:modalJSON(body,'record-contacts'),credential_ref:get('credential'),webhook_ref:get('webhook'),enabled:item.enabled||false,...modalJSON(body,'record-extra')};
    if(kind==='schedule')data={name:get('name'),interval:Number(get('interval'))*60,task:modalJSON(body,'record-task'),enabled:item.enabled||false};
    const saved=await request('/registry/'+kind+(item.id?'/'+encodeURIComponent(item.id):''),item.id?'PUT':'POST',data);
    if(kind==='mcp'&&body.querySelector('#record-verify')?.checked){
      try{const result=await request(`/mcp/${encodeURIComponent(saved.id)}/discover`,'POST',{});toastSuccess(`MCP 已安装并验证，发现 ${result.tools.length} 个工具`);}
      catch(err){await load();throw new Error(`配置已保存，但 MCP 安装验证失败：${errorMessage(err)}`);}
    }else toastSuccess(kind==='mcp'?'MCP 配置已保存，尚未验证':'已保存');
    await load();
  },kind==='mcp'?'安装并验证':'保存');
 }
 function editNode(node={id:'step'+(flow.nodes.length+1),type:'model',prompt:'',depends_on:[]}){
  modalForm('工作流节点',field('节点 ID','node-id',node.id)+select('类型','node-type',[['model','模型 / Agent'],['tool','工具'],['condition','条件判断'],['verify','独立指标验证'],['approval','人工审批'],['output','结果输出']],node.type)+area('依赖节点 ID 数组','node-deps',node.depends_on||[],2)+area('配置（prompt / agent / tool / arguments / contains / text / when）','node-data',Object.fromEntries(Object.entries(node).filter(([k])=>!['id','type','depends_on','position'].includes(k))),5),async body=>{
    const next={...modalJSON(body,'node-data'),id:modalValue(body,'node-id'),type:modalValue(body,'node-type'),depends_on:modalJSON(body,'node-deps'),position:node.position};
    const index=flow.nodes.findIndex(n=>n.id===node.id);if(index<0)flow.nodes.push(next);else flow.nodes[index]=next;renderCanvas();
  });
 }
 listen('click',async event=>{
  const nav=event.target.closest('[data-section]');if(nav){closeAllModals();section=nav.dataset.section;root.querySelectorAll('[data-section]').forEach(n=>n.classList.toggle('is-active',n===nav));await load();return;}
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action,id=target.dataset.id,item=items.find(r=>r.id===id);
  target.disabled=true;
  try{
   if(action==='skill-search'){skillQuery=val('skill-query');skillPage=0;await registry('skill');}
   else if(action==='skill-prev'){skillPage=Math.max(0,skillPage-1);await registry('skill');}
   else if(action==='skill-next'){skillPage++;await registry('skill');}
   else if(action==='reload')await load();
    else if(action==='connections'||action==='provider-add')await openProviderEditor();
    else if(action==='provider-edit')await openProviderEditor(id);
    else if(action==='provider-default'){const [provider,model]=(id||'').split('::');await api.settings.update({provider,model});toastSuccess('默认模型已切换');await models();}
   else if(action==='mode'){await save('models',{mode:id});await models();}
   else if(action==='save-models')await save('models',{sage_verification:checked('sage-verification'),orchestration:checked('sage-orchestration'),strategy:val('model-strategy'),roles:json('model-roles'),capabilities:json('model-caps'),fallbacks:json('model-fallbacks'),context_window:Number(val('model-context'))});
   else if(action==='save-appearance')await save('appearance',{theme:val('theme'),font:val('font'),font_size:Number(val('font-size')),accent:val('accent'),density:val('density'),radius:Number(val('radius')),mode:val('ui-mode'),home:val('home'),agent_name:val('agent-name'),avatar:val('avatar'),shortcuts:{palette:val('shortcut-palette')}});
   else if(action==='save-permissions'){const data={tools:json('permission-tools')};content.querySelectorAll('[id^="permission-"]').forEach(e=>{if(e.id!=='permission-tools')data[e.id.slice(11)]=e.value;});await save('permissions',data);}
   else if(action==='save-budget')await save('budget',{concurrency:Number(val('budget-concurrency')),prices:json('budget-prices')});
   else if(action==='save-vision')await save('vision',{enabled:checked('vision-enabled'),auto_review:checked('vision-auto'),model:val('vision-model'),api_base:val('vision-base'),credential_ref:val('vision-ref'),max_repairs:Number(val('vision-repairs'))});
   else if(action==='save-memory'){if(val('memory-embedding')==='api'&&!await confirmDialog({title:'启用外部嵌入服务',message:'检索和索引时，会向你配置的 API 发送当前工作区的文本。确认已完成敏感数据检查。',confirmText:'确认启用'}))return;await save('memory',{enabled:checked('memory-enabled'),auto_capture:checked('memory-auto'),embedding:val('memory-embedding'),embedding_url:val('memory-url'),embedding_model:val('memory-model'),top_k:Number(val('memory-top')),retention_days:Number(val('memory-retention'))});}
   else if(action==='reset-config'){if(await confirmDialog({title:'恢复默认设置',message:'将当前分类恢复默认值，修改历史仍会保留。'})){await request('/config/'+section+'/reset','POST');await load();}}
   else if(action==='credential'||action==='embedding-key')modalForm('加密保存凭据',field('凭据名称','vault-id',action==='embedding-key'?'embedding':'vision')+field('API Key / Token / 完整 Authorization 值','vault-value','','','password')+'<p class="sw-muted">Windows 使用当前账户的 DPAPI 加密，不写入普通配置与日志。</p>',async body=>{await request('/credentials/'+encodeURIComponent(modalValue(body,'vault-id')),'POST',{value:modalValue(body,'vault-value'),persist:true});toastSuccess('凭据已加密保存');});
   else if(action==='reembed'){const result=await request('/knowledge/reembed','POST',{});toastSuccess(`已更新 ${result.updated} 条索引`);}
   else if(action==='export-config')download('suwen-config.json',await request('/configuration/export'));
   else if(action==='import-config')content.querySelector('#config-file').click();
   else if(action==='backup'){const result=await request('/backup','POST',{});toastSuccess('备份已保存：'+result.path);}
   else if(action==='config-history'){const key=val('history-section'),rows=(await request('/config/'+key+'/history')).items;content.querySelector('#sw-history').innerHTML=rows.map(r=>`<div class="sw-list-row"><span>${key} · v${r.revision}</span>${button('rollback-config','回滚到此版本','',key+':'+r.revision)}</div>`).join('')||blank('尚无历史版本');}
   else if(action==='rollback-config'){const [key,revision]=id.split(':');await request('/config/'+key+'/rollback','POST',{revision:Number(revision)});toastSuccess('已回滚');}
   else if(action==='new-task')modalForm('创建持续任务',field('任务名称','task-title')+area('任务目标','task-prompt','',5),async body=>{await request('/tasks','POST',{title:modalValue(body,'task-title'),prompt:modalValue(body,'task-prompt')});await load();},'创建任务');
   else if(action==='task-detail')openModal({title:item.title,size:'xl',html:code(item),actions:[{label:'关闭',kind:'ghost'}]});
   else if(action.startsWith('task-')){const operation=action.slice(5);if(['resume','approve','cancel'].includes(operation)&&!await confirmDialog({title:operation==='resume'?'恢复前检查':'确认任务操作',message:operation==='resume'?'确认已检查当前节点的外部操作。系统将保留已完成节点，从未完成节点继续。':'确认执行此操作。'}))return;await request(`/tasks/${id}/${operation}`,'POST',{confirmed:true});await load();}
   else if(action==='start-debate'){await request('/debate','POST',{question:val('debate-question'),agents:json('debate-agents'),rounds:Number(val('debate-rounds'))});section='tasks';await load();}
   else if(['new-mcp','new-agent','new-channel','new-schedule'].includes(action))await newRecord(action.slice(4));
   else if(action==='edit-record')await newRecord(section,item);
   else if(action==='skill-detail')navigate('skills',{skillName:item.name});
   else if(action==='toggle-record'){await request(`/registry/${section}/${id}`,'PUT',{enabled:!item.enabled});await load();}
   else if(action==='remove-record'){if(await confirmDialog({title:'移除记录',message:'记录将进入可恢复存档；不会删除工作区文件。'})){await request(`/registry/${section}/${id}`,'DELETE');await load();}}
   else if(action==='mcp-discover'){const result=await request(`/mcp/${id}/discover`,'POST',{});toastSuccess(`实际发现 ${result.tools.length} 个工具`);await load();}
   else if(action==='mcp-test')modalForm('测试 MCP 工具',field('工具名称','mcp-tool')+area('工具参数','mcp-args',{},4)+'<p class="sw-error">此操作会真实调用服务工具，可能读取文件、发送消息或产生其他外部操作。请先检查参数。</p>',async body=>{if(!await confirmDialog({title:'执行真实 MCP 工具',message:'确认已检查工具与参数，并允许此次调用。',confirmText:'执行'}))throw new Error('已取消');const result=await request(`/mcp/${id}/test-tool`,'POST',{name:modalValue(body,'mcp-tool'),arguments:modalJSON(body,'mcp-args'),approved:true});openModal({title:'实际工具返回',size:'lg',html:code(result),actions:[{label:'关闭'}]});},'测试工具');
   else if(action==='import-mcp')modalForm('导入 MCP 配置',area('标准 mcpServers JSON；导入后默认停用','mcp-import',{mcpServers:{}},9),async body=>{await request('/mcp/import','POST',modalJSON(body,'mcp-import'));await load();});
   else if(action==='new-skill')modalForm('审核并安装 Skill',field('本地技能目录（skill.json）或 GitHub tree 目录链接','skill-source')+field('仓库子目录','skill-subpath','.')+field('固定分支 / Tag','skill-ref')+'<label class="sw-check"><input type="checkbox" id="skill-trusted"/>我已审核来源与权限，允许复制技能文件；不会自动执行脚本。</label>',async body=>{await request('/skills/install','POST',{source:modalValue(body,'skill-source'),subpath:modalValue(body,'skill-subpath'),ref:modalValue(body,'skill-ref'),trusted:body.querySelector('#skill-trusted').checked});await load();});
   else if(action==='channel-test'){const result=await request(`/channels/${id}/test`,'POST',{});openModal({title:'渠道测试结果',html:code(result),actions:[{label:'关闭'}]});}
   else if(action==='channel-message')modalForm('渠道收发测试',field('已授权联系人 ID','channel-contact')+area('消息文本','channel-text','',3)+field('Webhook 共享密钥（入站测试）','channel-secret','','','password')+select('方向','channel-direction',[['inbound','入站：发起任务'],['outbound','出站：向联系人发送']],'inbound'),async body=>{const direction=modalValue(body,'channel-direction');if(direction==='outbound'){if(!await confirmDialog({title:'发送真实消息',message:'将向所填写的授权联系人发送这段文本。',confirmText:'发送'}))throw new Error('已取消');await request(`/channels/${id}/send`,'POST',{contact:modalValue(body,'channel-contact'),text:modalValue(body,'channel-text'),approved:true});}else await api.request(`/api/platform/channels/${id}/webhook`,{method:'POST',headers:{'X-Eve-Token':modalValue(body,'channel-secret')},body:{contact:modalValue(body,'channel-contact'),text:modalValue(body,'channel-text'),message_id:crypto.randomUUID()}});toastSuccess('请求已处理，入站任务可在任务中心查看');});
   else if(action==='new-memory'||action==='edit-memory'){const memory=action==='edit-memory'?items.find(r=>r.id===id):{};modalForm('项目记忆',field('标题','memory-title',memory.title)+area('正文','memory-text',memory.text||'',7),async body=>{await request('/knowledge'+(id?'/'+id:''),id?'PUT':'POST',{title:modalValue(body,'memory-title'),text:modalValue(body,'memory-text')});await load();});}
   else if(action==='delete-memory'){if(await confirmDialog({title:'删除记忆',message:'此记忆将移入可恢复存档。'})){await request('/knowledge/'+id,'DELETE');await load();}}
   else if(action==='search-memory'){items=(await request('/knowledge/search','POST',{query:val('memory-query')})).items;content.querySelector('#memory-results').innerHTML=items.map(memoryCard).join('')||blank('没有匹配结果','不会跨工作区搜索。');}
   else if(action==='upload-source')content.querySelector('#source-file').click();
   else if(action==='export-memory')download('suwen-memory.json',await request('/knowledge'));
   else if(action==='bio-search'){const result=await request('/biomedical/tools','POST',{query:val('bio-query')});content.querySelector('#bio-results').innerHTML=code(result);}
   else if(action==='sequence')modalForm('DNA 序列检查',area('DNA 序列','dna-sequence','ACGTNN',5),async body=>{const result=await request('/biomedical/sequence','POST',{sequence:modalValue(body,'dna-sequence')});openModal({title:'独立计算结果',html:code(result),actions:[{label:'关闭'}]});},'计算');
   else if(action==='protein')modalForm('查询 UniProt',field('UniProt accession','protein-id','P04637'),async body=>{const result=await request('/biomedical/protein','POST',{accession:modalValue(body,'protein-id')});openModal({title:'数据库实际返回',size:'lg',html:code(result),actions:[{label:'关闭'}]});},'查询');
   else if(action==='literature')modalForm('检索 Europe PMC',field('公开检索词（请勿输入临床敏感信息）','literature-query','BRCA1'),async body=>{const result=await request('/research/literature','POST',{query:modalValue(body,'literature-query')});openModal({title:'实际检索结果与来源 ID',size:'xl',html:code(result),actions:[{label:'关闭'}]});},'检索');
   else if(action==='record-claim')modalForm('登记科研结论',area('结论','claim-statement','',4)+select('类型','claim-kind',[['hypothesis','待验证假设'],['inference','推断'],['evidence','证据支持的判断']],'hypothesis')+area('本工作区来源 ID 数组','claim-sources',[],2)+field('关联运行 ID','claim-run'),async body=>{await request('/research/claims','POST',{statement:modalValue(body,'claim-statement'),kind:modalValue(body,'claim-kind'),sources:modalJSON(body,'claim-sources'),run:modalValue(body,'claim-run')});await load();});
   else if(action==='verify-claim')modalForm('独立指标检查',field('当前工作区的 JSON 指标文件','metrics-path','','results/metrics.json')+area('检查规则','metrics-rules',[{metric:'adjusted_p_value',op:'lt',threshold:0.05}],5),async body=>{await request(`/research/claims/${id}/verify`,'POST',{path:modalValue(body,'metrics-path'),rules:modalJSON(body,'metrics-rules')});await load();},'执行检查');
   else if(action==='review-claim')modalForm('人工科学复核',field('复核人','claim-reviewer')+area('复核理由、原始数据核查与局限','claim-review-notes','',5)+'<p class="sw-error">请核对原始数据、引文支持关系与统计方法。此签署不会把模型意见变成科学事实。</p>',async body=>{await request(`/research/claims/${id}/review`,'POST',{reviewer:modalValue(body,'claim-reviewer'),notes:modalValue(body,'claim-review-notes'),confirmed:true});await load();},'确认已人工复核');
   else if(action==='new-experiment')modalForm('登记实际计算指标',field('实验名称','exp-name')+field('数据集版本 / 摘要','exp-dataset')+field('评估协议版本','exp-protocol')+field('JSON 文件路径','exp-path')+field('目标指标','exp-metric')+select('优化方向','exp-direction',[['max','越大越好'],['min','越小越好']],'max'),async body=>{const data={};for(const k of ['name','dataset','protocol','path','metric','direction'])data[k]=modalValue(body,'exp-'+k);await request('/experiments','POST',data);await load();});
   else if(action==='compare-experiments'){const result=await request('/experiments/compare','POST',{ids:Array.from(content.querySelectorAll('[data-exp-id]:checked')).map(e=>e.dataset.expId)});openModal({title:'同协议实验比较',size:'lg',html:`<p>${esc(result.note)}</p><table class="data-table"><thead><tr><th>实验</th><th>指标</th><th>数值</th><th>结果</th></tr></thead><tbody>${result.ranking.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.metric)}</td><td>${esc(r.score)}</td><td>${result.best.includes(r.id)?'当前指标最优':'比较项'} · 科学结论未复核</td></tr>`).join('')}</tbody></table>`,actions:[{label:'关闭'}]});}
   else if(action==='import-flow')content.querySelector('#flow-file').click();
   else if(action==='export-flow')download('suwen-workflow.json',await request(`/workflows/${id}/export`));
   else if(action==='new-flow'){flow={name:'新工作流',nodes:[]};await workflow();}
   else if(action==='add-node')editNode();
   else if(action==='edit-node')editNode(flow.nodes.find(n=>n.id===id));
   else if(action==='delete-node'){flow.nodes=flow.nodes.filter(n=>n.id!==id);flow.nodes.forEach(n=>n.depends_on=(n.depends_on||[]).filter(d=>d!==id));renderCanvas();}
   else if(action==='save-flow'){flow.name=val('flow-name');await request('/registry/workflow'+(flow.id?'/'+flow.id:''),flow.id?'PUT':'POST',flow);toastSuccess('模板已保存');await workflow();}
   else if(action==='load-flow'){flow=structuredClone(item);await workflow();}
   else if(action==='run-flow'){await request('/tasks','POST',{title:item.name,workflow_id:id});toastSuccess('已创建持久任务');}
   else if(action==='draft-flow')modalForm('从目标生成可编辑初稿',area('目标','flow-goal','',4)+'<p class="sw-muted">使用可解释的规则模板生成“规划 → 人工检查 → 执行 → 输出”，不是已验证的科研方案。</p>',async body=>{const prompt=modalValue(body,'flow-goal');flow={name:prompt.slice(0,40),nodes:[{id:'plan',type:'model',prompt:'先规划，不执行外部操作：'+prompt},{id:'review',type:'approval',depends_on:['plan'],prompt:'请检查执行计划与权限'},{id:'execute',type:'model',depends_on:['review'],prompt},{id:'deliver',type:'output',depends_on:['execute']}]};await workflow();},'生成初稿');
   else if(action==='new-artifact')modalForm('登记产物快照',field('工作区相对路径','artifact-path','','reports/result.md')+field('关联任务 / 运行 ID','artifact-task'),async body=>{await request('/artifacts/snapshot','POST',{path:modalValue(body,'artifact-path'),task:modalValue(body,'artifact-task')});await load();});
   else if(action==='record-history'){const rows=(await request(`/registry/${section}/${id}/history`)).items;openModal({title:'版本历史',size:'lg',html:rows.map(r=>`<article class="sw-card"><h3>版本 ${r.revision}</h3>${code(r)}<button class="btn btn-ghost sw-restore" data-version="${r.revision}">恢复此版本</button></article>`).join('')||blank('暂无历史版本'),actions:[{label:'关闭'}]});document.querySelectorAll('.sw-restore').forEach(btn=>btn.onclick=async()=>{try{if(!await confirmDialog({title:'恢复历史版本',message:'文件修改前会保存当前快照；技能恢复后默认停用。'}))return;await request(section==='artifact'?`/artifacts/${id}/restore`:`/skills/${id}/rollback`,'POST',{revision:Number(btn.dataset.version),confirmed:true});toastSuccess('已恢复');}catch(err){toastError(errorMessage(err));}});}
   else if(action==='model-test'){const result=await request('/diagnostics/model-test','POST',{});openModal({title:result.mode==='mock'?'模拟模型测试（不代表真实模型已连接）':'模型实测',html:code(result),actions:[{label:'关闭'}]});}
   else if(action==='export-diagnostics')download('suwen-diagnostics.json',await request('/diagnostics'));
   else if(action==='reset-layout'){await request('/layout','PUT',{rightWidth:330,bottomHeight:210,hideRight:false,hideBottom:false});toastSuccess('布局已重置，重新进入工作台生效');}
  }catch(err){toastError(errorMessage(err));}finally{if(target.isConnected)target.disabled=false;}
 });
 listen('change',async event=>{try{
  if(event.target.id==='flow-file'&&event.target.files[0]){const value=JSON.parse(await event.target.files[0].text());await request('/workflows/import','POST',value);toastSuccess('模板已校验并导入，尚未执行');await load();}
  if(event.target.id==='source-file'&&event.target.files[0]){const form=new FormData();form.append('file',event.target.files[0]);await request('/knowledge/upload','POST',form);toastSuccess('文档已解析并建立索引');await load();}
  if(event.target.id==='config-file'&&event.target.files[0]){const value=JSON.parse(await event.target.files[0].text());await request('/configuration/import','POST',value);toastSuccess('配置已校验并导入');await load();}
 }catch(err){toastError(errorMessage(err));}});
 root.querySelector('#sw-search').addEventListener('input',event=>{const query=event.target.value.trim().toLowerCase();root.querySelectorAll('[data-section]').forEach(node=>node.hidden=!!query&&!node.textContent.toLowerCase().includes(query));});
 let drag=null;
 listen('pointerdown',event=>{const handle=event.target.closest('.sw-flow-grab');if(!handle)return;const card=handle.closest('[data-node]'),node=flow.nodes.find(n=>n.id===card.dataset.node);drag={node,card,x:event.clientX,y:event.clientY,left:card.offsetLeft,top:card.offsetTop};handle.setPointerCapture(event.pointerId);});
 listen('pointermove',event=>{if(!drag)return;drag.node.position={x:Math.max(8,Math.min(1300,drag.left+event.clientX-drag.x)),y:Math.max(8,Math.min(700,drag.top+event.clientY-drag.y))};drag.card.style.left=drag.node.position.x+'px';drag.card.style.top=drag.node.position.y+'px';});
 listen('pointerup',()=>{if(drag){drag=null;renderCanvas();}});
 await load();
 if(route==='tasks2')timer=setInterval(()=>{if(section==='tasks'&&!document.querySelector('.modal-backdrop')&&!disposed)void load();},8000);
 return {destroy(){disposed=true;events.abort();clearInterval(timer);channelView?.destroy();root.innerHTML='';}};
}
