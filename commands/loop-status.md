---
description: 查看当前实验循环的状态。用法：/zcode-loop:loop-status
---

报告当前循环状态。

1. 调 `loop_state`。
2. 用 4–6 行中文回答：第几轮、目标、主度量与方向、baseline → best（改善百分比）、已用试验/预算、置信度与是否平台期/重复。
3. 列出最近 3 次试验（编号、结论、度量、一句话说明）。
4. 给出下一步建议（来自 `state.next`）。
5. 没有会话时直接说明，并建议 `/zcode-loop:loop <目标>`。
