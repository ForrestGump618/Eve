import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/* These tests load the real ui/markdown.js with node:vm (no DOM, no bundler) so the tokenizer
   and streaming-state helpers that ship inside the Electron renderer are the exact code under
   test. DOM rendering and the KaTeX/Mermaid upgrade path are covered by the static checks in
   node --check and by the Electron screenshot pass (T2); everything here is DOM-free. */

interface MarkdownBlock {
  type: string;
  text?: string;
  lang?: string;
  closed?: boolean;
  display?: boolean;
  level?: number;
  ordered?: boolean;
  items?: string[];
  header?: string[];
  rows?: string[][];
}

interface InlineSegment {
  type: 'text' | 'math';
  text: string;
  display?: boolean;
  closed?: boolean;
}

interface AnalyzeResult {
  blocks: MarkdownBlock[];
  openFence: boolean;
  openMath: boolean;
  open: boolean;
}

interface ProgressivePlan {
  stableChars: number;
  stable: string;
  tail: string;
  tailChars: number;
  blocks: MarkdownBlock[];
  open: boolean;
}

interface MarkdownApi {
  MAX_CHARS: number;
  MAX_MATH_CHARS: number;
  MAX_DIAGRAM_CHARS: number;
  parse(text: string): MarkdownBlock[];
  analyze(text: string): AnalyzeResult;
  extractInlineMath(text: string): InlineSegment[];
  scanInlineMath(text: string): InlineSegment[];
  shouldRenderMath(source: string): boolean;
  shouldRenderDiagram(source: string): boolean;
  isSafeUrl(url: string): boolean;
  stablePrefix(text: string): string;
  planProgressive(text: string, previous?: ProgressivePlan): ProgressivePlan;
  render: unknown;
  enhance: unknown;
  refreshTheme: unknown;
}

const source = readFileSync(fileURLToPath(new URL('../../ui/markdown.js', import.meta.url)), 'utf8');
const sandbox: { module: { exports: Partial<MarkdownApi> } } = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'ui/markdown.js' });
const md = sandbox.module.exports as MarkdownApi;

function mathSegments(text: string): InlineSegment[] {
  return md.extractInlineMath(text).filter(segment => segment.type === 'math');
}

function textOf(segments: InlineSegment[]): string {
  return segments.filter(segment => segment.type === 'text').map(segment => segment.text).join('');
}

test('inline $...$ math is extracted as a display:false segment', () => {
  const segments = md.extractInlineMath('能量满足 $E = mc^2$ 关系');
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, 'text');
  assert.equal(segments[1].type, 'math');
  assert.equal(segments[1].text, 'E = mc^2');
  assert.equal(segments[1].display, false);
  assert.equal(segments[2].type, 'text');
  assert.equal(textOf(segments), '能量满足  关系');
});

test('inline \\(...\\) math is extracted', () => {
  const segments = mathSegments('设 \\(a+b\\) 为和');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'a+b');
});

test('an escaped dollar is literal text, not a math delimiter', () => {
  const segments = md.extractInlineMath('价格 \\$5 与 $x$');
  const math = segments.filter(segment => segment.type === 'math');
  assert.equal(math.length, 1);
  assert.equal(math[0].text, 'x');
  assert.ok(textOf(segments).indexOf('$5') >= 0);
});

test('$$ inside running text never opens an inline math span', () => {
  assert.equal(mathSegments('a $$ b').length, 0);
  assert.equal(mathSegments('$$').length, 0);
});

test('a lone dollar or an unmatched dollar stays literal text', () => {
  assert.equal(mathSegments('$5 元').length, 0);
  assert.equal(mathSegments('只有 $ 符号').length, 0);
});

test('math may not open or close on whitespace', () => {
  assert.equal(mathSegments('$ x$').length, 0);
  assert.equal(mathSegments('$x $').length, 0);
  assert.equal(mathSegments('$x$').length, 1);
});

test('inline code spans are never scanned for math', () => {
  const segments = md.extractInlineMath('`$x$` 与 $y$');
  const math = segments.filter(segment => segment.type === 'math');
  assert.equal(math.length, 1);
  assert.equal(math[0].text, 'y');
  assert.ok(textOf(segments).indexOf('`$x$`') >= 0);
});

test('multiple inline spans on one line are all found in order', () => {
  const math = mathSegments('$a$ 与 $b$ 和 $c$');
  assert.deepEqual(Array.from(math, segment => segment.text), ['a', 'b', 'c']);
});

test('unclosed inline bracket math stays plain text', () => {
  assert.equal(mathSegments('x \\(a+b').length, 0);
});

test('math source size cap rejects pathological expressions', () => {
  assert.equal(md.shouldRenderMath('x^2'), true);
  assert.equal(md.shouldRenderMath('x'.repeat(md.MAX_MATH_CHARS)), true);
  assert.equal(md.shouldRenderMath('x'.repeat(md.MAX_MATH_CHARS + 1)), false);
  assert.equal(md.shouldRenderMath('   '), false);
});

test('diagram source size cap rejects oversized diagrams', () => {
  assert.equal(md.shouldRenderDiagram('graph TD;A-->B'), true);
  assert.equal(md.shouldRenderDiagram('a'.repeat(md.MAX_DIAGRAM_CHARS)), true);
  assert.equal(md.shouldRenderDiagram('a'.repeat(md.MAX_DIAGRAM_CHARS + 1)), false);
  assert.equal(md.shouldRenderDiagram('  '), false);
});

test('a closed $$ block is tokenized as display math', () => {
  const blocks = md.parse('$$\nE = mc^2\n$$');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'math');
  assert.equal(blocks[0].display, true);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[0].text, 'E = mc^2');
});

test('a single-line $$...$$ is display math', () => {
  const blocks = md.parse('$$x^2 + y^2 = z^2$$');
  assert.equal(blocks[0].type, 'math');
  assert.equal(blocks[0].display, true);
  assert.equal(blocks[0].text, 'x^2 + y^2 = z^2');
});

test('a closed \\[ ... \\] block is display math', () => {
  const blocks = md.parse('\\[\n\\frac{a}{b}\n\\]');
  assert.equal(blocks[0].type, 'math');
  assert.equal(blocks[0].display, true);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[0].text, '\\frac{a}{b}');
});

test('an unclosed math block is marked open so renderers must wait', () => {
  const analysis = md.analyze('$$\nE = mc^2');
  assert.equal(analysis.open, true);
  assert.equal(analysis.openMath, true);
  assert.equal(analysis.blocks[0].type, 'math');
  assert.equal(analysis.blocks[0].closed, false);
});

test('a closed mermaid fence becomes a diagram block', () => {
  const blocks = md.parse('```mermaid\ngraph TD;A-->B\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'diagram');
  assert.equal(blocks[0].lang, 'mermaid');
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[0].text, 'graph TD;A-->B');
});

test('mermaid fences also accept tilde markers', () => {
  const blocks = md.parse('~~~mermaid\nflowchart LR\n~~~');
  assert.equal(blocks[0].type, 'diagram');
  assert.equal(blocks[0].closed, true);
});

test('an unclosed mermaid fence during streaming is flagged and must not render', () => {
  const analysis = md.analyze('```mermaid\ngraph TD;A-->B');
  assert.equal(analysis.open, true);
  assert.equal(analysis.openFence, true);
  assert.equal(analysis.blocks[0].type, 'diagram');
  assert.equal(analysis.blocks[0].closed, false);
});

test('non-mermaid fences stay ordinary code blocks', () => {
  const blocks = md.parse('```js\nconst a = 1;\n```');
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[0].closed, true);
});

test('mermaid syntax inside a plain code fence is not a diagram', () => {
  const blocks = md.parse('~~~text\n```mermaid\ngraph TD\n```\n~~~');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  const text = blocks[0].text || '';
  assert.equal(text.indexOf('```mermaid'), 0);
});

test('math delimiters inside fenced code are left alone', () => {
  const blocks = md.parse('```\n$x + y$\n```');
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].text, '$x + y$');
});

test('raw HTML in the source stays a paragraph text value', () => {
  const blocks = md.parse('<script>alert(1)</script>');
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].text, '<script>alert(1)</script>');
});

test('only absolute http(s) URLs pass the link filter', () => {
  assert.equal(md.isSafeUrl('https://example.org/a'), true);
  assert.equal(md.isSafeUrl('http://example.org'), true);
  assert.equal(md.isSafeUrl('javascript:alert(1)'), false);
  assert.equal(md.isSafeUrl('data:text/html;base64,AAAA'), false);
  assert.equal(md.isSafeUrl('mailto:a@example.org'), false);
  assert.equal(md.isSafeUrl('/relative/path'), false);
});

test('a fully closed document reports no open delimiters', () => {
  const analysis = md.analyze('# 标题\n\n普通段落 $a+b$ 文本\n\n```mermaid\ngraph TD\n```');
  assert.equal(analysis.open, false);
  assert.equal(analysis.openFence, false);
  assert.equal(analysis.openMath, false);
});

test('tables keep their existing tokenized shape', () => {
  const blocks = md.parse('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(blocks[0].type, 'table');
  /* Blocks come from the vm realm, so normalize cross-realm arrays before comparing. */
  assert.equal(JSON.stringify(blocks[0].header), JSON.stringify(['a', 'b']));
  assert.equal(JSON.stringify(blocks[0].rows), JSON.stringify([['1', '2']]));
});

test('CRLF input is normalized before tokenizing', () => {
  const blocks = md.parse('first line\r\nsecond line');
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].text, 'first line second line');
});

/* ---- progressive streaming markdown (closed blocks only, open tail stays plain) ---- */

test('progressive: a partial table row stays plain until the row closes', () => {
  const partial = '| a | b |\n| --- | --- |\n| 1 |';
  const before = md.planProgressive(partial);
  assert.equal(before.stableChars, 0);
  assert.equal(before.blocks.length, 0);
  assert.equal(before.tail, partial);
  const closed = partial + ' 2 |\n';
  const after = md.planProgressive(closed);
  /* The table block itself is stable; its terminating newline may still arrive as a tail chunk. */
  assert.equal(after.stableChars, closed.length - 1);
  assert.equal(after.tail, '\n');
  const table = after.blocks.find(block => block.type === 'table');
  assert.ok(table);
  assert.equal(JSON.stringify(table.header), JSON.stringify(['a', 'b']));
  assert.equal(JSON.stringify(table.rows), JSON.stringify([['1', '2']]));
});

test('progressive: a fence split over three deltas renders only when closed', () => {
  const first = '```js\nconst x = ';
  const second = '1;\n';
  const third = '```\n';
  let text = first;
  let plan = md.planProgressive(text);
  assert.equal(plan.stableChars, 0);
  assert.equal(plan.blocks.length, 0);
  assert.equal(plan.tail, text);
  text += second;
  plan = md.planProgressive(text);
  assert.equal(plan.stableChars, 0);
  assert.equal(plan.blocks.length, 0);
  text += third;
  plan = md.planProgressive(text);
  assert.ok(plan.stableChars > 0);
  assert.equal(plan.tailChars, 0);
  const code = plan.blocks.find(block => block.type === 'code');
  assert.ok(code);
  assert.equal(code.lang, 'js');
  assert.equal((code.text || '').indexOf('const x = 1;'), 0);
  /* The DOM pre/code node itself is exercised by the Electron screenshot pass; the block shape
     asserted here is exactly what renderProgressivePlan consumes. */
});

test('progressive: inline math is typed only after its closing dollar and a closed block', () => {
  const open = md.planProgressive('T1 $E=m');
  assert.equal(open.stableChars, 0);
  assert.equal(open.blocks.length, 0);
  const closedButNoBlockBoundary = md.planProgressive('T1 $E=mc^2$');
  assert.equal(closedButNoBlockBoundary.stableChars, 0);
  assert.equal(closedButNoBlockBoundary.blocks.length, 0);
  const complete = md.planProgressive('T1 $E=mc^2$\n');
  assert.ok(complete.stableChars > 0);
  assert.equal(complete.blocks[0].type, 'paragraph');
  const segments = mathSegments(complete.stable);
  assert.equal(segments.length, 1);
  assert.equal(md.shouldRenderMath(segments[0].text), true);
});

test('progressive: zh and en chunks and a split surrogate pair keep text integrity', () => {
  let text = '';
  for (const piece of ['科研结', '论：中文', ' and English']) text += piece;
  const plan = md.planProgressive(text + '\n');
  assert.equal(plan.tailChars, 0);
  const rendered = plan.blocks.map(block => block.text || '').join('\n');
  assert.ok(rendered.indexOf('结论：中文 and English') >= 0);
  assert.equal(rendered.indexOf('\uFFFD'), -1);
  const emoji = '\u{1F600}';
  const high = emoji.slice(0, 1);
  const low = emoji.slice(1);
  assert.equal(high.length, 1);
  assert.equal(low.length, 1);
  let surrogateText = '完成 ' + high;
  let surrogatePlan = md.planProgressive(surrogateText);
  assert.equal(surrogatePlan.tailChars, surrogateText.length);
  surrogateText += low + '\n';
  surrogatePlan = md.planProgressive(surrogateText);
  assert.equal(surrogatePlan.tailChars, 0);
  const paragraph = surrogatePlan.blocks.map(block => block.text || '').join('');
  assert.ok(paragraph.indexOf(high + low) >= 0);
  assert.equal(paragraph.indexOf('\uFFFD'), -1);
});

test('progressive: ten successive refreshes reuse closed blocks without duplication', () => {
  let text = '';
  let previous: ProgressivePlan | undefined;
  for (let index = 0; index < 10; index += 1) {
    text += '段落 ' + (index + 1) + ' ends here.\n\n';
    const plan = md.planProgressive(text, previous);
    assert.equal(plan.stable + plan.tail, text);
    if (previous) assert.ok(plan.stable.startsWith(previous.stable));
    assert.equal(plan.blocks.length, index + 1);
    assert.equal(plan.blocks[index].type, 'paragraph');
    assert.equal((plan.blocks[index].text || '').indexOf('段落 ' + (index + 1)), 0);
    previous = plan;
  }
  assert.ok(previous);
  assert.equal(previous.blocks.length, 10);
});

test('progressive: 10000 chars over 500 deltas keeps the refresh budget', () => {
  let corpus = '';
  let counter = 0;
  while (corpus.length < 10000) {
    counter += 1;
    corpus += '流式段落 ' + counter + '：这是用于性能测量的中文和 English 混排文本。\n\n';
  }
  const text = corpus.slice(0, 10000);
  const width = Math.ceil(text.length / 500);
  const deltas: string[] = [];
  for (let index = 0; index < text.length; index += width) deltas.push(text.slice(index, index + width));
  let rendered = '';
  let previous: ProgressivePlan | undefined;
  const started = process.hrtime.bigint();
  let worstMs = 0;
  for (const delta of deltas) {
    rendered += delta;
    const before = process.hrtime.bigint();
    previous = md.planProgressive(rendered, previous);
    const costMs = Number(process.hrtime.bigint() - before) / 1e6;
    if (costMs > worstMs) worstMs = costMs;
  }
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  const averageMs = totalMs / deltas.length;
  assert.equal(rendered, text);
  assert.ok(previous);
  assert.equal(previous.stable + previous.tail, text);
  assert.equal(deltas.length, 500);
  assert.ok(averageMs < 20, 'average progressive plan ' + averageMs.toFixed(3) + ' ms must stay under a frame');
  assert.ok(worstMs < 200, 'worst progressive plan ' + worstMs.toFixed(3) + ' ms');
  /* Recorded in docs/verification/markdown-rendering.md. */
  console.log('[perf] progressive markdown: ' + deltas.length + ' deltas / ' + text.length +
    ' chars, total ' + totalMs.toFixed(2) + ' ms, average ' + averageMs.toFixed(3) +
    ' ms, worst ' + worstMs.toFixed(3) + ' ms');
});
