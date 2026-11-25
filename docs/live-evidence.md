# T7 live 冒烟证据（真机 · 2026-11-26）

来源：`packages/dsh-tui-codebuddy/scripts/live-smoke.mjs`（经 backend handler 导出面驱动**真实 codebuddy CLI**，无假桩；脚本不进测试套件，单独可跑）。机器自动生成的完整证据（每步事件序列 / 直方图）由脚本写入临时目录，本文只入档结论、关键数字与偏离。**本文不含任何凭据 / token / 完整账号值；会话 id 只写前 8 位。**

## 环境

| 项 | 值 |
| --- | --- |
| 平台 | Windows（win32 x64） |
| Node | v24.14.0 |
| codebuddy CLI（detect，PATH 全局） | **2.186.0**（installed:true） |
| codebuddy CLI（SDK 捆绑，会话实际运行） | **2.187.0**（`@tencent-ai/agent-sdk@0.3.307` 捆绑，verify-contract 钉住；init frame 未携带 `codebuddy_code_version` 字段——见偏离 4） |
| 会话模型 | `hy4flash-free`（init frame 报告值；assistant 帧报告 `hy4-flash-free`，CLI 自身两种拼写并存） |
| 账号形态 | **已登录**（live 会话真实完成对话 / 审批 / 中断 / 恢复） |
| 会话 id | `07eeaf99…`（CLI 采纳 SDK 传入的 `--session-id`，ref 与 init 一致） |

## live 各步结果（42/42 PASS）

| 步 | 验收点 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| a | detect 真实版本 | PASS | installed:true, version 2.186.0 |
| b | 真实会话 + 流式对话 | PASS | 真实流式增量 ×14（turn 1），`assistant.message` canonical 行，`turn.end#1` reason=completed；回复 " ok" |
| c1 | 工具审批——允许一次 | PASS | `permission.request`（Write，面板三选项齐备）→ respond allow-once → `permission.settled(allow-once)` → 真实 `tool.call` + `tool.result`（非 error）→ 文件真实落盘且内容 ok |
| c2 | 工具审批——拒绝一次 | PASS | respond reject → `permission.settled(rejected)` → 回合仍收口 completed；拒绝以 `tool.result{isError:true}` 回给模型（1 条）；被拒文件未落盘 |
| d | 回合中途 cancel + 队列校正 | PASS | 收据 `{outcome:"unknown", stillQueued:["smoke-t5"]}`（T4 诚实语义）；`turn.end#4` 在窗口内到达；steer 接管为 turn 5 并 completed；pending 队列校正为空 |
| e | dispose + `--resume` 续接 | PASS | `session.status disposed`；resume 打开同一会话 id；种子 84 事件：user 行 ×5、seq 1..K 连续、turn.start 1..5 连续、工具卡在场、被中断回合历史如实重放；live 编号连续（turn 6 = 种子最大回合 + 1）并 completed |

代表性事件序列（turn 2，允许路径）：
`user.message → turn.start#2 → step.start → attempt.start → assistant.delta×28 → tool.call → permission.request → permission.settled(allow-once) → tool.result → assistant.message → turn.end#2`

## 用量数字（全部最小提示词，共 6 次提交）

| 回合 | 内容 | input | output |
| --- | --- | --- | --- |
| s1 t1 | 「只回复一个词：ok」 | 28,712 | 31 |
| s1 t2 | 写文件（允许） | 57,726 | 117 |
| s1 t3 | 写文件（拒绝） | 58,183 | 285 |
| s1 t4 | 数数→中断 | 0 | 0（中断回合 CLI 零计量，creditStatus=unknown） |
| s1 t5 | steer 续答 | 29,395 | 15 |
| s2 t6 | resume 后对话 | 29,433 | 27 |
| **合计** | | **203,449** | **475** |

- credits：**0**（免费档模型，creditStatus=known；仅经 `codebuddy.turn-usage` custom 事件暴露——T6 纪律）
- 流式增量总数 145；事件总数 278；中断回合被 CLI 以零用量收口
- token 只经 `assistant.message.usage` 记账、turn 层为差分值（无重复累加）；cache 读数字见事件原档

## 失败项与真机偏离（如实记录）

1. **system/init 懒发**（发现于 run 1）：init 帧不随 connect() 握手到达，而是在**首个 stdin 输入之后**才出现（实测晚 ~150ms）。live-smoke 据此先 submit 再等 ready。
2. **流式中断 result 无 terminal_reason**：bundled 2.187.0 的流式取消路径返回的 result 不携带 `terminal_reason`（CLI 源码中 `'interrupt'` 值不存在；abort 路径产出的是 `aborted_streaming`/`aborted_tools`）。真机中断的可见信号 = CLI 合成的 **"Interrupted by user"** 助手消息 + `turn.end{completed}`。翻译器的 `interrupted` 判定在真机流式路径上不会命中（中断收口本身不受影响——回合准时结束、会话继续）。
3. **`--resume` 回放无逐回合 result 帧**：回放流 = 完整消息历史（user/assistant/tool 帧，含被中断回合）+ **仅最后一个回合的 result 帧**（reason=completed 来自真实帧）。历史回合在种子中悬垂（turn.end 缺席），`settleReplay()` 只在仍有悬垂回合时合成收口——T5 的 fake-CLI 模型（每回合带 result）与真机不同。编号连续性不受影响（f5/f6/f9 全过）。
4. **init frame 无 `codebuddy_code_version` 字段**：bundled CLI 版本证据只能来自 verify-contract 的捆绑包断言（2.187.0），init 帧只报 model/permissionMode。
5. 脚本修正过程如实记录：run 1 因偏离 1 导致 b1/f2 FAIL；run 2 因偏离 3 导致 f6/f8 FAIL；run 3（最终）42/42 全绿。

## 与交互 TUI 手工清单的关系

交互式 dsh-TUI 无法无头驱动。headless 代理证据 = `verify-assembly.mjs` 的 `offered:true`（picker 可见性）+ 本文的真实会话证据（对话 / 审批 / 中断 / 恢复四件事全部真机跑通）；「重启 dsh-TUI → picker 选 CodeBuddy → 真人对话」的最后一环留给 [live-checklist.md](live-checklist.md) 人工执行。
