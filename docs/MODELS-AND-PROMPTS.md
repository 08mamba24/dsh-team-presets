# 修改 provider、模型、effort 与提示词

**当前需要手动编辑用户 profile 的 `cordis.patch.yml`。** rc.4 没有可直接选择 provider、模型和 effort 的模板表单；“支持配置”指组件读取这些字段。修改用户配置即可，无需改安装目录的文件或重新打包插件。

rc.4 包含 rc.3 的配置改动：默认成员为 implementer（deepseek-account/deepseek-flash）与 reviewer（deepseek-account/deepseek-v4-pro），两者默认 effort 为 max。各角色可以独立选 provider、model 和 effort，也可以使用相同模型；这不代表使用了不同后端权重。

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
