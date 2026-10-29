# The iteration contract

Precise semantics of one trial, the decisions, and what to do when things go
wrong.

## One trial

1. **Review.** Read the injected ledger summary (or `loop_state`) and
   `git log --oneline -5`. The last kept commit is your prior art.
2. **Hypothesis.** One line: "if I change X, metric Y should move because Z".
   Prefer the previous trial's `observed` / `next` hint.
3. **Change one thing.** Inside the agreed scope. No drive-by refactors.
4. **Measure.** `loop_run`. If the metric is noisy (delta within ~10% of the
   spread), use `repeat: 3` and compare medians.
5. **Decide** with `loop_commit`:

   | Situation                                   | decision   | git effect                     |
   | ------------------------------------------- | ---------- | ------------------------------ |
   | first measurement of the round              | `baseline` | none                           |
   | metric beats the best                       | `keep`     | commit `loop: <note>`          |
   | metric equal or worse                       | `revert`   | working tree rolled back       |
   | gate failed / idea abandoned                | `drop`     | rolled back                    |
   | benchmark crashed, timed out, no metric     | `error`    | rolled back                    |
   | measured without changing anything          | `noop`     | none                           |

6. **Record the why.** `note` (required), `hypothesis`, `expected`, `observed`.
   These fields survive the revert; the code does not.

## What the ledger refuses

- `keep` when the metric is not better than the best (use `revert`)
- `revert` when the metric *is* better (use `keep`, or `drop` with a reason)
- `baseline` anywhere but as the first trial of a round
- `error` carrying a metric
- a caller-supplied `commit`
- `keep` when the gate failed or a declared constraint is violated

Every rejection comes with the reason and the decision you should have used.

## Signals

| Signal                       | Meaning                                     | Action                                                  |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `confidence.level = low`     | delta smaller than measurement noise        | re-measure with `repeat: 3`; keep but do not build on it |
| `confidence.level = high`    | delta ≥ 3× noise                            | trust it, move to a bigger hypothesis                   |
| `plateau: true`              | last 5 trials moved < 1%                    | re-measure, open a new round, or close                  |
| `doom_loop.pattern = repeat` | same hypothesis ≥ 3 times                   | change direction structurally                           |
| `doom_loop.pattern = oscillate` | A → B → A → B                            | pick a third direction or stop                          |
| `benchmark_drift: true`      | bench/gate changed since the round opened   | restore the frozen script or open a new round           |

## Failure handling

- **Benchmark crashes** → fix the benchmark or the change, `loop_commit` `error`.
  Two crashes in a row: shrink the hypothesis.
- **Timeout** → the process tree is killed; recorded as `error`.
- **Gate fails** → `drop` with the reason; never keep.
- **Rollback fails** (merge conflict, unusual repo state) → the tool refuses the
  decision; resolve by hand, then retry.
- **Budget exhausted** → the Stop hook stops continuing; `loop_close` with a
  summary.
- **User interrupts** → finish the current measure/commit pair first, then
  summarize.

## Closing

`loop_close` records baseline → best, trials, kept count and the summary into the
brief. Then `loop_report` for the HTML dashboard and the markdown table. Kept
commits stay on the branch; if you need them isolated, branch before starting
the next round.
