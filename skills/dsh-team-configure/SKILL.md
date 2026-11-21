---
name: dsh-team-configure
description: 在 DSH Agent 会话中查看可用模型和工具，配置实现和复核角色的 provider、模型、effort、提示词与工具集，预检并保存团队默认模板。不自动启动成员。
---

# 配置 DSH 团队

使用插件提供的 `dsh_team_configure` 工具完成配置，无需用户手工编辑 YAML。该 skill 在安装插件的 Harness profile 中对所有根会话可用。工具集配置需要插件 0.5.0-rc.6 或更新版本。

例如：“实现角色用 codeagent 的模型 A，允许文件读写、搜索和终端；复核角色用模型 B，只开放读取、搜索和协作；两者 max。”模型和工具先解析成工具返回的真实 ID。保留当前两角色的稳定 ID `implementer` / `reviewer`；职责通过 description 与 persona_prompt 表达。

1. 调用 `action: inspect` 读取当前模板、配置 revision、本机 provider 和当前根会话授权路由。仅当用户选择的模型 ID 不明确时，调用 `action: models` 查询相应 provider。只询问影响配置的缺失选择，不索取整份 profile、凭据或全部模型的 effort。
2. 用户要求调整工具时，调用 `action: tools` 查询当前根可见的共享／标准 Preset 工作工具及团队 Preset 协作工具。按返回的 name 精确选择；说明各角色将增加和移除哪些工具。文件、搜索、终端、skill、MCP 等名称以实际目录为准，不猜名称，不安装或启用其他插件来补齐缺口。共享工具保留原生逐步激活条件；根 Preset 中无条件注册的工作工具可供角色使用，有额外私有激活条件的根专有工具不列入。
3. 以用户要求生成 `members` 局部修改。支持 provider、model、reasoning_effort、description、persona_prompt、prompt、native_tool_allowlist；保留其他角色字段和种子任务。`native_tool_allowlist` 是该角色的完整替换列表，需要保留的协作工具也须列入；空数组明确表示不开放任何工具。未要求修改的工具和 effort 保持原值；未保存模板的新默认值包含当前 Host 可用的基础工作工具，effort 默认 max。当前执行器仍只有实现/复核两角色，不把提示词改名当成新增角色功能。
4. 使用 inspect 的 `expectedRevision` 调用 `action: preview`。工具校验所选工具仍可用，并用原生 adapter 检查明确修改的模型路由与 effort；只改工具或提示词无需模型元数据。不支持的工具/effort 或模型解析失败应报告，不能换工具、provider、模型或降档来通过。元数据通过不代表远端模型已执行。
5. 用户已明确要求修改时，使用相同 members、revision 和 preview 的 `expectedFingerprint` 调用 `action: apply`，无需重复索取同一配置授权。工具仍遵循 Harness 原生的本次操作审批；审批拒绝、取消或 revision 冲突后停止，不手工编辑文件绕过。用户只是询问方案时停在 preview。
6. 只有返回 `persisted: true` 才报告已保存。给出各角色的 provider/model/effort、实际工具清单和简要提示词变化，说明这是当前 profile 中尚未绑定团队的根会话默认值，已有成员未被修改。

工具集控制的是角色能看见和调用哪些工具，不授予更高文件或终端权限；调用仍经过原生沙箱、审批与激活条件。开放 shell 也允许执行可能写文件的命令，不能把“读取工具 + shell”称为强制只读。团队启动、成员管理、配置编辑和 PTC 传输不属于可分配的工作工具。

该 skill 随插件打包、注册和卸载。升级插件并完成重新加载后，下一次调用会读取新版 skill，无需另装全局副本。旧对话中已注入的内容不会被改写；需要新版指导时重新调用此 skill。

配置不会扩大模型授权。若 currentSessionAuthorization 有 false，需要用户在原生子智能体模型选择中授权所需路由，保存后创建新根会话。若 currentSessionNeedsNewRoot 为 true，旧根已固定模板，也应使用新根。全局选项不会追溯修改旧会话 policy。

已绑定根继续使用原模板。rc.7 启动的团队将原绑定与替换记录持久保留，重载后按该记录恢复 Preset；历史团队仍须保留原组件与 Preset。不要用重复 plan/launch 迁移旧团队，也不要删除 replacementRecords。

只配置不调用模型、不创建成员、不执行 launch。用户另外要求启动时，再按原生 plan/launch 流程处理。不要用重复 launch 更换已有成员。写入结果不确定时先报告并用 inspect 核对，不自动重试、回滚或删除配置。

若 `dsh_team_configure` 不存在，说明当前环境未安装或加载相应插件，报告这个缺口；不要把临时手改配置冒充 skill 已成功执行。

## 替换空闲成员（0.5.0-rc.7+）

用户要求修改已有 implementer/reviewer 的模型、effort、提示词或工具时，调用 `dsh-team-replace` skill 与 `dsh_team_replace` 工具：先 inspect，绑定精确 expectedOldChildId 后 replace；effort 未指定时为 max。progressFacts 写明已有文件、已验测试、未确认副作用和下一步。保留任务 ID、依赖、进度与历史。

已有未完成操作时，使用原 operationId recover；不要重复 launch 或 spawn。候选先受强制 Standby 限制，Lead 完成原生 owner/CAS 改派后才激活，再以候选真实任务写回证明接管。首次 owner 写入意图前可明确 cancel，待候选停止和 owner 安全后解冻；之后只能恢复对账。完整说明以替换 skill 为准。
