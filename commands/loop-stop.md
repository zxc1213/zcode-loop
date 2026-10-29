---
description: 结束当前实验循环并写总结。用法：/zcode-loop:loop-stop [总结]
---

收尾当前轮次。

1. 如果还有未提交的实验改动，先判断：真实改进 → `loop_commit` keep；否则 `loop_commit` revert。
2. 调 `loop_report` 生成报表。
3. 调 `loop_close`，`summary` 用 $ARGUMENTS（为空则用你总结的：主要结论、最佳改动、无效方向及理由、后续建议）。
4. 用 3–5 行向用户汇报：最终 baseline → best、改善、保留的提交、下一步建议。
5. 提醒：保留的提交仍在当前分支；若要保留现场但停止自动续跑，可在 `.zloop/config.json` 设 `autoContinue: false`，而不必删除 `.zloop/`。

$ARGUMENTS
