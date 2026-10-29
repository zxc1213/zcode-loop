#!/usr/bin/env node
/**
 * PreToolUse hook: the benchmark and the gate are frozen while a round is open.
 * Rewriting them mid-loop would make every earlier measurement incomparable.
 */
import { relative, resolve } from 'node:path'
import { loopPaths } from '../lib/paths.mjs'

const PROJECT_DIR = process.argv[2] || process.env.ZCODE_PROJECT_DIR || process.cwd()
const paths = loopPaths(PROJECT_DIR)
const FROZEN = new Set(
  [paths.bench, paths.gate, paths.ledger].map((file) => relative(paths.workDir, file).replace(/\\/g, '/')),
)

async function readStdin() {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

try {
  const raw = await readStdin()
  if (!raw.trim()) process.exit(0)
  const input = JSON.parse(raw)
  const toolInput = input.tool_input || input.toolInput || {}
  const filePath = toolInput.file_path || toolInput.path || ''
  if (!filePath) process.exit(0)
  const rel = relative(paths.workDir, resolve(paths.workDir, filePath)).replace(/\\/g, '/')
  if (!FROZEN.has(rel)) process.exit(0)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[zcode-loop] ${rel} 在循环期间是冻结的：基准与门禁不能改动，账本只能由 loop_commit 追加。要换度量请用 loop_open 开新一轮。`,
      },
    }),
  )
} catch {
  process.exit(0)
}
