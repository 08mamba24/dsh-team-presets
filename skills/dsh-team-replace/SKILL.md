---
name: dsh-team-replace
description: Replace an idle implementer or reviewer and recover the same handoff operation.
---

用户明确要求给已有 implementer 或 reviewer 换模型、effort、提示词或工具时，使用 `dsh_team_replace`。

1. 调用 `action: inspect`，读取当前成员的精确 ID、进行中的替换操作和原任务。若已有未完成操作，使用其 `operationId` 调用 `action: recover`；不要再创建候选。
2. 将用户指定的 provider、model、reasoningEffort、personaPrompt、prompt、完整 tools 清单及实况 progressFacts 传入 `action: replace`，同时填入 inspect 返回的 `expectedOldChildId` 和逻辑 role。effort 未指定时默认 max；不自动换模型或降档。工具名从 `dsh_team_configure action: tools` 获取，模型与授权从原生目录核对。
3. progressFacts 应包括已有文件、已运行的测试、未确认的后台副作用和下一步。运行中、排队中、后台作业或无法确认静止的成员会被拒绝；不要通过清空队列、杀进程或重建团队来绕过。
4. 候选先受强制 Standby 限制，只读取交接任务并向 Lead 发送绑定 operation/handoff 的就绪 ACK。就绪后由 Lead 逐任务 CAS 改派，全部确认才激活。已完成任务和原 Session 历史保留。
5. `active` 表示候选获得工作资格；就绪 ACK 不证明已经接管任务。只有返回经原生运行记录核验的任务写回证据，才报告实际接管。没有未完成任务时明确说明没有需要证明的任务写回。
6. 超时、取消、部分移交或落盘不确定时，报告原 operationId 并 inspect/recover 同一操作。候选尚未创建或尚未改派任务时，可对同一 operationId 明确调用 `action: cancel`；只有候选已停止、任务 owner 仍安全时才解冻旧成员。首次 owner 写入之后不允许 cancel，不复活旧成员，不重复 spawn，不删除任务、依赖或进度。工具仍经过原生沙箱和审批；已有工具体和任意自行脱离管理的后台进程不能通过替换撤销。

这次替换只作用于当前根团队，不改 profile 默认模板。用户要求修改以后新团队的默认配置时，使用 `dsh-team-configure`。

旧版本已存在的团队若返回 `REPLACEMENT_ORIGINAL_TEMPLATE_REQUIRED`，必须找到原先实际使用的完整模板，再调用 `action: adopt, template: 原模板`。系统会用本根原生启动回执的指纹、成员身份和 Session header 验证后才保存绑定、注册 Preset；不能用后来改过的 defaults 代替，也不能虚构原模板。找不到可信原配置时保留现场并报告缺口。未改变的原模板可在首次绑定时自动验证。

`REPLACEMENT_SNAPSHOT_STALE` 也可能表示冷旧成员在观察与冻结之间又完成了一次 turn。此时保留冻结，不创建候选或改派任务；先 inspect 原 operationId，核实新增事实后按取消／恢复合同处理。
