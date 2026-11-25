# 调研笔记：CodeBuddy 接入 dsh-TUI 的可行性（2026-11-25）

## 结论

**可行，且是「Claude 形态」后端** —— CodeBuddy 的 Agent SDK 与 dsh-TUI Claude 后端使用的 `@anthropic-ai/claude-agent-sdk` 几乎同构，`src/backends/claude/`（40 个文件）是现成施工蓝图。

## 接入面事实（本机 codebuddy CLI v2.186.0 + 官方文档验证）

| 接入面 | 现状 | 来源 |
| --- | --- | --- |
| 官方 TS SDK `@tencent-ai/agent-sdk` | npm v0.3.307（2026-11-25 更新，活跃），Node >= 18.20 | npm registry + https://www.codebuddy.ai/docs/cli/sdk |
| `canUseTool` 审批回调 | ✅ 有（`CanUseTool` 类型含 `signal`、`suggestions`） | https://www.codebuddy.ai/docs/cli/sdk-typescript |
| `setPermissionMode()` / `interrupt()` / `mcpServerStatus()` | ✅ 有 | 同上 |
| streaming-input `query()`（多轮流式输入，`AsyncIterable<UserMessage>`） | ✅ 有 | 同上 |
| 会话管理 API | ⚠️ 在 **Unstable V2 API** 段（Session 接口、sessionId、SessionOptions），需钉版本谨慎使用 | 同上 |
| headless 模式 | `codebuddy -p --output-format stream-json --input-format stream-json`（stdin JSONL 多轮），可作 SDK 失效时的降级传输 | https://www.codebuddy.ai/docs/cli/headless |
| ACP 模式 | `--acp` stdio ndJsonStream / `--acp-transport streamable-http`；`--serve` HTTP（Web UI + REST + ACP SSE）。第一版不用 | CLI `--help` |
| 权限语义 | `-y` 非交互必需；HIGH/CRITICAL 仍可能确认；`CODEBUDDY_IS_SANDBOX=1` 仅限隔离沙箱 | headless 文档 |
| CLI `--permission-prompt-tool` | ❌ 明确不支持——走 SDK 的 `canUseTool` 绕开 | CLI reference |
| 计费语义 | credits 不写入 `total_cost_usd`；`usage_update` 事件按回合上报，勿与 `result.usage`（会话累计）重复累加 | headless 文档 |
| Python SDK | pip 包名 `codebuddy-agent-sdk`（npm 上 404），本后端不需要 | https://www.codebuddy.ai/docs/cli/sdk-python |

## SDK 消息词汇（与 claude-agent-sdk 对齐的证据）

`message.type` 分支：`assistant`（`message.message.content[]`，`block.type === 'text'`）、`result`（`subtype: 'success' | 'interrupted' | 'hook_blocked'`，含 `duration_ms`、`total_cost_usd`）。`HOOK_EVENTS` 含 `SessionStart / SessionEnd / PermissionRequest`。`PermissionMode` 枚举与 Claude 同族（`bypassPermissions`、`plan`、`acceptEdits`…）。

## dsh-TUI 侧的关键约束（docs/agent-backend-design.md @ b110b240）

- 一个进程一个后端，启动时定死；`/kernel` 切换 = 记忆选择 + 重启进程。
- 后端是**孤岛**：只 import 自己目录、`src/agent/`、`src/backends/shared/`、node 内建、manifest 声明的厂商包；宿主内部（字典/utils/channel/dsh-adapter）连 `import type` 都不行。
- 新增后端 = 声明（manifest）+ `AgentBackend`（detect/open/可选会话目录）+ `AgentSession`（history/subscribe/submit/cancel/dispose）+ 翻译器（消息 → `AgentEvent`，live 与回放同一映射）+ 按真实支持声明 `SessionCapabilities`（缺席即界面显示「不支持」）。
- 工具卡走 `presentation` 中立描述，不按工具名分支。
- 文案是后端自己的（`host.locale()` 选 zh/en，双份齐全、`{{name}}` 占位、`count` 复数，`verify-i18n` 同规则查）。
- 第三方 bundle 装链路：包根 `dsh-plugin.json`（`contributes['x-dsh-tui']` 放 `kind: 'Backend'` 条目）+ `package.json` 声明 `dsh.bundle` + 包入口**默认导出名必须是 `backend`**；每包只声明一个后端；保留 id 只有 `dsh`/`claude`/`codex`，`codebuddy` 可用。
- 可照抄实例：`scripts/fixtures/third-party-backend/`；装配链验证：`scripts/verify-backend-assembly.ts`（装进一次性 profile 跑完整链路）。

## 上游 Issue 扫描（2026-11-25，gh 认证态）

`codebuddy` / `code buddy` / `tencent` / `腾讯` 全部 **0 命中**；gemini/qwen/kimi/glm 命中均为 Bug 正文顺带提及。最接近的提议是 #371（`-m/--model` 参数）。**我们是第一个提 CodeBuddy 支持的。**

## 主要风险

1. SDK 处于 Preview/Unstable（文档自标注），版本日更（0.3.307）——必须像 Claude 后端那样在 contract 钉死 `VALIDATED_SDK_VERSION`，配 verify 脚本。
2. 会话目录 API 在 Unstable V2 段，`/resume` 的目录列举要降级设计（优先 `--resume <id>` 直接续接）。
3. credits 与 `total_cost_usd` 语义分离，用量展示需单独适配。
4. dsh-TUI 上游契约演进快（仓库近期大量 backend 重构 PR），bundle 要声明兼容基线（当前 pin b110b240 的公开面）。
