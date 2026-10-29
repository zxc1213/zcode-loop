# Setup: from a goal to a benchmark

A loop is bounded by the quality of its benchmark. Spend the setup time here.

## 1. Pick a mechanical metric

Good: `p95_ms`, `build_seconds`, `bundle_kb`, `query_ms`, `failing_tests`,
`tokens_used`, `score`.

Bad: "code quality", "readability", "user happiness", anything you would argue
about. If two honest people could disagree about the number, it is not a metric.

Rules:

- **One primary metric.** The loop optimizes exactly one number; everything else
  is a guardrail.
- **Reproducible.** Same command, same machine, comparable output. Pin versions,
  warm up caches, avoid network where possible.
- **Cheap enough to run 20 times.** If one run takes 10 minutes, the round is
  over before it starts.
- **Measured, not asserted.** The script prints the number; you do not type it.

## 2. Write `.zloop/bench.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# warm up (so the first run is not the slowest)
./gradlew -q assembleDebug >/dev/null 2>&1 || true

start=$(date +%s%3N)
./gradlew -q :app:assembleRelease >/dev/null
end=$(date +%s%3N)

bundle_kb=$(stat -c %s app/build/outputs/apk/release/app-release.apk | awk '{printf "%.1f", $1/1024}')

echo "METRIC build_seconds=$(( (end - start) / 1000 ))"
echo "METRIC bundle_kb=$bundle_kb"
```

Rules:

- Print **only** `METRIC name=value` lines that matter; other output is fine but
  only the tail reaches the agent.
- Values must be plain numbers (no units, no thousands separators).
- Exit non-zero when the measurement itself failed — the loop records `error`
  instead of pretending it measured something.
- Keep it deterministic: no `date`, no random ports, no network calls, no
  interactive prompts.

Secondary metrics (bundle size, memory, test count) are just extra `METRIC`
lines; declare them as constraints at `loop_open`:

```json
{ "metric": "bundle_kb", "maxPct": 105 }
```

That means "keep only while bundle stays within 5% of the baseline".

## 3. Write `.zloop/gate.sh` (recommended)

A correctness gate: the change must still be correct, not just faster.

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm test --silent
```

Gate rules:

- Exit 0 = pass, anything else = fail.
- Gate failure blocks `keep`; the tool tells you to `drop` instead.
- Keep the gate fast (it runs after every benchmark).
- Never weaken the gate mid-round — that is moving the goalposts.

## 4. Choose direction and budget

- `direction: "lower"` for latency / size / time / errors; `"higher"` for
  throughput / coverage / score.
- Budget defaults: 20 trials, 120 minutes, 3 consecutive failures. Tighten them
  for expensive benchmarks; the Stop hook respects them.

## 5. Freeze and open

```bash
git init            # if the work dir is not a repo yet
git add -A && git commit -m "loop: clean baseline"
chmod +x .zloop/bench.sh .zloop/gate.sh
```

Then `loop_open` with the goal, metric name, direction and budget, and record
the baseline with `loop_commit` (`decision: "baseline"`).

> A dirty work tree at `loop_open` is reported as a warning: commit unrelated
> work first, otherwise `revert` will discard it.

## 6. Where the research directory lives

Default: the project directory. To measure a copy or a sibling worktree, add to
`.zloop/config.json` in the project:

```json
{ "workDir": "work/" }
```

The ledger, benchmark, gate, git operations and reports all move there; the
config stays put.
