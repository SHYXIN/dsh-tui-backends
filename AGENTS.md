# AGENTS.md

dsh-tui-backends：第三方 dsh-TUI 后端 bundle 合集（一个 bundle 包一个后端）。
项目约定与路线图见 [README.md](README.md) 与 [docs/decisions.md](docs/decisions.md)。

## Agent skills

### Issue tracker

Issues 在 GitHub Issues，统一用 `gh` CLI 操作（仓库 `SHYXIN/dsh-tui-backends`）。See `docs/agents/issue-tracker.md`.

### Triage labels

五个标准角色标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`），标签字符串与角色同名。See `docs/agents/triage-labels.md`.

### Domain docs

single-context：根 `GLOSSARY.md` + `docs/adr/`，术语与 ADR 由 `/domain-modeling` 惰性创建，缺失时不阻塞探索。See `docs/agents/domain.md`.
