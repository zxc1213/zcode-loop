---
name: zcode-loop
description: Run a measurement loop in ZCode. State a goal and one mechanical metric, then iterate — change one thing, run the benchmark, keep what moves the number, revert what does not. Use when the user wants the agent to optimize something measurable over many attempts (latency, bundle size, build time, test duration, memory, score) rather than hand-hold each tweak.
---

# zcode-loop

A loop is only as good as its metric. This plugin owns the mechanics — timing,
metric parsing, git keep/revert, the ledger — and you own the judgement: which
hypothesis to test next and whether a number means anything.

## Non-negotiables

1. **The benchmark is frozen.** Never edit `.zloop/bench.sh` or `.zloop/gate.sh`
   during a round (a hook denies it). A new metric means a new round.
2. **One change per trial.** A mixed diff makes keep/revert meaningless.
3. **Never keep a failing change.** If `.zloop/gate.sh` failed, use
   `decision: "drop"` — the tool refuses keep.
4. **Never book a number you did not measure.** `loop_commit` takes the metric
   from the last `loop_run`; do not type a nicer one.
5. **A keep must beat the best.** Equal or worse results are `revert`.

## The loop

1. **Setup** (once per goal): read `references/setup.md`. Write
   `.zloop/bench.sh` so it prints `METRIC <name>=<value>` (plus any secondary
   metrics). Optionally write `.zloop/gate.sh` as a correctness gate.
2. `loop_open` with goal / metric / direction / budget / constraints.
3. **Baseline**: `loop_run` → `loop_commit` with `decision: "baseline"`.
4. **Iterate**:
   - pick one hypothesis; prefer the previous `observed` / `next` hint;
   - change one thing;
   - `loop_run` (use `repeat: 3` when the metric is noisy and log the median);
   - `loop_commit`:
     - better than best → `keep` (auto-commits `loop: <note>`)
     - equal or worse → `revert` (rolls the working tree back)
     - gate failed or idea abandoned → `drop`
     - benchmark crashed → `error`
     - measured but changed nothing → `noop`
   - always fill `note`, and `hypothesis` / `expected` / `observed`: they are the
     only memory that survives a revert.
5. **Watch the signals** in the `loop_commit` reply:
   - `confidence.level = low` → the delta is inside the noise; re-measure with
     `repeat: 3` before building on it.
   - `plateau: true` → last 5 trials moved < 1%; re-measure, open a new round,
     or close.
   - `doom_loop` → you are repeating or oscillating; change direction
     structurally.
6. **Close**: `loop_close` with a summary, then `loop_report` for the dashboard
   and the markdown summary.

## State

Everything lives in `.zloop/` in the work dir (config stays in the project dir):

- `ledger.jsonl` — append-only truth: `open`, `trial`, `close` rows.
- `brief.md` — the charter: goal, metric, scope, what was tried.
- `bench.sh` / `gate.sh` — frozen measurement and correctness gate.
- `last-run.json` — the pending measurement `loop_commit` will use.
- `config.json` (project dir) — `maxTrials`, `maxMinutes`, `maxFailures`,
  `autoContinue: false` to stop the Stop-hook continuation, `workDir` to put the
  research directory elsewhere.

## Reports

`loop_report` writes `loop-report.html` (self-contained, sparkline) and
`loop-report.md` (a table that drops straight into a weekly report).

## References

- `references/setup.md` — how to turn a goal into a benchmark that cannot lie.
- `references/protocol.md` — the full iteration contract and failure handling.
