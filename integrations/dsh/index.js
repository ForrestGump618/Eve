/**
 * SuWen (素问) scientific capabilities as native DeepSeek Harness Host tools.
 *
 * DSH owns planning, the model, sessions and delegation. This plugin only exposes the
 * repo's scientific backend (`python -m omicslab.integrations.science --stdio`) as
 * tools: literature, protein, sequence, Python execution, variables, notebook export,
 * evidence, experiments, knowledge and skills. No LLM, AppState or agent loop runs in
 * the child process.
 *
 * Trust boundaries: retrieved literature/database records are external data; a
 * successful call never means a scientific conclusion is validated.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SciencePool, ensureDirectory } from './science-client.js'

export const name = 'suwen-science'

export const inject = ['tools']

/** Repo root implied by this bundle living at <repo>/integrations/dsh/. */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))

function detectRepoPath() {
  const candidates = [path.resolve(PACKAGE_DIR, '..', '..'), process.cwd()]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'omicslab', 'integrations', 'science.py'))) return candidate
  }
  return ''
}

export const Config = z.object({
  pythonPath: z
    .string()
    .description('数据计算后端使用的 Python 解释器；留空用 $SUWEN_PYTHON，再退回 PATH 的 python。')
    .default(''),
  repoPath: z
    .string()
    .description('素问仓库根目录（包含 omicslab/）。设置后加入 PYTHONPATH 并作为子进程工作目录。')
    .default(''),
  workspace: z
    .string()
    .description('显式固定的分析工作区；留空则由本次工具调用的 Agent 工作目录决定。')
    .default(''),
  home: z
    .string()
    .description('后端数据目录（证据/实验/知识/内核产物）；留空用 <workspace>/.suwen-dsh。')
    .default(''),
})

const MAX_TEXT = 16000

function asText(value, limit = MAX_TEXT) {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}\n…（已截断，共 ${raw.length} 字符）`
}

function textBlock(text) {
  return [{ type: 'text', text: asText(text) }]
}

function json(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function str(value) {
  return value === undefined || value === null ? '' : String(value)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** UniProt returns proteinDescription as a nested object; flatten it for display. */
function proteinLabel(description) {
  if (!description) return ''
  if (typeof description === 'string') return description
  const recommended = (description.recommendedName && description.recommendedName.fullName) || {}
  const text = str(recommended.value || description.value).trim()
  if (text) return text
  const alternatives = Array.isArray(description.alternativeNames) ? description.alternativeNames : []
  const names = alternatives.map((item) => str((item && item.fullName && item.fullName.value) || '')).filter(Boolean)
  if (names.length) return names.join(' / ')
  return json(description).slice(0, 600)
}

function expand(value) {
  const raw = str(value).trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

function normalizeConfig(config) {
  const raw = config || {}
  const resolve = (value) => {
    const expanded = expand(value)
    return expanded ? path.resolve(expanded) : ''
  }
  return {
    pythonPath: str(raw.pythonPath).trim() || str(process.env.SUWEN_PYTHON).trim(),
    repoPath: resolve(raw.repoPath) || detectRepoPath(),
    workspace: resolve(raw.workspace),
    home: resolve(raw.home),
  }
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const pool = new SciencePool(options)

  if (typeof ctx.effect === 'function') ctx.effect(() => () => pool.dispose())
  if (typeof ctx.on === 'function') ctx.on('dispose', () => pool.dispose())

  /** Resolve the backend workspace/home for this specific tool call. */
  async function scopes(exec) {
    let workspace = options.workspace
    if (!workspace) {
      const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      if (workingDirectory) {
        if (exec && exec.agent) {
          try {
            workspace = await workingDirectory.ensure(exec.agent, exec.signal)
          } catch {
            workspace = ''
          }
        }
        if (!workspace) workspace = workingDirectory.defaultDirectory
      }
    }
    if (!workspace) workspace = process.cwd()
    const home = options.home || path.join(workspace, '.suwen-dsh')
    ensureDirectory(home)
    return { workspace, home }
  }

  async function call(exec, op, params, timeoutMs) {
    const { workspace, home } = await scopes(exec)
    const client = pool.get(workspace, home)
    return client.request(op, params, { signal: exec && exec.signal, timeoutMs: timeoutMs || 120000 })
  }

  ctx.tools.register(
    defineTool({
      name: 'suwen_science_status',
      description:
        '读取素问科研后端状态：工作区、数据目录、内核是否已启动、可用操作。开始任何分析前先调用它核对实际路径。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace: { type: 'string' },
            home: { type: 'string' },
            scope: { type: 'string' },
            kernelRunning: { type: 'boolean' },
            kernelPython: { type: 'string' },
            executionCount: { type: 'integer' },
            ops: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) =>
          textBlock(
            [
              `工作区：${value.workspace}`,
              `数据目录：${value.home}（scope ${value.scope}）`,
              `Python 内核：${value.kernelRunning ? `已启动 ${value.kernelPython}（已执行 ${value.executionCount} 次）` : '未启动，首次 python.execute 时启动'}`,
              `可用操作：${(value.ops || []).join(', ')}`,
              value.note,
            ].join('\n'),
          ),
      },
      execute: async (_args, exec) => {
        const result = await call(exec, 'status', {}, 60000)
        const kernel = result.kernel || {}
        return {
          workspace: str(result.workspace),
          home: str(result.home),
          scope: str(result.scope),
          kernelRunning: Boolean(kernel.running),
          kernelPython: str(kernel.python),
          executionCount: num(kernel.execution_count),
          ops: Array.isArray(result.ops) ? result.ops.map(str) : [],
          note: '成功执行不等于科学验证；文献与数据库结果属于外部数据，需核对来源。',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_literature_search',
      description:
        '检索 Europe PMC 文献元数据（标题、DOI/PMID、年份、摘要），返回可引用的来源 id。命中不等于结论成立。',
      parameters: {
        query: { type: 'string', required: true, description: '检索式/关键词，例如 "ERBB2 amplification breast cancer".' },
        limit: { type: 'integer', description: '返回条数 1–20，默认 5。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string' },
            count: { type: 'integer' },
            text: { type: 'string' },
            results: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => textBlock(`${value.text}\n${value.note}`),
      },
      execute: async (args, exec) => {
        const result = await call(exec, 'literature.search', { query: str(args.query), limit: args.limit }, 90000)
        const results = Array.isArray(result.results) ? result.results : []
        const lines = [`检索「${str(result.query)}」命中 ${num(result.count)} 条：`]
        results.forEach((item, index) => {
          lines.push(
            '',
            `${index + 1}. ${str(item.title)}`,
            `   ${str(item.year)} · DOI ${str(item.doi) || '-'} · PMID ${str(item.pmid) || '-'}`,
            `   来源 id：${str(item.id)} · ${str(item.url)}`,
            `   摘要：${asText(str(item.abstract), 700)}`,
          )
        })
        return {
          query: str(result.query),
          count: num(result.count) || results.length,
          text: lines.join('\n'),
          results: results.map((item) => ({
            id: str(item.id),
            title: str(item.title),
            year: str(item.year),
            doi: str(item.doi),
            pmid: str(item.pmid),
            url: str(item.url),
            retracted: Boolean(item.retracted),
          })),
          note: str(result.note) || '来源元数据已取得；不代表论文支持某项生物学结论。',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_protein_lookup',
      description: '按 UniProt accession 查询蛋白条目（名称、基因、物种、序列长度），返回来源记录。',
      parameters: {
        accession: { type: 'string', required: true, description: 'UniProt accession，6–10 位大写字母数字，例如 P04637.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            accession: { type: 'string' },
            organism: { type: 'string' },
            sequenceLength: { type: 'integer' },
            url: { type: 'string' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (args, exec) => {
        const record = await call(exec, 'protein.lookup', { accession: str(args.accession) }, 90000)
        const organism = record.organism || {}
        const proteinName = proteinLabel(record.protein)
        const geneNames = Array.isArray(record.genes)
          ? record.genes.map((gene) => str((gene && gene.geneName && gene.geneName.value) || '')).filter(Boolean).join(', ')
          : ''
        const text = [
          `UniProt ${str(record.accession)}（来源 id ${str(record.id)}）`,
          `蛋白：${asText(proteinName, 1200)}`,
          `基因：${geneNames || '-'}`,
          `物种：${str(organism.scientificName) || '-'}　序列长度：${num(record.sequence_length)}`,
          `链接：${str(record.url)}`,
          `状态：${str(record.scientific_status)}（注释不等于因果结论）`,
        ].join('\n')
        return {
          id: str(record.id),
          accession: str(record.accession),
          organism: str(organism.scientificName),
          sequenceLength: num(record.sequence_length),
          url: str(record.url),
          text,
        }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'suwen_sequence_check',
      description: '对显式输入的 DNA 序列做本地字母表检查（长度、GC、歧义碱基、非法碱基、反向互补）。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列，可含空白；仅 ACGTN 合法，最长 1,000,000 个碱基。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            valid: { type: 'boolean' },
            length: { type: 'integer' },
            gcFraction: { type: 'number' },
            ambiguous: { type: 'integer' },
            invalid: { type: 'array', items: { type: 'string' } },
            reverseComplement: { type: 'string' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (args, exec) => {
        const result = await call(exec, 'sequence.check', { sequence: str(args.sequence) }, 60000)
        const invalid = Array.isArray(result.invalid) ? result.invalid.map(str) : []
        const text = [
          `长度 ${num(result.length)} · GC ${(num(result.gc_fraction) * 100).toFixed(2)}% · N ${num(result.ambiguous)}`,
          result.valid ? '字母表检查通过（仅说明序列格式合法）' : `非法碱基：${invalid.join(', ') || '-'}`,
          result.reverse_complement ? `反向互补：${asText(str(result.reverse_complement), 400)}` : '',
        ].filter(Boolean).join('\n')
        return {
          valid: Boolean(result.valid),
          length: num(result.length),
          gcFraction: num(result.gc_fraction),
          ambiguous: num(result.ambiguous),
          invalid,
          reverseComplement: str(result.reverse_complement),
          text,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_python',
      description:
        '在持久 Python 内核中执行显式代码并返回输出（stdout/结果/图像）与 provenance id。代码以当前用户权限运行，不是沙箱；变量在该工作区内跨调用保留。',
      parameters: {
        code: { type: 'string', required: true, description: '要执行的 Python 代码，最长 200,000 字符。' },
        timeout_s: { type: 'integer', description: '单次执行超时秒数，默认 120，范围 1–3600。' },
        run: { type: 'string', description: '可选运行标识，用于把多次执行与证据/结论归到同一 run。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            executionCount: { type: 'integer' },
            provenanceId: { type: 'string' },
            text: { type: 'string' },
            figures: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => textBlock(value.text),
      },
      timeoutMs: 600000,
      execute: async (args, exec) => {
        const timeoutS = Math.max(1, Math.min(num(args.timeout_s) || 120, 3600))
        const result = await call(
          exec,
          'python.execute',
          { code: str(args.code), timeout_s: timeoutS, run: str(args.run) || undefined },
          timeoutS * 1000 + 30000,
        )
        const lines = [`执行${result.ok ? '成功' : '失败'} · ${num(result.duration_ms)} ms · In [${num(result.execution_count)}] · provenance ${str(result.provenance_id)}`]
        for (const output of Array.isArray(result.outputs) ? result.outputs : []) {
          const kind = str(output.type)
          if (kind === 'stream') lines.push(`[${str(output.name) || 'stdout'}]\n${asText(str(output.text), 6000)}`)
          else if (kind === 'error') lines.push(`[error] ${str(output.ename)}: ${asText(str(output.evalue), 2000)}\n${asText((output.traceback || []).join('\n'), 3000)}`)
          else if (kind === 'image') lines.push(`[image] ${str(output.mime)} → ${str(output.name)}`)
          else lines.push(`[${kind}] ${asText(str(output.text), 4000)}`)
        }
        if (result.error) lines.push(`[error] ${asText(str(result.error), 3000)}`)
        lines.push('提示：执行成功不代表结果在科学上成立，需检查数据来源、统计与可复现性。')
        return {
          ok: Boolean(result.ok),
          executionCount: num(result.execution_count),
          provenanceId: str(result.provenance_id),
          text: lines.join('\n'),
          figures: Array.isArray(result.figures) ? result.figures.map(str) : [],
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_variables',
      description: '列出当前内核中的变量（名称、类型、简要 repr、形状、是否 DataFrame/AnnData/数组），用于确认分析状态。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { count: { type: 'integer' }, text: { type: 'string' } },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (_args, exec) => {
        const result = await call(exec, 'python.variables', {}, 60000)
        const items = Array.isArray(result.items) ? result.items : []
        if (!items.length) return { count: 0, text: '当前内核没有变量（内核可能尚未启动）。' }
        const lines = [`共 ${items.length} 个变量：`]
        for (const item of items) {
          const flags = [item.is_dataframe && 'DataFrame', item.is_anndata && 'AnnData', item.is_array && 'ndarray'].filter(Boolean)
          lines.push(`- ${str(item.name)}: ${str(item.type)}${item.shape ? ` ${json(item.shape)}` : ''}${flags.length ? ` (${flags.join('/')})` : ''} = ${asText(str(item.repr), 200)}`)
        }
        return { count: items.length, text: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_notebook_export',
      description:
        '把本工作区已记录的执行历史导出为 nbformat 4 notebook。不传 path 只返回 notebook 与 provenance；传 path 会独占创建 .ipynb 文件（已存在则报错）。',
      parameters: {
        path: { type: 'string', description: '工作区内的 .ipynb 相对路径，例如 analysis/report.ipynb。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            cells: { type: 'integer' },
            provenance: { type: 'integer' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (args, exec) => {
        const result = await call(exec, 'notebook.export', { path: str(args.path) || undefined }, 120000)
        const notebook = result.notebook || {}
        const cells = Array.isArray(notebook.cells) ? notebook.cells.length : 0
        const provenance = Array.isArray(result.provenance) ? result.provenance.length : 0
        const target = str(result.path)
        return {
          path: target,
          cells,
          provenance,
          text: [
            `notebook 已生成：${cells} 个代码单元，${provenance} 条 provenance 记录。`,
            target ? `已写入 ${target}` : '未写入文件（未传 path）。',
            '导出成功不代表重新运行通过；复现前需在干净环境重跑。',
          ].join('\n'),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_evidence',
      description:
        '证据登记与核验：record 登记可追溯结论（kind 仅 evidence/inference/hypothesis，sources 须为先前的文献/蛋白来源 id）、verify 用真实指标文件核验、list 查询。核验通过仍需人工复核。',
      parameters: {
        action: { type: 'string', enum: ['record', 'verify', 'list'], default: 'list', description: '要执行的动作。' },
        statement: { type: 'string', description: 'record 必填：结论陈述。' },
        kind: { type: 'string', enum: ['evidence', 'inference', 'hypothesis'], description: 'record 必填：结论类型。' },
        sources: { type: 'string', description: 'record 可选：来源 id，逗号分隔（来自 suwen_literature_search / suwen_protein_lookup）。' },
        limitations: { type: 'string', description: 'record 可选：已知局限。' },
        claimId: { type: 'string', description: 'verify 必填：claim id。' },
        metricsPath: { type: 'string', description: 'verify 必填：工作区内指标 JSON 路径。' },
        rules: { type: 'string', description: 'verify 必填：检查规则 JSON 数组，例如 [{"metric":"auc","op":"ge","threshold":0.8}]。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { action: { type: 'string' }, count: { type: 'integer' }, text: { type: 'string' } },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (args, exec) => {
        const action = str(args.action || 'list')
        if (action === 'record') {
          const sources = str(args.sources).split(',').map((item) => item.trim()).filter(Boolean)
          const claim = await call(
            exec,
            'claim.record',
            { statement: str(args.statement), kind: str(args.kind), sources, limitations: str(args.limitations) || undefined },
            60000,
          )
          return {
            action,
            count: 1,
            text: [
              `已登记结论 ${str(claim.id)}（${str(claim.kind)}，状态 ${str(claim.validation_status)}）`,
              str(claim.statement),
              `来源：${(claim.sources || []).join(', ') || '无'}　局限：${str(claim.limitations) || '-'}`,
              '登记成功不等于结论成立；需 verify 或人工复核。',
            ].join('\n'),
          }
        }
        if (action === 'verify') {
          let rules
          try {
            rules = JSON.parse(str(args.rules))
          } catch {
            throw new Error('rules 必须是 JSON 数组，例如 [{"metric":"auc","op":"ge","threshold":0.8}]')
          }
          const claim = await call(
            exec,
            'claim.verify',
            { claim_id: str(args.claimId), metrics_path: str(args.metricsPath), rules },
            90000,
          )
          const checks = Array.isArray(claim.checks) ? claim.checks : []
          const lines = [
            `结论 ${str(claim.id)} 校验状态：${str(claim.validation_status)}`,
            `来源核验：${claim.source_check ? '通过' : '未通过（缺少已核验来源）'}`,
          ]
          for (const check of checks) lines.push(`- ${str(check.metric)} ${str(check.op)} ${num(check.threshold)} → 实际 ${check.value === null ? '缺失' : num(check.value)}：${check.passed ? '通过' : '未通过'}`)
          lines.push(str(claim.limitations))
          return { action, count: checks.length, text: lines.join('\n') }
        }
        const listing = await call(exec, 'claim.list', {}, 60000)
        const items = Array.isArray(listing.items) ? listing.items : []
        const lines = [`共 ${items.length} 条结论：`]
        for (const item of items) lines.push(`- ${str(item.id)} [${str(item.kind)}/${str(item.validation_status)}] ${asText(str(item.statement), 300)}`)
        return { action: 'list', count: items.length, text: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_experiments',
      description:
        '实验记录：record 从工作区指标 JSON 读取真实指标登记实验、compare 比较同数据集/协议/指标/方向的多个实验、list 查询。排序只依据导入指标。',
      parameters: {
        action: { type: 'string', enum: ['record', 'compare', 'list'], default: 'list', description: '要执行的动作。' },
        name: { type: 'string', description: 'record 必填：实验名。' },
        dataset: { type: 'string', description: 'record 必填：数据集标识。' },
        protocol: { type: 'string', description: 'record 必填：评估协议标识。' },
        metric: { type: 'string', description: 'record 必填：作为评分的指标名（须存在于指标 JSON）。' },
        path: { type: 'string', description: 'record 必填：工作区内指标 JSON 路径。' },
        direction: { type: 'string', enum: ['min', 'max'], description: 'record 必填：指标方向。' },
        ids: { type: 'string', description: 'compare 必填：实验 id，逗号分隔，2–50 个。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { action: { type: 'string' }, count: { type: 'integer' }, text: { type: 'string' } },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (args, exec) => {
        const action = str(args.action || 'list')
        if (action === 'record') {
          const row = await call(
            exec,
            'experiment.record',
            {
              name: str(args.name),
              dataset: str(args.dataset),
              protocol: str(args.protocol),
              metric: str(args.metric),
              path: str(args.path),
              direction: str(args.direction),
            },
            90000,
          )
          return {
            action,
            count: 1,
            text: [
              `已登记实验 ${str(row.id)}：${str(row.name)} · ${str(row.dataset)} / ${str(row.protocol)}`,
              `${str(row.metric)} = ${num(row.score)}（方向 ${str(row.direction)}，指标哈希 ${str(row.metrics_sha256).slice(0, 12)}）`,
              '数据集与协议由调用者声明，不证明统计显著性。',
            ].join('\n'),
          }
        }
        if (action === 'compare') {
          const ids = str(args.ids).split(',').map((item) => item.trim()).filter(Boolean)
          const result = await call(exec, 'experiment.compare', { ids }, 90000)
          const ranking = Array.isArray(result.ranking) ? result.ranking : []
          const lines = [`按导入指标排序（${ranking.length} 个实验）：`]
          ranking.forEach((row, index) => lines.push(`${index + 1}. ${str(row.id)} ${num(row.score)} · ${str(row.name)}`))
          lines.push(`最佳：${(result.best || []).join(', ') || '-'}`, str(result.note))
          return { action, count: ranking.length, text: lines.join('\n') }
        }
        const listing = await call(exec, 'experiment.list', {}, 60000)
        const items = Array.isArray(listing.items) ? listing.items : []
        const lines = [`共 ${items.length} 个实验：`]
        for (const item of items) lines.push(`- ${str(item.id)} ${str(item.name)} · ${str(item.dataset)}/${str(item.protocol)} · ${str(item.metric)}=${num(item.score)}`)
        return { action: 'list', count: items.length, text: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_knowledge',
      description:
        '知识库：add 写入笔记/资料（自动脱敏与敏感数据拦截）、index 索引工作区内文档（csv/tsv/json/jsonl/md/txt/parquet/pdf/docx）、search 检索、list 列出。检索命中必须回到来源核实。',
      parameters: {
        action: { type: 'string', enum: ['add', 'index', 'search', 'list'], default: 'list', description: '要执行的动作。' },
        title: { type: 'string', description: 'add 必填：标题。' },
        text: { type: 'string', description: 'add 必填：正文。' },
        kind: { type: 'string', description: 'add 可选：类别，默认 memory。' },
        source: { type: 'string', description: 'add/search 可选：来源标识或过滤来源。' },
        locator: { type: 'string', description: 'add 可选：定位信息（页码、URL 等）。' },
        path: { type: 'string', description: 'index 必填：工作区内文档路径。' },
        query: { type: 'string', description: 'search 必填：检索词。' },
        limit: { type: 'integer', description: 'search 返回条数 1–20，默认 5。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { action: { type: 'string' }, count: { type: 'integer' }, text: { type: 'string' } },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (args, exec) => {
        const action = str(args.action || 'list')
        if (action === 'add') {
          const row = await call(
            exec,
            'knowledge.add',
            {
              title: str(args.title),
              text: str(args.text),
              kind: str(args.kind) || 'memory',
              source: str(args.source) || undefined,
              locator: str(args.locator) || undefined,
            },
            60000,
          )
          return { action, count: 1, text: `已写入知识条目 ${str(row.id)}（${str(row.kind)}，摘要 ${str(row.digest).slice(0, 12)}）；冲突 ${(row.conflicts || []).length} 条。` }
        }
        if (action === 'index') {
          const result = await call(exec, 'knowledge.index', { path: str(args.path) }, 180000)
          return { action, count: num(result.added || result.count), text: `已索引 ${str(args.path)}：${json(result)}` }
        }
        if (action === 'search') {
          const result = await call(
            exec,
            'knowledge.search',
            { query: str(args.query), limit: args.limit, source: str(args.source) || undefined },
            60000,
          )
          const items = Array.isArray(result.items) ? result.items : []
          const lines = [`检索「${str(args.query)}」命中 ${items.length} 条：`]
          for (const item of items) {
            lines.push('', `- ${str(item.title)}${item.locator ? `（${str(item.locator)}）` : ''}`, `  ${asText(str(item.text), 500)}`)
          }
          lines.push('', '命中只说明文本相关，须回到来源核实。')
          return { action, count: items.length, text: lines.join('\n') }
        }
        const listing = await call(exec, 'knowledge.list', {}, 60000)
        const items = Array.isArray(listing.items) ? listing.items : []
        const lines = [`共 ${items.length} 条知识：`]
        for (const item of items) lines.push(`- ${str(item.id)} [${str(item.kind)}] ${str(item.title)}`)
        return { action: 'list', count: items.length, text: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'suwen_science_skills',
      description:
        '素问科研方法技能：不传 name 返回技能目录（名称+用途+适用场景），传准确 name 读取该技能的完整正文与文件清单。按需读取，不要一次读全部。',
      parameters: {
        name: { type: 'string', description: '技能名，例如 single-cell-downstream；留空列出目录。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { count: { type: 'integer' }, name: { type: 'string' }, text: { type: 'string' } },
        },
        render: (_args, value) => textBlock(value.text),
      },
      execute: async (args, exec) => {
        const target = str(args.name).trim()
        if (target) {
          const result = await call(exec, 'skills.read', { name: target }, 60000)
          const skill = result.skill || {}
          const files = Array.isArray(skill.files) ? skill.files : []
          return {
            count: 1,
            name: str(skill.name),
            text: [
              `# ${str(skill.name)}`,
              `用途：${str(skill.description)}`,
              `适用场景：${str(skill.when_to_use)}`,
              files.length ? `附带文件：${files.join(', ')}` : '',
              '',
              asText(str(skill.body), 12000),
            ].filter(Boolean).join('\n'),
          }
        }
        const result = await call(exec, 'skills.list', {}, 60000)
        const items = Array.isArray(result.items) ? result.items : []
        const lines = [`共 ${items.length} 个科研技能（用 name 读取正文）：`]
        for (const item of items) lines.push('', `- ${str(item.name)}：${str(item.description)}`, `  适用：${str(item.when_to_use)}`)
        return { count: items.length, name: '', text: lines.join('\n') }
      },
    }),
  )
}
