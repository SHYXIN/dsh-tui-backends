# dsh-tui-codebuddy

Third-party **CodeBuddy backend bundle** for [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) — 让 CodeBuddy 成为 dsh-TUI 内核选择器里的一个后端。

完全按 dsh-TUI 的第三方 bundle 公开面开发（`tui.dsh/v1alpha1#Backend` 贡献族）：不动上游仓库，`装 → 重启 → 出现在内核选择器`。

## 状态

**脚手架阶段**（2026-11-25）。声明结构、检测入口已就位；会话实现（MVP）未开始。

- [docs/research-notes.md](docs/research-notes.md) — 可行性调研事实与来源
- [docs/decisions.md](docs/decisions.md) — 设计共识、MVP 范围、验收标准与下一步

## 结构

```
backend.js        入口：backend handler（detect / open），宿主按需 import
dsh-plugin.json   包根声明：contributes['x-dsh-tui'] 的 Backend 条目
cordis.patch.yml  空 patch——存在意义是让本包成为 profile 层（dsh.profile.bundles）
```

## 继续开发（新机器）

```sh
git clone <本仓库>
cd dsh-tui-codebuddy
pnpm install
node backend.js   # 无副作用入口；detect() 可独立跑通验证 CLI 探测
```

对照夹具与验证脚本：dsh-TUI 仓库 `scripts/fixtures/third-party-backend/`（可照抄的公开面实例）与 `scripts/verify-backend-assembly.ts`（把 bundle 装进一次性 profile 跑完整装配链）。

dsh-TUI 基线 commit：`b110b240`（main，2026-11-25 克隆）。

## License

MIT
