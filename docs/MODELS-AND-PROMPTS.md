# 修改默认模型与提示词

rc.3 的默认成员为 implementer（deepseek-account/deepseek-flash）与 reviewer（deepseek-account/deepseek-v4-pro），两者默认 effort 为 max。两名角色可以使用相同模型；这不代表使用了不同后端权重。

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
