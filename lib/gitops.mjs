/**
 * Thin, synchronous git wrapper. The loop only needs four things: know whether
 * the work dir is a repo, commit a kept trial, undo everything else, and keep
 * the ledger out of both.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const IGNORE_ENTRIES = ['.zloop/', 'loop-report.html', 'loop-report.md']

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

export function isRepo(cwd) {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.status === 0 && r.stdout.trim() === 'true'
}

export function hasHead(cwd) {
  return git(cwd, ['rev-parse', '--verify', 'HEAD']).status === 0
}

export function currentBranch(cwd) {
  const r = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.status === 0 ? r.stdout.trim() : ''
}

export function isDirty(cwd) {
  const r = git(cwd, ['status', '--porcelain'])
  if (r.status !== 0) return false
  return r.stdout
    .split('\n')
    .some((line) => line.trim() && !IGNORE_ENTRIES.some((entry) => line.includes(entry.replace(/\/$/, ''))))
}

/** Append the loop's own artefacts to .gitignore once. */
export function ensureIgnored(cwd) {
  const file = join(cwd, '.gitignore')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const missing = IGNORE_ENTRIES.filter((entry) => !existing.split('\n').some((l) => l.trim() === entry))
  if (missing.length === 0) return false
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  appendFileSync(file, `${prefix}${missing.join('\n')}\n`)
  return true
}

export function commitAll(cwd, message) {
  const add = git(cwd, ['add', '-A', '--', '.'])
  if (add.status !== 0) return { hash: null, error: add.stderr.trim() || 'git add failed' }
  // The ledger lives under .zloop and is usually ignored; unstage it anyway so a
  // repo without that .gitignore entry never commits loop state by accident.
  git(cwd, ['reset', '-q', '--', '.zloop'])
  const staged = git(cwd, ['diff', '--cached', '--name-only'])
  if (staged.status === 0 && staged.stdout.trim() === '') {
    return { hash: null, error: 'nothing to commit' }
  }
  const commit = git(cwd, ['commit', '-m', message, '--no-verify'])
  if (commit.status !== 0) {
    return { hash: null, error: commit.stderr.trim() || commit.stdout.trim() || 'git commit failed' }
  }
  const hash = git(cwd, ['rev-parse', '--short', 'HEAD'])
  return { hash: hash.status === 0 ? hash.stdout.trim() : null, error: null }
}

/**
 * Drop every uncommitted change, keeping the loop's own state. An unborn HEAD
 * (brand-new repo) has no tracked files to restore, so only the clean step runs.
 */
export function rollbackAll(cwd) {
  const errors = []
  if (hasHead(cwd)) {
    const checkout = git(cwd, ['checkout', '--', '.'])
    if (checkout.status !== 0) errors.push(checkout.stderr.trim() || 'git checkout failed')
    const reset = git(cwd, ['reset', '--', '.'])
    if (reset.status !== 0) errors.push(reset.stderr.trim() || 'git reset failed')
  }
  const clean = git(cwd, ['clean', '-fd', '-e', '.zloop', '-e', 'loop-report.html', '-e', 'loop-report.md'])
  if (clean.status !== 0) errors.push(clean.stderr.trim() || 'git clean failed')
  return { ok: errors.length === 0, errors }
}

export function recentLog(cwd, count = 5) {
  const r = git(cwd, ['log', `-${count}`, '--pretty=%h %s'])
  return r.status === 0 ? r.stdout.trim() : ''
}
