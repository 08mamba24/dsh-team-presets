# 修改 provider、模型、effort、提示词与工具集

**rc.5 提供会话配置 skill，rc.6 增加按角色工具集配置。无需手工编辑 YAML。** 安装新包后，`dsh-team-configure` 与 `dsh_team_configure` 工具在该 Harness profile 的根会话中可用。rc.4 仍使用下方手动方式；它不会通过仓库文档更新自动获得新工具。两种方式均无需修改安装目录或重新打包插件。

rc.4 包含 rc.3 的配置改动：默认成员为 implementer（deepseek-account/deepseek-flash）与 reviewer（deepseek-account/deepseek-v4-pro），两者默认 effort 为 max。各角色可以独立选 provider、model 和 effort，也可以使用相同模型；这不代表使用了不同后端权重。

## 推荐：在 Agent 会话中配置

可以直接说：“使用 dsh-team-configure，列出 codeagent 的模型；把实现角色设为我选的模型 A、max，复核设为模型 B、high，提示词要求先读证据再复核，保存默认配置。”示例里的 A/B 需要换成你的真实选择，Agent 可先从本机模型目录查找实际 ID。

skill 先读取模板、provider、当前会话授权和设置版本，然后只修改指定字段。支持 `provider`、`model`、`reasoning_effort`、`description`、`persona_prompt`、`prompt` 和 `native_tool_allowlist`；保留 Preset、种子任务与未指定字段。成员数量为 1～8：编辑沿用名单中的名字，增员使用新名字并显式给出 provider/model/reasoning_effort（`agent_preset` 由系统按成员名自动合成，不可指定），从默认配置移除成员用 `removeMembers`；成员仍是种子任务 owner 时，须同一次 preview/apply 用 `seedTasks` 显式改派或清除相应责任，否则返回 `SEED_TASK_OWNER_REMOVED`。`seedTasks` 与 `customTemplates` 同语义：整表替换未来默认团队的种子清单，行 `{key, subject, description, owner?, blocked_by?}` 前三项必填；省略 `owner` 即清除该种子的默认负责人，`seedTasks: []` 表示未来团队无种子；不传则完整保留现有种子。owner 必须匹配最终成员集，依赖须引用表内 key 且不成环，不自动删种子绕过校验。seedTasks 只作用于未来默认团队；已建团队真实任务的完成／改派仍走原生 task 工具与 `dsh-team-replace`。超过默认 4 的成员帽用 `maxMembers` 显式提升。

例如把出厂默认（implementer/reviewer＋两个种子任务）改成 frontend/backend/tester/reviewer：一次 preview/apply 中 members 新增 frontend、backend、tester（路由字段显式给出，可引用 role 模板起步），`removeMembers: ["implementer"]`，`seedTasks` 整表提交原两个 key——implement-work-item 的 owner 改为 frontend，review-work-item 保持 reviewer（blocked_by 依赖照旧引用表内 key）。同次调用即可达成，不需要保留旧成员凑数，也不会静默丢掉任何种子任务。成员可带可选 `role` 引用职责模板：只有 configure 增员（新名字）时才由模板填充未指定的非路由字段；给已有成员改 `role` 不重置字段，手写组件 `template` 里的 `role` 只记录职责来源、启动时不解析补字段；职责与人数都通过上述写法调整，改名或改提示词本身不会增加成员。

配置工具有六个动作：`inspect` 查看现状，`models` 查询一个 provider 的模型目录，`tools` 查询可分配的工具目录，`roles` 只读列出六内置模板与已保存的自定义模板（含来源标注，不写配置），`preview` 预检局部修改，`apply` 保存同一预览。模型目录不返回可选 effort 清单；所选 effort 由预检按原生 adapter 验证。只有明确修改的路由或 effort 才查询原生 adapter；只改工具或提示词不需要模型元数据调用。预览使用设置 revision；指纹是成员模板与自定义模板目录的组合身份，保存时核对完整组合指纹，任一侧被他人同时改动都会使另一侧的 preview 失效并返回冲突，不覆盖。`customTemplates` 与 `seedTasks` 和默认模板在同一次 CAS、审批和读回中整表替换。保存遵循 Harness 原生审批，读取回验成功才返回 `persisted: true`。配置阶段不执行模型推理。

用户已明确要求保存时，Agent 可在预览成功后直接保存同一修改；仅询问方案则停在预览。审批拒绝、取消或结果不确定时停止，不退回手改文件绕过。保存失败不代表一定未写入，应先读取现状核对。

保存范围是当前 profile 的默认模板，不扩大旧会话的授权，也不修改已有成员。当前 Host 中已执行 plan/launch 的根保持原模板；未绑定的根使用新默认值。工具会告知是否需要新根。若所选路由未授权，先保存原生子智能体模型选择：rc.5 须再建新根，alpha.2 的实时设置从下一次操作生效。配置成功不会自动 launch。

rc.7 将已启动团队的原绑定与替换记录持久保留，重载时先恢复原 Preset；历史团队若没有记录，仍需原组件和 Preset。已有成员的变更使用 `dsh-team-replace` skill，不用重复 launch。手工编辑 config 时须保留 replacementRecords 以及其他既有选项。

## 配置工具集

在会话说：“实现者允许文件读写、搜索和终端，复核者只保留读取、搜索与协作，保存默认配置。”Agent 先调用 `action: tools`，按实际返回的 name 选择，不需要你记住工具 ID。

`native_tool_allowlist` 完整替换该角色的列表，保留的协作工具也要列入；空数组表示零工具。目录包含当前根可见的共享工具、标准 Preset 中无条件注册的工作工具，以及原生 Team/control Preset 的协作能力。角色使用原工具的 schema 和执行实现；共享工具保留原生激活条件，带私有激活条件的根专有工具不会复制。团队启动／管理、配置编辑和 `run_code` 传输不作为可分配工作工具。未知或不可见工具返回失败；审批等待期间工具被卸载也不会保存。调用前会核对原根仍在当前 Host、工具仍可见且定义未变；撤权、卸载或同名替换后拒绝执行。

未保存模板的新默认值从实际目录选取 `read`、`write`、`edit`、`apply_patch`、`glob`、`grep`、`bash`／`pwsh`、`str_replace_editor` 和 `skill` 中存在的项，并保留可用协作工具；不会虚构未安装工具。已有保存模板与显式列表保持不变，调整后由尚未绑定团队的根使用。仅"新成员取自内置模板且未提供工具列表"时，把模板的工具建议与当前根真实目录取交集，preview 显示最终列表并按确认结果保存；显式列表（含空数组）、已保存成员与自定义模板列表始终 exact，缺工具照旧报错，不静默过滤。

## 角色模板：查询、复制与自定义

内置六个职责模板：`architect`（方案拆解与取舍）、`implementer`（实现与证据写回）、`reviewer`（独立复核裁定）、`tester`（可复现验证）、`researcher`（证据收集与交叉核实）、`designer`（面向使用者的设计规格）。模板记录只含 `id`、`description`、`persona_prompt`、`prompt`、`native_tool_allowlist` 五个字段，不含 provider/model，也不授予模型授权或文件权限。

- 模板 ID 不是成员身份：同一模板可以生成多个成员，各自的模型、提示词与工具集独立配置、互不串扰。
- 查询：`dsh_team_configure action: roles` 只读列出内置与已保存自定义模板；在 configure 增员（新名字）时给成员填 `role`，仅由模板填充未显式给出的非路由字段。已有成员改 `role` 不重置字段，手写组件 `template` 中的 `role` 只记录职责来源，不解析补字段。
- 复制与自定义：先读取模板内容，调整后经 `customTemplates` 整表保存。自定义 id 必须唯一且不得占用内置 id；`persona_prompt` 必填非空；非法或托管工具名（如 `subagent`、`plugin_manager`）在保存校验阶段直接拒绝。模板行里的工具名在 preview/apply 保存时就按当前根真实目录核对；只有 configure 新增成员未显式给工具列表时，才把内置模板建议与真实目录取交集。
- 持久化：profile 设置的值形如 `{template, customRoleTemplates}`，成员模板与自定义模板目录共享同一 revision、组合指纹与审批读回。
- 兼容：不写 `role` 字段的旧模板指纹逐字节不变；rc.7 的绑定与替换记录继续可读，已有成员不会因为模板更新而改变。

校验与错误：模板库的失败按代码原样透传——`UNKNOWN_ROLE_TEMPLATE`（引用不存在的模板）、`INVALID_ROLE_TEMPLATE_ID`（写法不合法）、`DUPLICATE_ROLE_TEMPLATE_ID`、`RESERVED_ROLE_TEMPLATE_ID`（占用内置 id）、`INVALID_ROLE_TEMPLATE_PERSONA`（persona 缺失或为空白；persona 从不是可省略字段）、`UNSUPPORTED_ROLE_TEMPLATE_TOOL`／`DUPLICATE_ROLE_TEMPLATE_TOOL`（托管工具名或重复工具名）。配置层另有 `CUSTOM_TEMPLATE_ID_RESERVED`（内置 id 与 `lead` 均不可作为自定义模板 id）、`ROLE_TEMPLATES_UNAVAILABLE`（当前环境未加载模板库）、`INVALID_MEMBER_ADDITION`（增员配置不完整或与现有成员冲突）、`TEMPLATE_MEMBER_LIMIT`（超过成员帽，需显式提升 `maxMembers`）；未在当次调用显式调整 `seedTasks` 而移除仍持有种子责任的成员返回 `SEED_TASK_OWNER_REMOVED`。失败响应携带 `stopFurtherMutation: true` 与 `noAutomaticRetry: true`：停在当前一步，用 inspect 读取现状后再决定，不自动重试、不替换工具、provider、模型或降低 effort 来强行通过。

工具集控制可见性，不扩大原生沙箱或审批权限。终端能执行写文件的命令，不能用“只读工具 + shell”承诺强制只读。目录不执行工具的逐步激活条件；原生条件仍可能在实际步骤中拒绝工具，此时报告失败，不自动替换工具。

skill 文件随插件升级并在重新加载时注册。无需另复制到全局目录；旧对话中的已加载文本保留，重新调用 skill 才读取新说明。

<a id="windows-manual-configuration"></a>

## Windows：手动修改模型和 effort

1. 按 `Win + R`，输入 `%USERPROFILE%\.dsh\profiles\desktop`。先备份，再用记事本打开其中的 `cordis.patch.yml`。如果使用了自定义 `DSH_HOME` 或其他 profile，以实际运行路径为准。
2. 打开 [完整用户配置补丁](examples/windows-team-config.patch.yml)，将两个 `REPLACE_*_MODEL_ID` 替换为实际模型 ID。示例中的 provider 是 `codeagent`，可改为本机实际配置的 provider ID；两角色的 effort 默认都是 `max`。示例保留了原模板的角色提示词、工具和任务，并非已应用到本机的配置。
3. 将示例的顶层列表项加入原文件的列表，保留其他配置项。如果原文件只有 `[]`，用该列表项替换空列表。如果已有 `id: dsh-native-current-team`，更新该项的 `config.template`，保留 `mode: current-session`、完整 `replacementRecords` 以及已有的 `timeoutMs`、`maxStreams` 等设置。宿主按组件 ID 替换整个 `config`，不会逐层合并其中的字段。
4. 保存并确认插件加载正常。在“插件 → 官方 → 子智能体 → 模型选择”开启 Agent 选择模型，并勾选模板中使用的 provider/model 路由。rc.5 保存授权后创建新根，旧会话保持原 policy；alpha.2 每次操作读取实时设置，保存或撤销均立即影响下一次操作。
5. 在新根会话中先执行 `/dsh-team plan`，核对成员创建／冲突计划；再执行 `/dsh-team launch`。plan 不验证模型授权或 effort；launch 执行原生准入检查并会调用模型。已有成员不会通过重复 launch 更新配置。

每名成员可独立修改以下字段：

| 配置项 | 字段 | 填写内容 |
| --- | --- | --- |
| Provider | `provider` | 原生 provider ID，例如 `codeagent` |
| 模型 | `model` | 本机实际配置的 model ID，不是界面显示名 |
| 推理强度 | `reasoning_effort` | 目标模型原生支持的 effort ID，默认 `max` |
| 持久角色提示词 | `persona_prompt` | 职责、协作规则与证据标准 |
| 首次启动输入 | `prompt` | 创建成员后发送的一次性输入 |
| 职责模板 | `role` | 可选；记录内置或自定义模板 id 的职责来源。手写模板中成员字段仍须完整，`role` 只在 configure 增员新成员时解析并填充未显式给出的非路由字段 |

`max` 是否可用取决于目标模型的原生 adapter，不取决于 Windows 或 macOS。若 plan 成功而 launch 返回 `SESSION_ROUTE_NOT_AUTHORIZED`，检查模板中的 provider/model 是否属于该根会话的授权路由；`codeagent/<model>` 与 `deepseek-account/<model>` 是不同路由。对齐配置和授权；rc.5 还须使用新根，alpha.2 则在下一次操作重读实时授权。不通过降低 effort 或向已有成员重复 launch 来更新配置。

## 使用实际配置的 provider/model

1. 先在 DSH 的模型设置中配置 provider 和模型，取得真实的 provider ID 与 model ID。界面显示名不一定等于 ID。
2. 复制完整的 `examples/team-template.json`，修改对应成员的字段。以下只是成员片段，保留原成员的描述、提示词、Preset 和工具字段：

   ```json
   {
     "name": "implementer",
     "provider": "your-provider-id",
     "model": "your-model-id",
     "reasoning_effort": "max"
   }
   ```

3. 将修改后的**完整模板对象**放入当前会话插件组件配置的 `template` 字段。这个字段接收对象，不是文件路径；不是把成员片段直接作为整个配置，也不是改 DSH 的日常主模型。省略 template 才使用包内默认模板。当前没有专用模板编辑表单。
4. 在原生子智能体模型选择中允许所选路由，rc.5 保存授权后再建新根，alpha.2 的实时授权从下一次操作生效；团队默认配置须在未绑定根首次 plan/launch 前加载。不要拿已经有成员的会话重复 launch 来应用新配置。

模型存在于配置中，不等于已获该根会话授权。launch 在 rc.5 读取根会话持久 policy，在 alpha.2 读取原生实时设置（撤销后不回退旧事件），并用原生 resolveCallConfig 检查各成员的路由与 effort，之后才修改 Team、创建任务或成员。路由解析失败、不支持的 max 或未授权路由都会返回失败，不自动换 provider、换模型或降低 effort；可显式改为该模型实际支持的 effort ID。某些 adapter 允许直接填写未列在目录中的远端模型 ID，元数据解析成功不代表远端执行成功。plan 只规划角色创建/冲突，不验证模型授权或输出模型清单。

## 两层提示词

- `persona_prompt`：角色 Preset 中持续生效的角色提示词，用于职责、协作规则和证据标准。
- `prompt`：首次启动时的一次性输入。默认只确认就绪，等待明确任务。

改提示词不会增加文件或 Shell 工具权限。能力仍受原生权限和 native_tool_allowlist 约束。配置修改后以新建团队为准；已有成员不会通过重复 launch 被替换。

## effort 与 token 预算

`max` 是原生 adapter 的 effort ID，不是无限 token。rc.3 仍保留首次启动 maxTokens1024；后续原生续接的 token 预算不由这项默认值保证。模板中的 effort 必须显式填写，rc.2 自定义模板中已有的 low 不会被偷偷改成 max；应由配置作者修改。
