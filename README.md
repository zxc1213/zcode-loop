# zcode-loop

[中文](./README_CN.md)

An auditable measurement loop for ZCode's coding agent: state a goal and one mechanical metric, change one thing at a time, run the benchmark, keep what moves the number, revert what does not, and leave a ledger of every attempt.

Built for work like: cut build time, trim p95 latency, shrink a bundle, speed up tests, raise a score — anything where a number can be measured reliably.

## What it fixes

"Let the model optimize it" usually breaks in three places: the metric drifts, changes pile up, and conclusions get forgotten.

- **The metric cannot drift**: `.zloop/bench.sh` is frozen for the round (a hook denies writes), `loop_run` only accepts that script, and any change is reported as `benchmark_drift`.
- **Changes cannot pile up**: one trial = one commit (`loop: <note>`); everything else is rolled back, with git as the source of truth.
- **Conclusions survive**: `.zloop/ledger.jsonl` is append-only and records hypothesis, expectation, observation and confidence for each trial; a hook re-injects the summary into new sessions.

## Install

Marketplace repo: <https://github.com/zxc1213/zcode-loop>

```bash
zcode plugins marketplace add zxc1213/zcode-loop
zcode plugins install zcode-loop@zcode-loop
```

Or via Settings → Plugin Marketplace → Add → paste `zxc1213/zcode-loop`.

Start a new session (or restart ZCode) after installing so the MCP tools load.

## Quick start

```
/zcode-loop:loop get first paint under 1.5s
```

Or by hand:

1. Write `.zloop/bench.sh` that prints `METRIC name=value` lines:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   start=$(date +%s%3N)
   npm run build >/dev/null
   echo "METRIC build_seconds=$(( ($(date +%s%3N) - start) / 1000 ))"
   echo "METRIC bundle_kb=$(du -k dist/app.js | cut -f1)"
   ```

2. Optionally write `.zloop/gate.sh` as a correctness gate (exit 0 = pass, usually `npm test`).
3. `git init`, commit a clean baseline, then `loop_open`.
4. Iterate: one change → `loop_run` → `loop_commit`.

## Tools (MCP)

| Tool | Purpose |
|---|---|
| `loop_open` | Open a round: goal, primary metric, direction, budget (trials/minutes/failures), optional secondary constraints. `resume: true` inspects without opening. |
| `loop_run` | Run the benchmark: time it, parse `METRIC name=value`, optional repeats with median, run `.zloop/gate.sh`, report benchmark drift. Only `bench.sh` may run when it exists. |
| `loop_commit` | Record the decision: `baseline` / `keep` (auto-commit) / `revert` (rollback) / `drop` (abandon) / `error` (crash) / `noop`. Impossible rows are rejected. |
| `loop_state` | Snapshot: baseline, best, delta, budget burn, confidence, plateau/doom-loop flags, recent trials, git log. |
| `loop_report` | Writes `loop-report.html` (self-contained, sparkline) and `loop-report.md` (weekly-report ready). |
| `loop_close` | Close the round with a summary. |

## Decision semantics

| Situation | Decision | Git effect |
|---|---|---|
| First measurement of the round | `baseline` | none |
| Better than the best | `keep` | commit `loop: <note>` |
| Equal or worse | `revert` | working tree rolled back |
| Gate failed / idea abandoned | `drop` | rolled back |
| Benchmark crashed, timed out, no metric | `error` | rolled back |
| Measured without changing anything | `noop` | none |

The ledger refuses: `keep` without an improvement, `revert` of an improvement, `baseline` after the first trial, `error` carrying a metric, caller-supplied commits, `keep` after a failed gate, and `keep` that violates a declared constraint.

## Guardrails

- **Frozen benchmark**: PreToolUse hook denies writes to `.zloop/bench.sh`, `gate.sh`, `ledger.jsonl`.
- **Only the benchmark runs**: with `bench.sh` present, `loop_run` accepts only its usual spellings.
- **Drift detection**: hash of bench/gate recorded at open, compared at every run.
- **Correctness backpressure**: a failed `gate.sh` blocks `keep`.
- **Secondary constraints**: declared at `loop_open` (`{metric, maxPct}`), enforced at `keep`.
- **Stopping rules**: trial, time and consecutive-failure budgets; the Stop hook stops continuing when one is hit.
- **Signals**: confidence (signal/noise), plateau (last 5 trials < 1%), repeat/oscillation detection.
- **Pause switch**: `autoContinue: false` in `.zloop/config.json`.

## State

```text
<work-dir>/
  .zloop/
    ledger.jsonl     # append-only: open / trial / close rows
    brief.md         # charter: goal, metric, constraints, what was tried
    bench.sh         # frozen benchmark
    gate.sh          # optional correctness gate
    last-run.json    # the pending measurement
  loop-report.html
  loop-report.md
```

`.zloop/config.json` (project dir) overrides `maxTrials`, `maxMinutes`, `maxFailures`, `autoContinue`, and `workDir` (run the research in a different directory; everything moves there except the config).

## Commands and skill

- `/zcode-loop:loop <goal>` — enter or resume
- `/zcode-loop:loop-status` — progress
- `/zcode-loop:loop-report` — dashboard + markdown
- `/zcode-loop:loop-stop [summary]` — close
- Skill `zcode-loop` — protocol and setup guide under `skills/zcode-loop/references/`

## Design notes

Inspired by karpathy's autoresearch idea and ZCode's official `autoresearch` plugin; this is an independent implementation with different trade-offs:

- **Zero dependencies, zero build**: plain ESM `.mjs`, Node ≥ 18, no TypeScript stripping or bundling.
- **Stricter decisions**: `baseline` is explicit, `keep` must be a real improvement, `revert` must be a real regression, a failed gate can only `drop`.
- **Constraints up front**: declared once at `loop_open` instead of per commit.
- **Two report shapes**: HTML for the trajectory, Markdown for the weekly report.

## Development

```bash
npm test          # unit + hook + MCP end-to-end against a real git repo
```

No third-party dependencies.

## Known limits

- Requires `bash` and `git`.
- `keep` uses `git add -A`: commit unrelated work before opening a round.
- Cross-turn unattended runs depend on host capabilities; this plugin only continues within a session.
- Headless `--prompt` runs do not execute hooks, so the guardrails apply to interactive sessions.

## License

MIT
