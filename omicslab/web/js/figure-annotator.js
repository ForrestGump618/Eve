import {api} from './api.js?v=1.4.0';
import {esc, getPref, setPref} from './util.js?v=1.4.0';
import {emit} from './bus.js?v=1.4.0';
import {artifactConfig, ensureArtifactStyles} from './artifact-config.js?v=1.4.0';
import {getArtifactSidebar} from './artifact-tabs.js?v=1.4.0';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const validColor = value => /^#[\da-f]{6}$/i.test(String(value));

export function normalizeAnnotationStrokes(strokes, config = artifactConfig.annotation) {
  if (!Array.isArray(strokes)) return [];
  return strokes.slice(0, config.maxStrokes).flatMap(stroke => {
    if (!Array.isArray(stroke?.points)) return [];
    const points = stroke.points.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
      .slice(0, config.maxPoints).map(p => ({x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1)}));
    return points.length ? [{
      color: validColor(stroke.color) ? stroke.color : config.color,
      width: Number.isFinite(stroke.width) ? clamp(stroke.width, config.minWidth, config.maxWidth) : config.width,
      points,
    }] : [];
  });
}

/** Top-left x/y and width/height, normalized to the original image's bounds. */
export function annotationRegions(strokes, config = artifactConfig.annotation) {
  const round = value => Number(value.toFixed(config.regionPrecision));
  return normalizeAnnotationStrokes(strokes, config).map(stroke => {
    const xs = stroke.points.map(point => point.x), ys = stroke.points.map(point => point.y);
    const x = round(clamp(Math.min(...xs) - config.regionPadding, 0, 1));
    const y = round(clamp(Math.min(...ys) - config.regionPadding, 0, 1));
    const right = round(clamp(Math.max(...xs) + config.regionPadding, 0, 1));
    const bottom = round(clamp(Math.max(...ys) + config.regionPadding, 0, 1));
    return {x, y, width: round(right - x), height: round(bottom - y)};
  });
}

export async function annotateFigure(fig) {
  const name = fig.name || decodeURIComponent(new URL(fig.url || '', location.href).pathname.split('/').pop());
  if (!name) throw Error('图表缺少文件名');
  return getArtifactSidebar().open({
    id: JSON.stringify(['figure-annotation', name]),
    title: `标注图表 · ${name}`,
    render: context => createFigureAnnotator(name, context),
  });
}

function createFigureAnnotator(name, {signal, close}) {
  ensureArtifactStyles();
  const config = artifactConfig.annotation;
  const endpoint = `/api/figures/${encodeURIComponent(name)}`;
  const savedStyle = getPref('figureAnnotationStyle', {}) || {};
  const color = validColor(savedStyle.color) ? savedStyle.color : config.color;
  const width = Number.isFinite(savedStyle.width) ? clamp(savedStyle.width, config.minWidth, config.maxWidth) : config.width;
  let observer = null;
  let activePointer = null;
  let current = null;
  let ready = false;
  let imageReady = false;
  let imageFailed = false;
  let saving = false;
  let redo = [];
  let cssWidth = 0;
  let cssHeight = 0;
  const body = document.createElement('div');
  body.className = 'figure-annotator';
  body.innerHTML = `<div class="figure-annotator-stage"><img alt="${esc(name)}"/><canvas aria-label="图表标注层" aria-disabled="true"></canvas></div>
      <div class="figure-annotator-tools"><button type="button" class="btn btn-sm" data-annotation-undo>撤销</button><button type="button" class="btn btn-sm" data-annotation-redo>重做</button><button type="button" class="btn btn-sm" data-annotation-clear>清除</button>
      <label>颜色 <input type="color" data-annotation-color value="${esc(color)}"/></label>
      <label>线宽 <input type="range" data-annotation-width min="${config.minWidth}" max="${config.maxWidth}" value="${width}"/><output data-annotation-width-value>${width}</output></label>
      <button type="button" class="btn btn-ghost btn-sm" data-annotation-reset>恢复画笔</button></div>
      <textarea class="input" data-annotation-note rows="${config.noteRows}" maxlength="${config.maxNoteLength}" aria-label="图表修改要求" placeholder="给智能体的修改要求，例如：将右上角图例移到图外，保留原始数据和统计方法。"></textarea>
      <p data-annotation-status role="status">正在读取批注…</p><button type="button" class="btn btn-ghost btn-sm" data-annotation-retry hidden>重新读取批注</button>
      <p class="eve-detail-note">保存批注仅记录指导，不修改原图；提交局部修改会把标注区域与要求发送给当前任务。</p>
      <footer class="figure-annotator-actions"><button type="button" class="btn btn-ghost btn-sm" data-annotation-close>关闭</button>
      <button type="button" class="btn btn-ghost btn-sm" data-annotation-save>保存批注</button><button type="button" class="btn btn-primary btn-sm" data-annotation-apply>提交局部修改</button></footer>`;
  const stage = body.querySelector('.figure-annotator-stage');
  const img = stage.querySelector('img');
  const canvas = stage.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const note = body.querySelector('[data-annotation-note]');
  const status = body.querySelector('[data-annotation-status]');
  const retry = body.querySelector('[data-annotation-retry]');
  const colorInput = body.querySelector('[data-annotation-color]');
  const widthInput = body.querySelector('[data-annotation-width]');
  const save = body.querySelector('[data-annotation-save]');
  const apply = body.querySelector('[data-annotation-apply]');
  canvas._strokes = [];
  const listen = (node, type, handler) => node.addEventListener(type, handler, {signal});
  const alive = () => !signal.aborted && body.isConnected;

  function updateControls() {
    save.disabled = !ready || saving;
    apply.disabled = !ready || saving;
    note.disabled = !ready || saving;
    canvas.setAttribute('aria-disabled', String(!ready || !imageReady || saving));
    body.querySelector('[data-annotation-undo]').disabled = !ready || saving || !canvas._strokes.length;
    body.querySelector('[data-annotation-redo]').disabled = !ready || saving || !redo.length;
    body.querySelector('[data-annotation-clear]').disabled = !ready || saving || !canvas._strokes.length;
  }

  async function saveAnnotation(submit) {
    if (!ready || signal.aborted || saving) return;
    finishStroke();
    const snapshot = {strokes: normalizeAnnotationStrokes(canvas._strokes), note: note.value.trim().slice(0, config.maxNoteLength)};
    if (submit && !snapshot.strokes.length && !snapshot.note) {
      status.textContent = '请先标注要修改的区域，或填写修改要求。';
      status.setAttribute('role', 'alert');
      return;
    }
    saving = true; updateControls();
    status.textContent = '正在保存批注…'; status.setAttribute('role', 'status');
    try {
      const result = await api.request(`${endpoint}/annotations`, {
        method: 'POST', signal, timeout: artifactConfig.requestTimeoutMs, body: snapshot,
      });
      if (!alive()) return;
      status.textContent = '批注已保存。';
      emit('figure:annotations-saved', {name, annotation: result.annotation});
      if (submit) {
        const request = {name, note: snapshot.note, regions: annotationRegions(snapshot.strokes)};
        let delivered = false;
        Object.defineProperty(request, 'accept', {value: () => { delivered = true; }});
        emit('figure:annotation-apply', request);
        status.textContent = delivered ? '批注已送到当前会话，请在执行记录中查看修改进度。'
          : '批注已保存。当前没有活动会话，请在工作台打开图表后提交修改。';
      }
    } catch (error) {
      if (!alive()) return;
      status.textContent = `保存失败：${error.message}。批注已保留，请重试。`;
      status.setAttribute('role', 'alert');
    } finally { saving = false; if (alive()) updateControls(); }
  }

  function draw() {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    for (const stroke of canvas._strokes) {
      ctx.strokeStyle = ctx.fillStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      if (stroke.points.length === 1) {
        const p = stroke.points[0];
        ctx.arc(p.x * cssWidth, p.y * cssHeight, stroke.width / 2, 0, Math.PI * 2); ctx.fill();
      } else {
        stroke.points.forEach((p, i) => i ? ctx.lineTo(p.x * cssWidth, p.y * cssHeight) : ctx.moveTo(p.x * cssWidth, p.y * cssHeight));
        ctx.stroke();
      }
    }
  }

  function fit() {
    if (!alive() || !imageReady) return;
    const rect = img.getBoundingClientRect();
    cssWidth = rect.width; cssHeight = rect.height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssWidth * ratio));
    canvas.height = Math.max(1, Math.round(cssHeight * ratio));
    // Match the image box rather than the larger, flex-centered stage.
    canvas.style.left = `${img.offsetLeft}px`; canvas.style.top = `${img.offsetTop}px`;
    canvas.style.width = `${cssWidth}px`; canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); draw();
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1)};
  }

  function finishStroke(cancel = false) {
    const pointer = activePointer; activePointer = null;
    if (cancel && current) canvas._strokes.pop();
    current = null;
    if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    if (!signal.aborted) { draw(); updateControls(); }
  }

  listen(canvas, 'pointerdown', event => {
    if (event.button !== 0 || activePointer !== null || !ready || !imageReady || saving || !cssWidth || !cssHeight) return;
    if (canvas._strokes.length >= config.maxStrokes) { status.textContent = '批注数量已达上限，请撤销或清除后继续。'; return; }
    event.preventDefault(); activePointer = event.pointerId; canvas.setPointerCapture(activePointer);
    current = {color: colorInput.value, width: Number(widthInput.value), points: [point(event)]};
    canvas._strokes.push(current); redo = []; draw(); updateControls();
  });
  listen(canvas, 'pointermove', event => {
    if (event.pointerId !== activePointer || !current) return;
    // Resample long gestures so the API never truncates their final segment.
    if (current.points.length >= config.maxPoints) current.points = current.points.filter((_, i) => i % 2 === 0);
    current.points.push(point(event)); draw();
  });
  listen(canvas, 'pointerup', event => { if (event.pointerId === activePointer) finishStroke(); });
  listen(canvas, 'pointercancel', event => { if (event.pointerId === activePointer) finishStroke(true); });
  listen(canvas, 'lostpointercapture', event => { if (event.pointerId === activePointer) finishStroke(true); });
  listen(window, 'blur', () => finishStroke(true));
  listen(window, 'resize', fit);
  listen(body.querySelector('[data-annotation-undo]'), 'click', () => {
    finishStroke(); const stroke = canvas._strokes.pop(); if (stroke) redo.push(stroke); draw(); updateControls();
  });
  listen(body.querySelector('[data-annotation-redo]'), 'click', () => {
    finishStroke(); const stroke = redo.pop(); if (stroke) canvas._strokes.push(stroke); draw(); updateControls();
  });
  listen(body.querySelector('[data-annotation-clear]'), 'click', () => {
    finishStroke(); redo.push(...canvas._strokes.slice().reverse()); canvas._strokes = []; draw(); updateControls();
  });
  function rememberStyle() {
    body.querySelector('[data-annotation-width-value]').value = widthInput.value;
    setPref('figureAnnotationStyle', {color: colorInput.value, width: Number(widthInput.value)});
  }
  listen(colorInput, 'input', rememberStyle); listen(widthInput, 'input', rememberStyle);
  listen(body.querySelector('[data-annotation-reset]'), 'click', () => {
    colorInput.value = config.color; widthInput.value = config.width; rememberStyle();
  });
  listen(img, 'load', () => { imageReady = true; imageFailed = false; fit(); updateControls(); });
  listen(img, 'error', () => {
    imageReady = false; imageFailed = true; status.textContent = '原图无法加载，请关闭后重新打开；仍可编辑文字要求。';
    status.setAttribute('role', 'alert'); updateControls();
  });
  async function load() {
    retry.hidden = true;
    try {
      const data = await api.request(`${endpoint}/annotations`, {quiet: true, signal, timeout: artifactConfig.requestTimeoutMs});
      if (!alive()) return;
      canvas._strokes = normalizeAnnotationStrokes(data.annotation?.strokes);
      note.value = String(data.annotation?.note || '').slice(0, config.maxNoteLength);
      ready = true;
      status.textContent = imageFailed ? '原图无法加载，请关闭后重新打开；仍可编辑文字要求。' : '在图上拖动绘制，或填写修改要求后保存。';
      status.setAttribute('role', imageFailed ? 'alert' : 'status');
      fit(); updateControls();
    } catch (error) {
      if (!alive()) return;
      status.textContent = `无法读取批注：${error.message}。请重新读取后再编辑。`;
      status.setAttribute('role', 'alert'); retry.hidden = false;
    }
  }
  listen(retry, 'click', () => { void load(); });
  listen(save, 'click', () => { void saveAnnotation(false); });
  listen(apply, 'click', () => { void saveAnnotation(true); });
  listen(body.querySelector('[data-annotation-close]'), 'click', close);
  if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(fit); observer.observe(stage); }
  updateControls(); img.src = endpoint; void load();
  return {node: body, dispose: () => {
    finishStroke(true); observer?.disconnect();
    img.removeAttribute('src'); canvas.width = canvas.height = 0; canvas._strokes = [];
  }};
}
