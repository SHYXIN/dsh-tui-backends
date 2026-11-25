# CodeBuddy 后端 · 交互 TUI 人工验收清单

> 交互式 dsh-TUI 无法无头驱动（脚本打不进真实终端 UI），所以最后一环必须由真人完成。
> **headless 代理证据已齐**：`verify-assembly.mjs` 的 `offered:true`（bundle 已被装配链 admit 并 offered 给 picker）+ [live-evidence.md](live-evidence.md)（真实 CLI 会话的对话 / 审批 / 中断 / 恢复四件事 42/42 全绿）。
> 本清单只补「重启 dsh-TUI → 内核选择器选 CodeBuddy → 真人对话」这一段。全部通过后，issue #8 的第一条验收框即可勾掉。

## 前置（一次性）

1. bundle 已装进本机 profile：`~/.dsh-tui/` 下 profile 的 `package.json` 含 `"dsh-tui-codebuddy"`（`dsh.profile.bundles`），且能解析到本仓库的包（junction/依赖均可）。
2. 终端里 `codebuddy --version` 可用（detect 依据 PATH；当前机器 2.186.0），且 CLI 已登录（账号形态只记录「已登录/未登录」，不要把凭据写进任何文档）。

## 步骤

| # | 操作 | 预期现象 |
| --- | --- | --- |
| 1 | **重启 dsh-TUI** | 无报错启动（bundle 是懒加载的，不选就不 import） |
| 2 | 打开内核选择器 | 列表出现 **CodeBuddy** 行（label 与 shortLabel 来自声明；未装 CLI 时应显示安装提示而不是死按钮） |
| 3 | 选中 CodeBuddy，新建会话 | 进入与其他后端一致的聊天界面；状态栏出现模型/状态信息 |
| 4 | 输入「只回复一个词：ok」 | 回复**流式逐段上屏**（不等整回合），思考内容按正文/计数显示 |
| 5 | 输入「在当前目录创建文件 allow-ok.txt，内容为 ok」 | **审批面板**弹出（允许一次 / 始终允许 / 拒绝，附理由输入）；选「允许一次」→ 工具卡显示执行 → 文件真实生成 |
| 6 | 再来一条写文件任务，这次选「拒绝」（可附理由） | 面板收口，回合正常结束，模型报告被拒；文件不生成 |
| 7 | 发一个长输出任务（如「从 1 数到 60」），中途按 **Esc** | 回合立即收口（CLI 会合成一条 "Interrupted by user"），界面回到可输入状态；**接着输入的新消息立即开新回合**（now 语义） |
| 8 | 退出 dsh-TUI，再次重启，用 resume 恢复上一个 CodeBuddy 会话 | 历史先回放（种子）再接 live，**编号连续不重号**；继续对话正常 |
| 9 | `/model` 切换一次模型 | `model.changed` 反映到状态栏；选择持久化，下一次开会话沿用（T6） |

## 记录

- 每步实际现象与不符项写进 issue #8 的评论（不要贴凭据/账号值）。
- 全部通过 → 勾掉 issue #8 验收框第 1 条；发现不符 → 按正常 issue 流程开新票。
- 脚本化回归：`node packages/dsh-tui-codebuddy/scripts/live-smoke.mjs`（消耗真实用量，单独可跑，不进测试套件）。
