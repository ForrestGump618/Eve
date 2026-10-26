/**
 * NDJSON client for the SuWen science backend (`python -m omicslab.integrations.science`).
 *
 * The backend runs no model, no AppState and no agent loop: every request names one
 * operation and its parameters, and the caller (a DSH tool) drives the reasoning.
 * One child process per (workspace, home) pair; the pool keeps a few alive.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const MAX_LINE = 8 * 1024 * 1024
const MAX_STDERR = 6000
const MAX_CLIENTS = 3

/** Errors raised by the backend carry the backend's own code. */
export class ScienceError extends Error {
  constructor(message, code = 'science_error', type = '') {
    super(message)
    this.name = 'ScienceError'
    this.code = code
    this.type = type
  }
}

export class ScienceClient {
  constructor(options) {
    this.options = options
    this.child = null
    this.pending = new Map()
    this.sequence = 0
    this.buffer = ''
    this.stderr = ''
    this.closed = false
    this.lastUsed = Date.now()
  }

  get alive() {
    return this.child !== null && this.child.exitCode === null && this.child.killed !== true
  }

  diagnostic() {
    const tail = this.stderr.trim()
    if (!tail) return ''
    if (/No module named ['"]?omicslab/i.test(tail)) {
      return `${tail}\n提示：该 Python 无法 import omicslab，请设置 repoPath（素问仓库根目录）或先 pip install -e .`
    }
    return tail
  }

  start() {
    if (this.closed) throw new ScienceError('科研后端已关闭', 'disposed')
    if (this.alive) return
    const { pythonPath, workspace, home, repoPath } = this.options
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    if (repoPath) env.PYTHONPATH = env.PYTHONPATH ? `${repoPath}${process.platform === 'win32' ? ';' : ':'}${env.PYTHONPATH}` : repoPath
    const child = spawn(
      pythonPath || process.env.SUWEN_PYTHON || 'python',
      ['-m', 'omicslab.integrations.science', '--stdio', '--workspace', workspace, '--home', home],
      { cwd: repoPath || workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child = child
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR)
    })
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      this.child = null
      this.fail(new ScienceError(`无法启动科研后端：${error.message}`, 'spawn_failed'))
    })
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      this.fail(new ScienceError(`科研后端已退出（code=${code}）`, 'backend_exited', this.diagnostic()))
    })
  }

  onData(chunk) {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE) {
      this.buffer = ''
      this.stderr = `${this.stderr}\n[科研后端输出超长行，已丢弃]`.slice(-MAX_STDERR)
      return
    }
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (!line.trim()) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      const entry = this.pending.get(String(frame && frame.id))
      if (!entry) continue
      this.pending.delete(String(frame.id))
      if (frame.ok === false) {
        const error = frame.error || {}
        entry.reject(new ScienceError(String(error.message || '科研后端返回错误'), String(error.code || 'backend_error'), String(error.type || '')))
      } else {
        entry.resolve(frame.result === undefined ? {} : frame.result)
      }
    }
  }

  fail(error) {
    for (const entry of [...this.pending.values()]) entry.reject(error)
    this.pending.clear()
  }

  /**
   * One request. `signal` interruption maps to `python.interrupt` for the kernel so a
   * cancelled tool call does not leave a runaway cell behind.
   */
  request(op, params = {}, { signal, timeoutMs = 120000 } = {}) {
    this.start()
    this.lastUsed = Date.now()
    if (signal && signal.aborted) return Promise.reject(new ScienceError('操作已取消', 'aborted'))
    return new Promise((resolve, reject) => {
      const id = String(++this.sequence)
      const interrupt = () => {
        if (op === 'python.execute') this.request('python.interrupt', {}, { timeoutMs: 15000 }).catch(() => {})
      }
      const cleanup = () => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
      }
      const entry = {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }
      const onAbort = () => {
        interrupt()
        entry.reject(new ScienceError('操作已取消', 'aborted'))
      }
      const timer = setTimeout(() => {
        interrupt()
        entry.reject(new ScienceError(`科研操作 ${op} 超时（${timeoutMs}ms）`, 'request_timeout'))
      }, Math.max(1000, timeoutMs))
      this.pending.set(id, entry)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      const payload = {}
      for (const [key, value] of Object.entries(params)) if (value !== undefined) payload[key] = value
      try {
        this.child.stdin.write(`${JSON.stringify({ id, op, params: payload })}\n`)
      } catch (error) {
        entry.reject(new ScienceError(`无法写入科研后端：${error.message}`, 'write_failed'))
      }
    })
  }

  async dispose() {
    if (this.closed) return
    this.closed = true
    const child = this.child
    this.child = null
    if (!child) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* best effort */
        }
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.stdin.write(`${JSON.stringify({ id: 'shutdown', op: 'shutdown', params: {} })}\n`)
      } catch {
        /* best effort */
      }
    })
    this.fail(new ScienceError('科研后端已关闭', 'disposed'))
  }
}

/** Keeps a bounded number of backend processes, keyed by workspace + home. */
export class SciencePool {
  constructor(options) {
    this.options = options
    this.clients = new Map()
  }

  get(workspace, home) {
    const key = `${workspace}\u0000${home}`
    let client = this.clients.get(key)
    if (!client || client.closed) {
      client = new ScienceClient({
        pythonPath: this.options.pythonPath,
        repoPath: this.options.repoPath,
        workspace,
        home,
      })
      this.clients.set(key, client)
      this.prune()
    }
    return client
  }

  prune() {
    if (this.clients.size <= MAX_CLIENTS) return
    const idle = [...this.clients.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    while (this.clients.size > MAX_CLIENTS && idle.length) {
      const [key, client] = idle.shift()
      this.clients.delete(key)
      client.dispose().catch(() => {})
    }
  }

  async dispose() {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map((client) => client.dispose()))
  }
}

/** Creates the backend data directory; the backend itself refuses a missing workspace. */
export function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  return directory
}
