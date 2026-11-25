# dsh-tui-backends

第三方 **dsh-TUI 后端 bundle 合集** —— 让更多 Agent CLI 成为 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 内核选择器里的一个后端。

完全按 dsh-TUI 的第三方 bundle 公开面开发（`tui.dsh/v1alpha1#Backend` 贡献族）：不动上游仓库，`装 → 重启 → 出现在内核选择器`。

## 包一览

| 包 | 状态 | 说明 |
| --- | --- | --- |
| [`packages/dsh-tui-codebuddy`](packages/dsh-tui-codebuddy) | ✅ MVP 达成（2026-11-26） | CodeBuddy 后端：对话 / 审批 / 中断 / 恢复真机跑通（live 冒烟 42/42），遗留项见 docs/decisions.md |

## MVP 状态（2026-11-26）

CodeBuddy 后端 MVP 四件事（对话 / 审批 / 中断 / 恢复）已在真机（真实 CLI + 已登录账号）跑通：

- `pnpm test` 90/90 · 装配链 16/16（picker `offered:true`）· 契约门 25/25
- live 冒烟 42/42：提示词全部最小化，事件证据与用量数字见 [docs/live-evidence.md](docs/live-evidence.md)
- 交互 TUI 的最后一环（重启 → picker → 真人对话）走人工清单：[docs/live-checklist.md](docs/live-checklist.md)
- 已知偏离与遗留项集中在 [docs/decisions.md](docs/decisions.md) 的「遗留项」节

> dsh-TUI 约束：**一个 bundle 包只能声明一个后端**，所以每个后端是 `packages/` 下独立的 npm 包；仓库层面用 pnpm workspace 收拢。

## 文档

- [docs/research-notes.md](docs/research-notes.md) — CodeBuddy 接入可行性调研（事实与来源）
- [docs/decisions.md](docs/decisions.md) — 设计共识、MVP 范围、验收标准、下一步与遗留项
- [docs/live-evidence.md](docs/live-evidence.md) — T7 真机 live 冒烟证据（平台 / CLI 版本 / 事件证据 / 用量 / 偏离）
- [docs/live-checklist.md](docs/live-checklist.md) — 交互 TUI 人工验收清单（重启 → picker → 真人对话）

## 结构

```
pnpm-workspace.yaml                pnpm workspace（packages/*）
packages/dsh-tui-codebuddy/
  backend.js        入口：backend handler（detect / open），宿主按需 import
  dsh-plugin.json   包根声明：contributes['x-dsh-tui'] 的 Backend 条目
  cordis.patch.yml  空 patch——存在意义是让本包成为 profile 层（dsh.profile.bundles）
```

## 继续开发（新机器）

```sh
git clone https://github.com/SHYXIN/dsh-tui-backends
cd dsh-tui-backends
pnpm install
node packages/dsh-tui-codebuddy/backend.js   # 无副作用入口；detect() 可独立跑通验证 CLI 探测
```

对照夹具与验证脚本：dsh-TUI 仓库 `scripts/fixtures/third-party-backend/`（可照抄的公开面实例）与 `scripts/verify-backend-assembly.ts`（把 bundle 装进一次性 profile 跑完整装配链）。

dsh-TUI 基线 commit：`b110b240`（main，2026-11-25 克隆）。

## License

MIT
