# dsh-tui-backends

第三方 **dsh-TUI 后端 bundle 合集** —— 让更多 Agent CLI 成为 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 内核选择器里的一个后端。

完全按 dsh-TUI 的第三方 bundle 公开面开发（`tui.dsh/v1alpha1#Backend` 贡献族）：不动上游仓库，`装 → 重启 → 出现在内核选择器`。

## 包一览

| 包 | 状态 | 说明 |
| --- | --- | --- |
| [`packages/dsh-tui-codebuddy`](packages/dsh-tui-codebuddy) | 🚧 脚手架（2026-11-25） | CodeBuddy 后端：声明 + detect 已就位，会话实现（MVP）未开始 |

> dsh-TUI 约束：**一个 bundle 包只能声明一个后端**，所以每个后端是 `packages/` 下独立的 npm 包；仓库层面用 pnpm workspace 收拢。

## 文档

- [docs/research-notes.md](docs/research-notes.md) — CodeBuddy 接入可行性调研（事实与来源）
- [docs/decisions.md](docs/decisions.md) — 设计共识、MVP 范围、验收标准与下一步

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
