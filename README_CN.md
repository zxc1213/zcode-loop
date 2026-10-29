# zcode-loop

[English](./README.md)

给 ZCode 的 coding agent 一个**可审计的实验循环**：定一个目标和一个机械度量，agent 每次只改一处，跑基准，数字变好就保留、变差就回滚，并把每一次尝试写进账本。

适合这类活：把构建时间压下去、把 p95 延迟调下来、把包体减下去、把测试跑快、把某个评分刷上去——凡是"能稳定量出一个数"的优化。

## 它解决什么

让模型"自己优化"通常失败在三个地方：度量会漂、改动会混、结论会忘。

- **度量会漂**：`.zloop/bench.sh` 在轮次内被 hook 冻结，跑基准只认这个脚本，改动脚本会被检测为 `benchmark_drift`。
- **改动会混**：一次试验一次提交（`loop: <说明>`），不保留就把工作树回滚干净，`keep`/`revert` 都有 git 事实兜底。
- **结论会忘**：`.zloop/ledger.jsonl` 是 append-only 账本，每次尝试的假设、预期、观察、置信度都在里面；新会话由钩子把摘要注入回来。

## 安装

市场仓库：<https://github.com/zxc1213/zcode-loop>

**命令行**

```bash
zcode plugins marketplace add zxc1213/zcode-loop
zcode plugins install zcode-loop@zcode-loop
```

**图形界面**：设置 → 插件市场 → 添加 → 粘贴 `zxc1213/zcode-loop` → 个人 → zcode-loop → 安装。

安装后新开一个会话（或重启 ZCode），MCP 工具才会加载。

## 快速开始

```
/zcode-loop:loop 把首页首屏加载时间压到 1.5s 以内
```

或者手动：

1. 写 `.zloop/bench.sh`，输出 `METRIC 名字=数值`：

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   start=$(date +%s%3N)
   npm run build >/dev/null
   echo "METRIC build_seconds=$(( ($(date +%s%3N) - start) / 1000 ))"
   echo "METRIC bundle_kb=$(du -k dist/app.js | cut -f1)"
   ```

2. 需要正确性门禁就写 `.zloop/gate.sh`（退出码 0 = 通过，通常是 `npm test`）。
3. `git init` + 提交干净基线，然后 `loop_open`。
4. 循环：一次只改一处 → `loop_run` → `loop_commit`。

## 工具（MCP）

| 工具 | 作用 |
|---|---|
| `loop_open` | 开一轮实验：目标、主度量、方向（越小/越大越好）、预算（试验数/分钟/连续失败）、次级度量约束。`resume: true` 只看不开新轮。 |
| `loop_run` | 跑基准：计时、解析 `METRIC name=value`、可 `repeat` 取中位数、跑 `.zloop/gate.sh`、报告基准漂移。有 `bench.sh` 时只允许跑它。 |
| `loop_commit` | 记录结论：`baseline` / `keep`（自动 git commit）/ `revert`（回滚）/ `drop`（放弃，如门禁失败）/ `error`（基准崩溃）/ `noop`。账本会拒绝不可能的组合。 |
| `loop_state` | 当前轮快照：baseline、best、改善、预算消耗、置信度、平台期/重复检测、最近试验、git log。 |
| `loop_report` | 写 `loop-report.html`（自包含、带轨迹图）与 `loop-report.md`（可直接贴进周报）。 |
| `loop_close` | 收尾：把结论写进 brief 与账本。 |

## 决策语义

| 情况 | 决策 | git 效果 |
|---|---|---|
| 本轮第一次测量 | `baseline` | 无 |
| 优于当前 best | `keep` | 提交 `loop: <说明>` |
| 持平或更差 | `revert` | 回滚工作树 |
| 门禁失败 / 放弃该方向 | `drop` | 回滚 |
| 基准崩溃、超时、没解析出数 | `error` | 回滚 |
| 只是测量、没有改动 | `noop` | 无 |

账本会拒绝：`keep` 但没有变好、`revert` 却变好了、`baseline` 出现在非首次、`error` 带度量、外部传入 commit、门禁失败还想 `keep`、次级约束超限还想 `keep`。

## 护栏

- **冻结基准**：PreToolUse 钩子拒绝写 `.zloop/bench.sh` / `gate.sh` / `ledger.jsonl`。
- **只跑基准**：存在 `bench.sh` 时 `loop_run` 只接受它的几种调用写法，杜绝"顺便跑个别的东西"。
- **漂移检测**：开轮时记录 benchmark/gate 的哈希，跑的时候比对，变了就警告"数字不可比"。
- **正确性背压**：`gate.sh` 失败禁 `keep`。
- **次级约束**：`loop_open` 时声明 `{metric, maxPct}`，`keep` 时自动校验，防"用内存换速度"。
- **止损**：试验数、时长、连续失败三个预算，Stop 钩子到点不再续跑。
- **信号**：置信度（信号/噪声比）、平台期（最近 5 轮改善 < 1%）、重复/震荡检测（A→B→A→B）。
- **可暂停**：`.zloop/config.json` 设 `autoContinue: false` 停止自动续跑，不必删状态。

## 状态文件

```text
<work-dir>/
  .zloop/
    ledger.jsonl     # append-only：open / trial / close 行
    brief.md         # 章程：目标、度量、约束、已尝试
    bench.sh         # 冻结的基准
    gate.sh          # 可选：正确性门禁
    last-run.json    # 待记录的那次测量
  loop-report.html   # 报表（自包含）
  loop-report.md     # 报表（Markdown）
```

`.zloop/config.json` 放在**项目目录**，可覆盖：

```json
{
  "maxTrials": 20,
  "maxMinutes": 120,
  "maxFailures": 3,
  "autoContinue": false,
  "workDir": "work/"
}
```

`workDir` 让研究目录与项目目录分离：账本、基准、git 操作、报表都发生在那里，配置文件留在项目目录。

## 命令与技能

- `/zcode-loop:loop <目标>` — 进入或恢复循环
- `/zcode-loop:loop-status` — 查看进度
- `/zcode-loop:loop-report` — 生成报表
- `/zcode-loop:loop-stop [总结]` — 收尾
- 技能 `zcode-loop` — 循环协议与搭建指南（`skills/zcode-loop/references/`）

## 与 autoresearch 的关系

设计参考了 karpathy 的 autoresearch 思路与 ZCode 官方的 `autoresearch` 插件（两者都值得一看）。本插件是独立实现，取舍不同：

- **零依赖、零构建**：纯 ESM `.mjs`，Node ≥ 18 直接跑，不需要 TypeScript 剥离或打包。
- **决策模型更严**：`baseline` 是显式决策，`keep` 必须是真改进，`revert` 必须是真退化，门禁失败只能 `drop`。
- **约束前置**：次级度量约束在 `loop_open` 声明，而不是每次提交临时传。
- **报表两种形态**：HTML 看轨迹，Markdown 直接进周报。

## 开发

```bash
npm test          # 单元 + 钩子 + MCP 端到端（真实 git 仓库）
node --test test/mcp.test.mjs
```

无第三方依赖，`package.json` 里只有脚本。

## 已知边界

- 需要 `bash`（Git Bash 即可）与 `git`。
- `keep` 用 `git add -A`，会把工作树里所有未提交改动一并提交；开轮前先提交干净基线。
- 无人值守跨 turn 续跑依赖宿主能力，本插件只做同会话内的 Stop 续跑。
- 无头模式（`--prompt`）不执行 hooks，护栏只在交互式会话生效。

## License

MIT
