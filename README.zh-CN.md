# DSH 团队预设与一键建队

在 DeepSeek Harness 的目标会话中，一次创建 1～8 个具名成员（内置示例为 implementer 与 reviewer 两名），每个成员独立配置模型路由、持久角色提示词与工作工具集，并可从内置或自定义角色模板起步。

**当前源码：0.6.0-rc.1**（供独立审查的候选，未 release；已发布版本仍为 0.5.0-rc.7）。安装后提供 profile 全局的 `dsh-team-configure` skill，可以在 Agent 会话中配置成员（1～8 个）的 provider、模型、effort、提示词与工具集，无需手工编辑 YAML。默认 effort 为 `max`，由实际配置的原生 adapter 验证。本次更新未进行付费模型运行；历史 rc.2 的 macOS low 实机结果不代表本版本的任意模型已验。[验收范围与已知限制](docs/ACCEPTANCE.md)。

**多角色候选能力。** 默认团队支持 1～8 个独立成员：沿用名单中的名字表示修改，新名字表示增员（必须显式给出 provider/model/effort），也可移除成员；全部经同一 inspect→preview→apply 的 revision＋fingerprint 门禁与原生审批保存。六内置角色模板（architect、implementer、reviewer、tester、researcher、designer）携带职责提示词与工具建议；自定义模板与默认模板同表持久化，整表替换走同一次 CAS。未来默认的种子任务经 `seedTasks` 同规则整表替换：要移除仍是种子任务 owner 的成员，须在同一次保存中显式改派或清除该责任（省略 `owner` 即清除，`seedTasks: []` 表示无种子）；未显式调整则保存被拒，不静默删除任何种子。已建团队真实任务不受 seedTasks 影响，仍走原生 task 工具与替换流程。模板 ID 不是成员身份：同一模板可有多个相互独立的成员，各自持有模型、提示词与工具集。模板不含 provider/model，不授予任何权限。已保存成员与显式工具列表保持 exact；仅"全新成员取自内置模板且未提供工具列表"时把模板建议与当前根真实目录取交集，preview 显示最终列表。无 role 字段的旧模板指纹逐字节不变，rc.7 团队继续可读。原生 scripted-provider 验收覆盖真实出厂配置、单成员／四成员启动、显式成员调整和 rc.7 迁移。按[验收记录](docs/ACCEPTANCE.md)核对候选 TGZ 摘要与精确平台回执；草稿 PR 不代表发行。

Windows x64 适配面向已检查的 Harness 0.2.2-rc.5 和当前会话 `/dsh-team` 入口，见 [Windows 安装与 CI 验收](docs/WINDOWS.md)。旧的本地文件绑定入口仍只支持 macOS。

## 下载与安装

在本源码包目录执行以下命令打包：

```sh
npm pack
```

在 Harness 官方插件管理器中安装生成的 `dsh-subagent-live-rc2-local-0.6.0-rc.1.tgz`。打包不会更新已安装副本。安装会同时注册当前会话入口、配置工具和 skill；该 profile 的根会话均可发现 skill，不必另拷到每个项目。无需填写 Session ID 或运行离线绑定准备命令。已有旧版个人绑定包时，先核对保留原组件和 Preset 的迁移方案，避免旧成员失去预设。此前仅面向 rc.2 的 0.5.0-rc.1 sidecar 不是 Harness rc.5 的安装源。

[历史 v0.5.0-rc.2 预发行](https://github.com/08mamba24/dsh-team-presets/releases/tag/v0.5.0-rc.2) 保持原先实机验收时的 low 配置，不包含本次 max 更新。本候选通过受审源码与精确 CI 包产物提供。包名中的 `rc2-local` 是历史名称。

## 在会话中配置团队

向 Agent 说明需要的角色配置，例如：

```text
使用 dsh-team-configure：查看本机 codeagent 可用模型。
把实现角色设为我指定的模型，effort 用 max；复核角色用另一模型和 high。
复核提示词加上“先读取实现证据，再独立验证”。保存为团队默认配置。
```

Agent 会读取实际 provider/model ID，预检明确修改的路由与 effort，再通过原生审批和持久设置保存。只需提供本机真实模型选择；不需要贴整份 profile 或凭据。仅询问方案时只预览，不保存。

每个成员可分别改职责、模型、effort、提示词和工具集，并可从内置或已保存的自定义角色模板起步（`action: roles` 只读列出模板，`customTemplates` 整表保存自定义模板）。成员数量 1～8，超过默认 4 的帽需显式提升；同一模板可生成多个模型、提示词与工具互不串扰的独立成员。“全局”指当前安装 profile 的默认模板；已有团队不随默认值变更。保存后按工具提示使用尚未绑定团队的根会话；若模型授权也有变化，须保存原生授权并新建根会话。skill 不自动授权或启动成员。完整说明见[模型与提示词](docs/MODELS-AND-PROMPTS.md)。

## 按角色配置工具

例如：“使用 dsh-team-configure，实现者开放文件读写、搜索和终端；复核者只开放读取、搜索与协作。”Agent 会查询实际工具目录，列出各角色的增加／移除项，再通过原生审批保存。

未保存模板的新默认值会加入 Host 已注册且当前根可见的基础文件、搜索、终端和 skill 工具（包括标准 Preset 中无条件注册的工具）。终端以实际目录为准，例如 `bash` 或 `pwsh`；已保存的模板及显式工具列表保持原值。取自内置模板且未显式给列表的新成员，其工具建议与当前根真实目录取交集，preview 显示最终列表。可用工具也可以包含已安装的 MCP 工具。工具可见性与文件／终端权限是两层控制；实际调用仍服从原生沙箱、审批和逐步激活条件。开放 shell 不能承诺强制只读。

配置 skill 随插件打包和注册。升级插件并完成重新加载后，后续调用使用新版 skill，无需另外安装全局副本；旧对话中已注入的说明会保留，需要时重新调用 skill。模型与提示词配置从 rc.5 起可用，工具集配置需要 rc.6。

## 允许两条模型路由

默认模板使用：

| 角色 | provider/model | 默认 effort |
| --- | --- | --- |
| implementer | `deepseek-account/deepseek-flash` | `max` |
| reviewer | `deepseek-account/deepseek-v4-pro` | `max` |

在原生界面的“插件 → 官方 → 子智能体 → 模型选择”开启 Agent 选择模型，并勾选模板所需路由。保存后创建新根会话；已有会话不会因为全局选项改变而自动获得新的持久模型授权。`plan` 只给出成员创建／冲突计划；`launch` 才检查目标会话的真实 policy。规划通过不代表模型已经获授权，本插件不会替会话授予权限。

DeepSeek 官方提供方的 Pro 菜单项可能标注路由到 Flash；它不能替代模板里的 account/Pro 路由。验收证明了客户端配置与实际请求使用的两条路由，不证明服务端权重身份或计费。

如果后续继续使用这两条路由，可以保留相应可选项；恢复临时偏好是独立的设置操作。

## 在目标会话建队

先执行：

```text
/dsh-team plan
```

核对各角色的创建／冲突计划。模型路由从模板配置检查，工作目录从当前原生会话检查；`plan` 不输出这些值，也不验证模型授权。`launch` 才执行原生 policy 和路由解析准入。`plan` 不创建或唤醒成员，也不调用模型。首次绑定读取原生有效工作目录；规划后变更目录会拒绝启动，应回到规划时的目录。

计划符合预期后执行：

```text
/dsh-team launch
```

这一步会调用模型，按模板创建成员（默认示例为两名）并让其逐一确认就绪。种子任务保持待处理，业务工作需要另外下达。每个根会话有独立的角色 Preset；同一安装可以服务不同的根会话。

再次执行 `launch` 时，已有同名成员会触发 `LAUNCHER_MEMBER_CONFLICT` 等冲突结果。本次实测保留原成员与任务，零新增、零唤醒、零模型步骤。它是重复保护，不表示已经实现同名成员的等价复用。

命令结果可能显示为可展开的命令记录。首条结果未及时出现的现象仍未定位；先检查命令记录／轨迹，不要通过追加问候或重复 `launch` 来判断是否安装成功。

## 给现有成员分配任务

新默认值会按实际 Host 目录加入基础工作工具，已有模板可通过 skill 调整；历史 rc.2 实机验收仅使用任务板与消息。工作顺序应当是：

1. Lead 只分配可执行的实现任务。
2. implementer 写回证据、完成实现任务，再向 reviewer 交接实际任务 ID。
3. reviewer 读取实际任务，确认前置任务已 completed、执行阻塞解除且依赖边仍保留，然后领取复核任务，独立验证并写回结果。
4. 工具拒绝时停止并报告；保留依赖，不通过清空依赖来强行分配。

实机完成了 `17 × 23 = 391` 的写回、直接交接与另一种算法复核。验收中 Lead 曾在任务被阻塞后临时移除并恢复依赖，这是保留的 P2 编排偏差；严格指令遵循未通过。上述澄清后的工作顺序尚未另行实机执行。

## 替换空闲成员

在已有团队的根会话中调用打包的 `dsh-team-replace` skill，例如：

```text
使用 dsh-team-replace，先查看当前团队。把 implementer 换成我指定的
provider/model，effort 用 max，采用以下角色提示词、工作提示词和完整工具清单。
保留原任务 ID、依赖与已完成进度。
交接实况：已改文件、已验证测试、未确认副作用、下一步。
```

Agent 先调用 `dsh_team_replace action: inspect`，在 `inspect.roles` 中选出目标成员行 `row`。调用 `action: replace` 时，令 `role=row.role`、`expectedOldChildId=row.currentChildId`，并传入 provider、model、reasoningEffort、personaPrompt、prompt、完整 tools 和 progressFacts；找不到目标行或 `currentChildId` 为 `null` 时停止并核实现状。effort 未指定时默认 `max`，实际路由仍须通过会话 policy 与原生 adapter。替换只改变当前团队的选定角色；后续新团队的默认值由 `dsh-team-configure` 修改。

旧成员及其后代必须停稳：没有在途 turn、工具、排队输入或受管后台作业。业务任务可以保持 `in_progress`。已自然卸载的成员依据原生目录、已结束 turn 和持久 inbox 确认静止。带未完成前置依赖的任务会在冻结前被拒绝，依赖不变。

系统先持久冻结旧成员的执行资格，再创建强制 Standby 候选。候选只可读取交接任务，并向 Lead 发送绑定 operation、handoff、config 的精确就绪 ACK。Lead 逐任务按原生 revision CAS 改派，全部确认后才放行工作。已完成任务、依赖、进度与双方 Session 历史保留。`activating` 表示获准工作、接管仍待证明；候选自己的原生工具调用和成功任务写回匹配后才进入 `active`。没有未完成任务时明确返回 `not-required`。就绪 ACK 本身不代表接管成功。

替换后，Lead 和同伴仍使用各成员的稳定名称发消息和填写任务 owner。原生工具结果显示当前逻辑成员，多次替换和重载后继续有效；旧名称和退役 Session ID 会被拒绝。替换尚未完成时，该成员暂不可寻址，应 inspect 或 recover 原操作。要给当前团队增减人手时，用 `action: add`（完整成员配置，路由字段显式给出；其中 `role` 只记录职责来源，不解析模板补字段）或 `action: remove`（inspect 返回的稳定名）。remove 拦截的是未完成责任——含尚未被其他成员接管的种子责任；相关任务完成或改派后即可移除，不是当过种子任务 owner 就永久不可移除。

遇到超时、部分改派或写入不确定，先 inspect，再对原 operationId 调用 `recover`。恢复会重新核对当前 owner/status，并续接同一个候选 Session，不重复创建。首次 owner 写入意图之前可明确调用 `cancel`，包括候选尚未创建的冻结计划；确认候选已停止、任务 owner 安全后才解冻旧成员。首次 owner 意图之后只能恢复对账，旧成员持续退役。

旧版本团队可在原生启动指纹和 child header 均验证原绑定后自动迁移。默认值已改变时会返回 `REPLACEMENT_ORIGINAL_TEMPLATE_REQUIRED`，需向 `dsh_team_replace action: adopt` 提供完整原模板，由工具验证后才注册受管 Preset；无法找回原配置时保留现场，不猜旧 persona。

原生 profile 持久保留各根的原配置、完整候选配置和生命周期记录，重载后先恢复相应 Preset。手工改配置须保留 `replacementRecords`；新默认值不改变这些团队。实际工具仍服从原生沙箱、审批与限制。替换无法撤销已进入工具体的副作用或任意自行脱离管理的后台进程，也不改变续接 `maxTokens`。新路径面向已检查的 Harness rc.5，证据范围见[验收说明](docs/ACCEPTANCE.md)。

## 配置、恢复与限制

推荐使用上面的会话 skill；旧版用户须安装新包才能获得新增能力。没有专用的模型选择表单。手动配置仍可使用，Windows 文件位置和完整补丁见 [Windows 手动配置](docs/MODELS-AND-PROMPTS.md#windows-manual-configuration)。两种方式都无需重新打包插件。

保存默认值会保留既有绑定。rc.7 起，已启动且保留替换记录的团队会在重载后先恢复原模板与作用域 Preset；未绑定的根使用新默认值。历史团队若没有该记录，须保留原组件与 Preset。重复 launch 不是迁移命令。

`examples/team-template.json` 是 1～8 成员团队的基础示例（演示两名成员）；未设置 `template` 时，当前会话入口另外按 Host 目录生成工作工具默认值。可在当前组件配置中将可选 `template` 替换为同格式对象，调整成员提示词、模型、启动提示与原生工具白名单；成员还可带可选 `role` 字段记录内置或自定义模板的职责来源——手写模板中的成员字段必须完整，`role` 只在 `dsh-team-configure` 新增成员时解析并填充未指定的非路由字段。无 role 的旧模板指纹保持不变。组件支持 `timeoutMs` 和每角色 `maxStreams`；默认每角色一次普通启动 stream，可配置 1～12 次。模板只表达配置，真实准入仍由原生 policy 和工具权限决定。逐字段说明见[修改模型与提示词](docs/MODELS-AND-PROMPTS.md)。

默认模板的 `reasoning_effort` 已改为 `max`，也可逐成员填入其原生模型支持的 effort ID。多个成员可以使用同一个 provider/model。原生 `resolveCallConfig` 会在修改 Team 或创建成员前拒绝路由解析失败、不支持的 effort，不会偷偷降档；元数据检查不代表远端模型一定执行成功。启动请求的 `maxTokens=1024` 是独立限制，不是团队生命周期、总 token 或金额上限；历史 rc.2 验收中的后续任务和自我介绍曾使用 `maxTokens=256000`。本次更新不修改续接 token 预算。

```text
/dsh-team restore
```

该命令仅在原操作的恢复权限仍在、根会话无排队输入、原根与成员均空闲且未被替换、完整任务板自启动结束后保持不变时，才可还原先前 Team 模式。普通业务写回会改变任务 revision、状态或描述，导致 `RESTORE_BOARD_CONFLICT`；成员条件不满足时可能更早拒绝。因此，业务完成后不能承诺 `restore` 成功。遇拒绝应保留当前 Team 模式与证据，停止自动补偿；不要清空任务、倒改依赖或重跑工作来强行恢复。命令保留成员和任务。

插件或 Host 重载后，保留的 rc.7 绑定会在成员续接前自动注册原始及候选 Preset。这与 `/dsh-team restore` 的启动模式还原不同；后者的内存恢复权限不会由 `plan` 重建。旧版本绑定按上文的原模板验证步骤迁移。冷续接和部分恢复故障已由隔离原生检查覆盖；正向成员复用、自动 Lead 唤醒及任意部分失败仍未验收。卸载使用官方管理器，等待已有操作和成员结束。

旧的显式绑定入口 `/dsh-team-launcher` 及离线 prepare 继续保留，流程见 [旧版绑定安装](docs/LEGACY-BOUND-INSTALL.md)。

## Harness 升级与源码验证

每次 Harness 升级后，在源码包目录执行：

```sh
npm run check:compat -- --upstream
```

该按需只读命令检查物理 App 指纹、安装声明和官方 release feed；未知 RC 或归档需要重新审查。它不订阅后台监控，也不安装、改 profile 或调用模型。当前支持范围及指纹见 [HOST-COMPATIBILITY.md](docs/HOST-COMPATIBILITY.md)。

源码检查和打包需要 Node.js 22 或更新版本与 npm；仓库没有额外 npm 运行依赖：

```sh
npm test
```

离线测试不能替代真实 Harness 验收。源码和通用发行包可上传；个人绑定包、profile、凭据、原始会话日志和本地工作区标记留在本地。第三方提取物及其许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
