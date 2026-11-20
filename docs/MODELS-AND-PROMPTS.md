# 修改 provider、模型、effort 与提示词

**rc.5 提供会话配置 skill，无需手工编辑 YAML。** 安装新包后，`dsh-team-configure` 与 `dsh_team_configure` 工具在该 Harness profile 的根会话中可用。rc.4 仍使用下方手动方式；它不会通过仓库文档更新自动获得新工具。两种方式均无需修改安装目录或重新打包插件。

rc.4 包含 rc.3 的配置改动：默认成员为 implementer（deepseek-account/deepseek-flash）与 reviewer（deepseek-account/deepseek-v4-pro），两者默认 effort 为 max。各角色可以独立选 provider、model 和 effort，也可以使用相同模型；这不代表使用了不同后端权重。

## 推荐：在 Agent 会话中配置

可以直接说：“使用 dsh-team-configure，列出 codeagent 的模型；把实现角色设为我选的模型 A、max，复核设为模型 B、high，提示词要求先读证据再复核，保存默认配置。”示例里的 A/B 需要换成你的真实选择，Agent 可先从本机模型目录查找实际 ID。

skill 先读取模板、provider、当前会话授权和设置版本，然后只修改指定字段。支持 `provider`、`model`、`reasoning_effort`、`description`、`persona_prompt` 和 `prompt`；保留工具白名单、Preset、种子任务与未指定字段。目前只有 implementer/reviewer 两个稳定角色，可调整职责和提示词，不能借改名增加任意成员。

配置工具有四个动作：`inspect` 查看现状，`models` 查询一个 provider 的模型及 effort 元数据，`preview` 预检局部修改，`apply` 保存同一预览。只有明确修改的路由或 effort 才查询原生 adapter；只改提示词不需要模型元数据调用。预览使用设置 revision，保存还核对完整模板 fingerprint；他人同时改配置会返回冲突，不覆盖。保存遵循 Harness 原生审批，读取回验成功才返回 `persisted: true`。配置阶段不执行模型推理。

用户已明确要求保存时，Agent 可在预览成功后直接保存同一修改；仅询问方案则停在预览。审批拒绝、取消或结果不确定时停止，不退回手改文件绕过。保存失败不代表一定未写入，应先读取现状核对。

保存范围是当前 profile 的默认模板，不扩大旧会话的授权，也不修改已有成员。当前 Host 中已执行 plan/launch 的根保持原模板；未绑定的根使用新默认值。工具会告知是否需要新根。若所选路由不在当前会话 policy，先在原生子智能体模型选择中授权，保存后再建新根。配置成功不会自动 launch。

模板持久化不等于旧团队冷恢复。完整 Host 重启后的旧成员续接尚未验收；改默认值后不要用旧根 plan/launch 强行迁移团队。完整模板、工具或任务的高级修改仍可使用手动配置。

<a id="windows-manual-configuration"></a>

## Windows：手动修改模型和 effort

1. 按 `Win + R`，输入 `%USERPROFILE%\.dsh\profiles\desktop`。先备份，再用记事本打开其中的 `cordis.patch.yml`。如果使用了自定义 `DSH_HOME` 或其他 profile，以实际运行路径为准。
2. 打开 [完整用户配置补丁](examples/windows-team-config.patch.yml)，将两个 `REPLACE_*_MODEL_ID` 替换为实际模型 ID。示例中的 provider 是 `codeagent`，可改为本机实际配置的 provider ID；两角色的 effort 默认都是 `max`。示例保留了原模板的角色提示词、工具和任务，并非已应用到本机的配置。
3. 将示例的顶层列表项加入原文件的列表，保留其他配置项。如果原文件只有 `[]`，用该列表项替换空列表。如果已有 `id: dsh-native-current-team`，更新该项的 `config.template`，保留 `mode: current-session` 以及已有的 `timeoutMs`、`maxStreams` 等设置。宿主按组件 ID 替换整个 `config`，不会逐层合并其中的字段。
4. 保存并确认插件加载正常。在“插件 → 官方 → 子智能体 → 模型选择”开启 Agent 选择模型，并勾选模板中使用的 provider/model 路由。保存后创建新根会话，全局设置不会追溯授权旧会话。
5. 在新根会话中先执行 `/dsh-team plan`，核对成员创建／冲突计划；再执行 `/dsh-team launch`。plan 不验证模型授权或 effort；launch 执行原生准入检查并会调用模型。已有成员不会通过重复 launch 更新配置。

每名成员可独立修改以下字段：

| 配置项 | 字段 | 填写内容 |
| --- | --- | --- |
| Provider | `provider` | 原生 provider ID，例如 `codeagent` |
| 模型 | `model` | 本机实际配置的 model ID，不是界面显示名 |
| 推理强度 | `reasoning_effort` | 目标模型原生支持的 effort ID，默认 `max` |
| 持久角色提示词 | `persona_prompt` | 职责、协作规则与证据标准 |
| 首次启动输入 | `prompt` | 创建成员后发送的一次性输入 |

`max` 是否可用取决于目标模型的原生 adapter，不取决于 Windows 或 macOS。若 plan 成功而 launch 返回 `SESSION_ROUTE_NOT_AUTHORIZED`，检查模板中的 provider/model 是否属于该根会话的授权路由；`codeagent/<model>` 与 `deepseek-account/<model>` 是不同路由。对齐配置和授权后使用新根会话，不通过降低 effort 或重复旧会话 launch 来修复授权不匹配。

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
4. 在原生子智能体模型选择中允许所选路由，保存后再建新根会话，并在该会话首次 plan/launch 前加载配置。全局选项不会追溯授权旧会话。不要拿已经有成员的会话重复 launch 来应用新配置。

模型存在于配置中，不等于已获该根会话授权。launch 会读取该会话的原生 policy，并用原生 resolveCallConfig 检查两角色的路由与 effort，之后才修改 Team、创建任务或成员。路由解析失败、不支持的 max 或未授权路由都会返回失败，不自动换 provider、换模型或降低 effort；可显式改为该模型实际支持的 effort ID。某些 adapter 允许直接填写未列在目录中的远端模型 ID，元数据解析成功不代表远端执行成功。plan 只规划角色创建/冲突，不验证模型授权或输出模型清单。

## 两层提示词

- `persona_prompt`：角色 Preset 中持续生效的角色提示词，用于职责、协作规则和证据标准。
- `prompt`：首次启动时的一次性输入。默认只确认就绪，等待明确任务。

改提示词不会增加文件或 Shell 工具权限。能力仍受原生权限和 native_tool_allowlist 约束。配置修改后以新建团队为准；已有成员不会通过重复 launch 被替换。

## effort 与 token 预算

`max` 是原生 adapter 的 effort ID，不是无限 token。rc.3 仍保留首次启动 maxTokens1024；后续原生续接的 token 预算不由这项默认值保证。模板中的 effort 必须显式填写，rc.2 自定义模板中已有的 low 不会被偷偷改成 max；应由配置作者修改。
