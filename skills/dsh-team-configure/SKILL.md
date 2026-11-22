---
name: dsh-team-configure
description: 在 DSH Agent 会话中查看可用模型、工具与角色模板，为 1～8 个成员增删改 provider、模型、effort、提示词与工具集，复制或自定义角色模板，预检并保存团队默认配置。不自动启动成员。
---

# 配置 DSH 团队

使用插件提供的 `dsh_team_configure` 工具完成配置，无需用户手工编辑 YAML。该 skill 在安装插件的 Harness profile 中对所有根会话可用。工具集配置需要插件 0.5.0-rc.6 或更新版本。

例如：“新建默认团队：前端用 implementer 模板、模型 A、max，只给文件与终端工具；后端同样是 implementer 模板但独立选模型和工具；复核用 reviewer 模板、模型 B、high。”模型、工具和模板先解析成工具返回的真实 ID/name。模板 ID 不是成员名：同一模板可生成多个相互独立的成员，各自持有模型、提示词与工具配置；成员职责由 description 与 persona_prompt 表达，可用六内置模板（architect、implementer、reviewer、tester、researcher、designer）或已保存的自定义模板。

1. 调用 `action: inspect` 读取当前模板、配置 revision、本机 provider、当前根会话授权路由，以及结果中的 `roleTemplatesAvailable` 与模板目录。仅当用户选择的模型 ID 不明确时，调用 `action: models` 查询相应 provider。只询问影响配置的缺失选择，不索取整份 profile、凭据或全部模型的 effort。用户想了解有哪些职责模板或自定义模板内容时，调用 `action: roles`（只读列表，含内置与已保存自定义及 source 标注，不写配置）。
2. 用户要求调整工具时，调用 `action: tools` 查询当前根可见的共享／标准 Preset 工作工具及团队 Preset 协作工具。按返回的 name 精确选择；说明各角色将增加和移除哪些工具。文件、搜索、终端、skill、MCP 等名称以实际目录为准，不猜名称，不安装或启用其他插件来补齐缺口。共享工具保留原生逐步激活条件；根 Preset 中无条件注册的工作工具可供角色使用，有额外私有激活条件的根专有工具不列入。
3. 以用户要求生成 `members` 局部修改，支持 1～8 个成员：已知名单中的名字表示修改，新名字表示增员。增员必须显式给出 provider、model 和 reasoning_effort；可选 `role` 只在增员（新名字）时由模板填充未指定的非路由字段（description、提示词、工具建议），显式字段优先；给已有成员改 `role` 不重置字段，手写组件 template 中的 `role` 只记录职责来源、启动不解析；`agent_preset` 由系统按成员名自动合成，不可指定。字段支持 provider、model、reasoning_effort、description、persona_prompt、prompt、native_tool_allowlist；`native_tool_allowlist` 是该成员的完整替换列表，需要保留的协作工具也须列入；空数组明确表示不开放任何工具。移除默认配置成员用 `removeMembers`（成员名来自现状）；成员仍是种子任务 owner 时，须在同一次 preview/apply 用 `seedTasks` 显式改派或清除相应责任，否则返回 `SEED_TASK_OWNER_REMOVED`。`seedTasks` 与 `customTemplates` 同语义：整表替换未来默认团队的种子清单，行 `{key, subject, description, owner?, blocked_by?}` 前三项必填；省略 `owner` 即清除该种子的默认负责人（不传 null/空串），`seedTasks: []` 明确表示未来团队无种子。不传 `seedTasks` 则完整保留现有种子；owner 必须匹配最终成员集，依赖须引用表内 key 且不成环；工具不自动删除或清空种子来绕过校验，仍引用被移除／未知成员则拒绝。出厂默认→四成员的示例：一次调用中 members 新增 frontend/backend/tester（路由显式给出）、`removeMembers: ["implementer"]`、`seedTasks` 整表提交原两个 key——implement-work-item 的 owner 改为 frontend，review-work-item 保持 reviewer。seedTasks 只作用于未来默认团队；已建团队真实任务的完成／改派仍走原生 task 工具与 `dsh-team-replace`，不受其影响。超过默认 4 的成员帽使用 `maxMembers` 显式提升。新成员未显式给工具列表且采用内置模板时，工具建议与当前根真实目录取交集，preview 显示最终列表；显式列表、已保存成员与自定义模板列表保持 exact，缺工具直接报错，不静默过滤。用户要求保存职责模板目录时用 `customTemplates` 整表替换：每行须含 id、description、persona_prompt、prompt、native_tool_allowlist 五个字段，persona 非空，id 不得重复、占用内置 id 或 `lead`，模板记录不含 provider/model，保存模板不授予任何模型或工具权限。模板或成员配置校验失败时，工具返回相应错误代码（如 `UNKNOWN_ROLE_TEMPLATE`、`CUSTOM_TEMPLATE_ID_RESERVED`、`INVALID_MEMBER_ADDITION`、`TEMPLATE_MEMBER_LIMIT`）并附带 `stopFurtherMutation`／`noAutomaticRetry` 标记：停在当前一步，先 inspect 现状，不自动重试或换参数强行通过。增员、移除、成员编辑、模板目录与种子任务在同一 preview/apply 事务中按组合指纹校验：任一侧变化都会使另一侧的 preview 失效。未要求的工具和 effort 保持原值；effort 默认 max。增加成员必须走 members 新名语法并保存，不把提示词改名当成增员。
4. 把 inspect 返回的 `revision` 填入 `expectedRevision` 调用 `action: preview`。工具校验所选工具仍可用，并用原生 adapter 检查明确修改的模型路由与 effort；只改工具或提示词无需模型元数据。不支持的工具/effort 或模型解析失败应报告，不能换工具、provider、模型或降档来通过。元数据通过不代表远端模型已执行。
5. 用户已明确要求修改时，使用与 preview 相同的完整修改集（members／removeMembers／customTemplates／maxMembers／seedTasks）调用 `action: apply`，其中 `expectedRevision`＝inspect 返回的 `revision`、`expectedFingerprint`＝preview 返回的 `fingerprint`，无需重复索取同一配置授权。工具仍遵循 Harness 原生的本次操作审批；审批拒绝、取消或 revision 冲突后停止，不手工编辑文件绕过。用户只是询问方案时停在 preview。
6. 只有返回 `persisted: true` 才报告已保存。给出各成员的 provider/model/effort、实际工具清单和简要提示词变化，说明这是当前 profile 中尚未绑定团队的根会话默认值，已有成员未被修改。

工具集控制的是角色能看见和调用哪些工具，不授予更高文件或终端权限；调用仍经过原生沙箱、审批与激活条件。开放 shell 也允许执行可能写文件的命令，不能把“读取工具 + shell”称为强制只读。团队启动、成员管理、配置编辑和 PTC 传输不属于可分配的工作工具。

该 skill 随插件打包、注册和卸载。升级插件并完成重新加载后，下一次调用会读取新版 skill，无需另装全局副本。旧对话中已注入的内容不会被改写；需要新版指导时重新调用此 skill。

配置不会扩大模型授权。若 currentSessionAuthorization 有 false，需要用户在原生子智能体模型选择中授权所需路由，保存后创建新根会话。若 currentSessionNeedsNewRoot 为 true，旧根已固定模板，也应使用新根。全局选项不会追溯修改旧会话 policy。

已绑定根继续使用原模板。rc.7 启动的团队将原绑定与替换记录持久保留，重载后按该记录恢复 Preset；历史团队仍须保留原组件与 Preset。不要用重复 plan/launch 迁移旧团队，也不要删除 replacementRecords。

只配置不调用模型、不创建成员、不执行 launch。用户另外要求启动时，再按原生 plan/launch 流程处理。不要用重复 launch 更换已有成员。写入结果不确定时先报告并用 inspect 核对，不自动重试、回滚或删除配置。

若 `dsh_team_configure` 不存在，说明当前环境未安装或加载相应插件，报告这个缺口；不要把临时手改配置冒充 skill 已成功执行。

## 替换空闲成员（0.5.0-rc.7+）

用户要求修改名册中已有成员的模型、effort、提示词或工具，或给当前团队增员／移除成员时，调用 `dsh-team-replace` skill 与 `dsh_team_replace` 工具：替换先 inspect，在 `inspect.roles` 中选目标成员行 `row`，令 `role=row.role`、`expectedOldChildId=row.currentChildId` 后 replace；找不到目标行或 `currentChildId` 为 `null` 时停止并核实。增员用 `action: add` 提交完整成员配置（路由字段必须显式给出；其中 `role` 只记录职责来源，不解析模板补字段）；移除用 `action: remove` 与 inspect 返回的稳定成员名，拦截的是未完成责任（含尚未接管的种子责任）。effort 未指定时为 max。progressFacts 写明已有文件、已验测试、未确认副作用和下一步。保留任务 ID、依赖、进度与历史。

已有未完成操作时，使用原 operationId recover；不要重复 launch 或 spawn。候选先受强制 Standby 限制，Lead 完成原生 owner/CAS 改派后才激活，再以候选真实任务写回证明接管。首次 owner 写入意图前可明确 cancel，待候选停止和 owner 安全后解冻；之后只能恢复对账。完整说明以替换 skill 为准。
