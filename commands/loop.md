---
description: 进入/恢复实验循环。已有会话则续跑，否则从目标开始搭建。用法：/zcode-loop:loop <目标>
---

进入实验循环模式（本工作区）。

1. 先读 `.zloop/ledger.jsonl` 与 `.zloop/brief.md`：
   - 有未结束的轮次 → 调 `loop_state`，向用户报告进度（轮次、baseline、best、已用试验数），然后继续循环。
   - 没有会话 → 按下面的步骤搭建。
2. 搭建新轮次（参考 `${ZCODE_PLUGIN_ROOT}/skills/zcode-loop/references/setup.md`）：
   - 从 $ARGUMENTS 提炼**一个可机械测量的主度量**（延迟/体积/耗时/分数…），确认方向（越小越好/越大越好）。
   - 写 `.zloop/bench.sh`：输出若干行 `METRIC name=value`，退出码非 0 表示测量失败。需要正确性门禁时再写 `.zloop/gate.sh`（0 = 通过）。
   - 确保工作目录是 git 仓库且工作树干净（先提交基线）。
   - 调 `loop_open`（goal / metric / direction / budget，可选 constraints）。
   - `loop_run` 跑基线 → `loop_commit`，`decision: "baseline"`。
3. 之后按 skill `zcode-loop` 的循环执行：一次只改一处 → `loop_run` → `loop_commit`（keep/revert/drop/error/noop）。
4. 提醒用户：
   - `.zloop/bench.sh` 与 `.zloop/gate.sh` 在循环期间被 hook 冻结；
   - `/zcode-loop:loop-report` 生成 HTML dashboard 与 Markdown 报表；
   - 收敛后 `/zcode-loop:loop-stop` 收尾。

$ARGUMENTS
