# 设计共识与 MVP 范围（grill 收口，2026-11-25）

## 共识决策表

| 决策点 | 结论 |
| --- | --- |
| 目标 | 给 dsh-TUI 增加 CodeBuddy 后端支持（上游无人提过） |
| 可行性 | ✅ Claude 形态；调研见 research-notes.md |
| 交付形态 | **第三方 bundle**：独立 npm 包，不动上游仓库 |
| MVP 范围 | 核心闭环五件事（见下） |
| 达成标准 | 本地装进 profile → 重启 → 内核选择器出现 CodeBuddy → 能实际对话；**npm 发版不做** ✅（2026-11-26 达成，见 live-evidence.md） |

## MVP 核心闭环（五件事）

1. 开会话 / 多轮对话：streaming-input `query()`，一个会话一个长寿命 query
2. 事件翻译：SDK 消息 → `AgentEvent`（助手流、工具卡、思考、用量），live 与回放同一映射
3. `canUseTool` → 审批面板
4. `--resume <id>` 恢复会话
5. `interrupt()` 取消回合

## 能力声明（第一版）

只声明 `permissions` + `models` + `images`。子代理 / tasks / fork / rewind / effort / compact 一律**不声明**——界面自动显示「当前后端不支持」，不会坏；后续每加一项 = 多声明一个 capability + 多翻译几类事件。

## 传输决策

主路径：`@tencent-ai/agent-sdk`（版本钉 0.3.307）。降级路径：headless `stream-json` 直接驱动 CLI。ACP / `--serve` 不用。

## 下一步（按序）

1. [x] 精读 `src/agent/` 公开面（events.ts / session.ts / capabilities.ts / backend.ts）与 Claude 后端 session/translate 实现
2. [x] 实现 `AgentBackend.open`：SDK `query()` 组装（options 钉权限模式、settingSources 策略）
3. [x] 实现 `AgentSession`：subscribe/submit/cancel/dispose + canUseTool → 审批事件
4. [x] 翻译器 + 双语文案 text.ts
5. [x] `scripts/verify-backend-assembly.ts` 跑通装链路（一次性 profile）
6. [x] 真机验证：装进本机 profile → 重启 dsh-TUI → picker 出现 CodeBuddy → 真实对话
7. [ ] （可选）向上游提 issue/PR 前先跑通以上全部——前置已全部跑通，本项未做

## 环境基线

- dsh-TUI clone：`b110b240`（main）
- codebuddy CLI：v2.186.0（`codebuddy.ps1` 经 nvm4w 全局）；SDK 捆绑 CLI v2.187.0（会话实际运行，见 contract.js）
- Node v24.14.0 / pnpm 11.21.0
- gh 认证：keyring（SHYXIN）

## 遗留项（MVP 收尾后仍开放的事，2026-11-26）

### 未声明能力（界面诚实显示「当前后端不支持」）

子代理 / tasks / fork / rewind / effort / compact 等一律未声明——每加一项 = 多声明一个 capability + 多翻译几类事件。`usage_update` 之外的 `status` / `task_*` / `file-history-snapshot` 等帧仍被翻译器有意忽略（不会坏，只是没有界面）。

### SDK Unstable 面（钉版 0.3.307 下的既知依赖）

- **one-shot query 绕行（T2）**：`query()` 自身的异步迭代器是一次性的（首个 result 即收尾），会话直接消费 `q.transport.messages()` 维持长寿命读循环——session.js 头注明确标注的唯一 reach-through。
- **模型切换 transport 直通（T6）**：`q.setModel()` 只在 SDK 自己的读迭代器里生效（`_sessionId` 由它捕获，本会话刻意绕开），所以 set_model 走 `q.transport.sendControlRequest` 直发；ack 是送达证据，CLI 是否接受不可观测。
- **credits custom 逃生口（T6）**：credits 没有宿主原生槽位，经 `codebuddy.turn-usage` custom 事件暴露；token 只经 `assistant.message.usage` 记账，两套数字不重复累加（translator.js anti-double-add）。
- **僵尸 CLI 防御（T4）**：interrupt 无回合级回执——15s force-settle 兜底 + dead transport 守卫（SDK sendControlRequest 的 auto-start 脚枪不会复活死 CLI）；cancel 语义诚实（running=unknown / idle=confirmed / dead=failed）。

### known limitations（含 T7 真机 live 发现，证据见 live-evidence.md）

- **回放 settle 策略（T5 + T7 live）**：真机 `--resume` 回放不含逐回合 result 帧——历史回合在种子中悬垂，只有最后一个回合带真实 result；`settleReplay()` 仅在仍有悬垂回合时合成收口（T5 的 fake-CLI 模型与真机不同）。编号连续性不受影响；种子 turn.end 不完整是既知形态，后续按真机证据校准。
- **流式中断无 terminal_reason（T7 live，已按真机校准）**：bundled 2.187.0 流式取消路径的 result 不携带 `terminal_reason`（CLI 源码无 `'interrupt'` 值；abort 路径是 `aborted_streaming`/`aborted_tools`），真机中断信号 = CLI 合成的 "Interrupted by user" 助手消息。code-review 修复（2026-11-26）：翻译器判定改为三线——`terminal_reason:'interrupt'`（主）∪ 精确匹配的真机合成文本标记（次级证据，逐回合、整串精确匹配防误伤）∪ 既有 force-settle 兜底；黑盒测试钉住「含该词的正常正文不误判」与「标记不跨回合泄漏」。
- **init 懒发（T7 live）**：`system/init` 随首个 stdin 输入之后到达（不在握手时），依赖 init 时序的逻辑要按此顺序设计。
- **init frame 无版本字段（T7 live）**：`codebuddy_code_version` 在 2.187.0 的 init 帧缺席，bundled CLI 版本证据只能来自 verify-contract 的捆绑包断言。
- **双 CLI 版本并存**：detect 报 PATH 全局 CLI（2.186.0），会话实际跑 SDK 捆绑 CLI（2.187.0）——两个版本号会同时出现在证据里，属预期形态。
- **交互 TUI 人工清单未跑**：headless 代理证据已齐（verify-assembly `offered:true` + live 会话证据 42/42），最后一环（重启 → picker → 真人对话）见 docs/live-checklist.md。

## Spec

MVP 规格已发布到 issue tracker 并打上 `ready-for-agent`：[#1 Spec: CodeBuddy 后端 bundle MVP](https://github.com/SHYXIN/dsh-tui-backends/issues/1)。测试缝（已确认）：backend handler 导出面黑盒 + 假 CLI 桩（`CODEBUDDY_CODE_PATH` 注入）+ 上游装配链复用 + live 手工冒烟。
