import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SERVER = resolve(import.meta.dirname, '..', 'mcp', 'server.mjs')

class McpClient {
  constructor(projectDir) {
    this.child = spawn(process.execPath, [SERVER], {
      cwd: projectDir,
      env: { ...process.env, ZCODE_PROJECT_DIR: projectDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let index
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (!line) continue
        const message = JSON.parse(line)
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      }
    })
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolvePromise(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectPromise(error)
        },
      })
    })
  }

  async initialize() {
    return this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  }

  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args })
    const text = result.content?.[0]?.text ?? '{}'
    return JSON.parse(text)
  }

  close() {
    return new Promise((resolvePromise) => {
      if (this.child.exitCode !== null) {
        resolvePromise()
        return
      }
      const timer = setTimeout(resolvePromise, 3000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      this.child.kill()
    })
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), 'zloop-it-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'loop@test.local'])
  git(dir, ['config', 'user.name', 'Loop Test'])
  writeFileSync(join(dir, 'state.txt'), '10\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  mkdirSync(join(dir, '.zloop'), { recursive: true })
  writeFileSync(
    join(dir, '.zloop', 'bench.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nv=$(cat state.txt)\necho "METRIC score=$v"\necho "METRIC mem=64"\n',
  )
  return dir
}

test('end to end: baseline → keep → revert → audit → report → close', async () => {
  const dir = setupProject()
  const client = new McpClient(dir)
  try {
    const init = await client.initialize()
    assert.equal(init.serverInfo.name, 'zcode-loop')

    const tools = await client.request('tools/list', {})
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['loop_close', 'loop_commit', 'loop_open', 'loop_report', 'loop_run', 'loop_state'],
    )

    const open = await client.call('loop_open', {
      goal: 'make the fake score go up',
      metric: 'score',
      direction: 'higher',
      budget: { maxTrials: 6 },
    })
    assert.equal(open.ok, true, JSON.stringify(open))
    assert.equal(open.round, 1)
    assert.ok(existsSync(join(dir, '.zloop', 'brief.md')))
    assert.ok(readFileSync(join(dir, '.gitignore'), 'utf8').includes('.zloop/'))

    const baseline = await client.call('loop_run', {})
    assert.equal(baseline.metric, 10)
    assert.equal(baseline.metrics.mem, 64)

    const locked = await client.call('loop_run', { command: 'echo METRIC score=999' })
    assert.equal(locked.ok, false)
    assert.match(locked.error, /frozen/)

    const baselineCommit = await client.call('loop_commit', { decision: 'baseline', note: 'starting point' })
    assert.equal(baselineCommit.ok, true, JSON.stringify(baselineCommit))
    assert.equal(baselineCommit.baseline, 10)

    // keep: a real improvement gets committed
    writeFileSync(join(dir, 'state.txt'), '12\n')
    const improved = await client.call('loop_run', { repeat: 2 })
    assert.equal(improved.metric, 12)
    assert.equal(improved.median_metric, 12)
    const kept = await client.call('loop_commit', {
      decision: 'keep',
      note: 'store the value as a number',
      hypothesis: 'parse instead of reading a string',
      observed: 'score +2',
    })
    assert.equal(kept.ok, true, JSON.stringify(kept))
    assert.equal(kept.git, 'committed')
    assert.ok(kept.commit)
    assert.equal(kept.best, 12)
    assert.equal(kept.delta_pct, 20)

    // revert: a worse measurement is rolled back
    writeFileSync(join(dir, 'state.txt'), '11\n')
    const worse = await client.call('loop_run', {})
    assert.equal(worse.metric, 11)
    const reverted = await client.call('loop_commit', { decision: 'revert', note: 'slower variant' })
    assert.equal(reverted.ok, true, JSON.stringify(reverted))
    assert.equal(reverted.git, 'rolled back')
    assert.equal(readFileSync(join(dir, 'state.txt'), 'utf8').trim(), '12')

    // audit: keep without an improvement is refused
    writeFileSync(join(dir, 'state.txt'), '11\n')
    await client.call('loop_run', {})
    const badKeep = await client.call('loop_commit', { decision: 'keep', note: 'should not pass' })
    assert.equal(badKeep.ok, false)
    assert.match(badKeep.error, /keep_not_better/)

    // drift: changing the frozen benchmark is reported
    writeFileSync(join(dir, '.zloop', 'bench.sh'), '#!/usr/bin/env bash\necho "METRIC score=99"\n')
    const drifted = await client.call('loop_run', {})
    assert.equal(drifted.benchmark_drift, true)

    const snapshot = await client.call('loop_state', {})
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.state.trials, 3)
    assert.equal(snapshot.state.best, 12)
    assert.match(snapshot.state.next, /drift|hypothesis|plateau|stop/i)

    const report = await client.call('loop_report', {})
    assert.equal(report.ok, true)
    assert.ok(existsSync(report.html))
    assert.ok(existsSync(report.markdown))
    assert.match(readFileSync(report.markdown, 'utf8'), /make the fake score go up/)

    const closed = await client.call('loop_close', { summary: 'kept the parser change' })
    assert.equal(closed.ok, true)
    assert.equal(closed.state.active, false)

    const afterClose = await client.call('loop_run', {})
    assert.equal(afterClose.ok, false)
    assert.match(afterClose.error, /closed/)
  } finally {
    await client.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Windows occasionally keeps the temp dir locked for a moment.
    }
  }
})
