/**
 * Where a loop session keeps its files.
 *
 * The project directory holds `.zloop/config.json` (human overrides); the working
 * directory holds the ledger, the frozen benchmark scripts and the reports. They
 * are the same directory unless config.json sets `workDir`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const STATE_DIR = '.zloop'

export function readProjectConfig(projectDir) {
  const file = join(projectDir, STATE_DIR, 'config.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function resolveWorkDir(projectDir) {
  const cfg = readProjectConfig(projectDir)
  const raw = typeof cfg.workDir === 'string' ? cfg.workDir.trim() : ''
  if (!raw) return projectDir
  return isAbsolute(raw) ? raw : resolve(projectDir, raw)
}

export function loopPaths(projectDir) {
  const workDir = resolveWorkDir(projectDir)
  const dir = join(workDir, STATE_DIR)
  return {
    projectDir,
    workDir,
    dir,
    ledger: join(dir, 'ledger.jsonl'),
    brief: join(dir, 'brief.md'),
    bench: join(dir, 'bench.sh'),
    gate: join(dir, 'gate.sh'),
    config: join(projectDir, STATE_DIR, 'config.json'),
    reportHtml: join(workDir, 'loop-report.html'),
    reportMd: join(workDir, 'loop-report.md'),
    lastRun: join(dir, 'last-run.json'),
  }
}
