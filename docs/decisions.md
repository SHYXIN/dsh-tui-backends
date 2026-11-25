# 设计共识与 MVP 范围（grill 收口，2026-11-25）

## 共识决策表

| 决策点 | 结论 |
| --- | --- |
| 目标 | 给 dsh-TUI 增加 CodeBuddy 后端支持（上游无人提过） |
| 可行性 | ✅ Claude 形态；调研见 research-notes.md |
| 交付形态 | **第三方 bundle**：独立 npm 包，不动上游仓库 |
| MVP 范围 | 核心闭环五件事（见下） |
| 达成标准 | 本地装进 profile → 重启 → 内核选择器出现 CodeBuddy → 能实际对话；**npm 发版不做** |

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

1. [ ] 精读 `src/agent/` 公开面（events.ts / session.ts / capabilities.ts / backend.ts）与 Claude 后端 session/translate 实现
2. [ ] 实现 `AgentBackend.open`：SDK `query()` 组装（options 钉权限模式、settingSources 策略）
3. [ ] 实现 `AgentSession`：subscribe/submit/cancel/dispose + canUseTool → 审批事件
4. [ ] 翻译器 + 双语文案 text.ts
5. [ ] `scripts/verify-backend-assembly.ts` 跑通装链路（一次性 profile）
6. [ ] 真机验证：装进本机 profile → 重启 dsh-TUI → picker 出现 CodeBuddy → 真实对话
7. [ ] （可选）向上游提 issue/PR 前先跑通以上全部

## 环境基线

- dsh-TUI clone：`b110b240`（main）
- codebuddy CLI：v2.186.0（`codebuddy.ps1` 经 nvm4w 全局）
- Node v24.14.0 / pnpm 11.21.0
- gh 认证：keyring（SHYXIN）
