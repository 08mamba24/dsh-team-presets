# Windows 安装与验收

`0.6.0-rc.1` 候选支持 1–8 个独立成员、六种内置职责模板和自定义模板，同一职责模板可用于多个成员。每个成员有独立模型、提示词、工具集、Preset 和 Session，并保留 rc.7 的 Standby 替换及持久退役。目标宿主为官方 **DeepSeek Harness 0.2.2-rc.5 Windows x64**；effort 默认 `max`。macOS 既有支持继续保留，本次没有新增 Ubuntu 支持。当前候选的安装验收以对应提交的 Actions 回执为准，历史 rc.7 结果不替代它。

## 安装候选

1. 从 [0.6.0-rc.1 发行页](https://github.com/08mamba24/dsh-team-presets/releases/tag/v0.6.0-rc.1)下载 `dsh-subagent-live-rc2-local-0.6.0-rc.1.tgz` 与同名 `.sha256` 文件。该包与[合入后 Windows 验收](https://github.com/08mamba24/dsh-team-presets/actions/runs/45040445737)实际安装的 TGZ 完全一致。旧 `v0.5.0-rc.7` 发行资产保留为迁移基线。
2. 在 Harness 官方插件管理器安装完整 TGZ。默认组件使用当前会话；无需填写 Session ID 或运行 prepare。若已有旧个人绑定包，保留原组件及 Preset，先核对迁移方案，避免已有成员失去预设。
3. 在 Agent 会话说“使用 dsh-team-configure，帮我配置团队模型、effort 和工具集”，按 [模型与提示词](MODELS-AND-PROMPTS.md) 选择实际模型并保存。skill 随插件全局注册到该 profile，不需要每个项目单独安装。
4. 在原生子智能体模型选择中授权所需路由，保存后使用新根会话。执行 `/dsh-team plan` 核对创建／冲突计划，再执行 `/dsh-team launch`。plan 不调用模型；launch 会调用模型，并由原生 policy/adapter 再次校验。

已有团队需要换成员时，在原根会话使用 `dsh-team-replace`，先 inspect，再绑定当前成员 ID 进行 replace；失败后对原 operationId recover。候选尚未创建或尚无 owner 写入意图时可明确 cancel。用 `dsh-team-configure` 保存新默认值不会修改已有团队。详见[替换流程](../README.zh-CN.md#替换空闲成员)。手工编辑配置须保留完整 `replacementRecords`，否则管理中的成员会被拒绝执行。

运行中增员使用 `add` 并提供完整成员配置；仅填写 `role` 不会替代必需的模型、persona、prompt 和工具字段。配置器可先查询职责模板、生成新成员并预览保存。移除使用 `remove` 的 `name` 参数，先完成或明确改派该成员的未完成责任，包括尚未 claim 的种子任务。失败增员的名字仍被持久保留，不应同名自动重试。

如果 workflow 还没有成功结果，则此候选还没有 Windows 实跑证据，不应把源码检查当成安装验收。已发布的 `v0.5.0-rc.2` 只支持 macOS，不含 Windows 适配或默认 max 改动。

Windows 的应用目录从运行中的 `DeepSeek Harness.exe` 定位，支持带空格的安装路径、用户目录安装与 Program Files 安装。插件同时核对物理 `resources/app.asar` SHA256 和原生模块版本；未知归档继续拒绝加载。指纹见 [支持矩阵](HOST-COMPATIBILITY.md)。

如需在普通 Node 中检查安装目录：

```powershell
npm run check:compat -- --app-executable "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
```

路径以实际安装位置为准。`--upstream` 可选，需要已安装 `gh`；不加该参数时不会联网。

## 安装后修改模型和 effort

候选版推荐使用会话 skill，可逐成员修改 provider、model、effort、职责、提示词与工具集，预检并持久保存；它不授权模型、不启动或暗改已有成员。可配置 1–8 个成员，多个成员可使用同一个职责模板。新增内置模板成员且未指定工具列表时，建议与当前根工具目录取交集并显示在预览；显式列表（含空列表）、已存成员和自定义模板保持原样。已有 rc.7 团队保留原绑定，扩员需要显式 add；没有专用模型选择表单。

手动方式的默认路径为 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`；自定义 `DSH_HOME` 或 profile 时使用实际路径。

按 [Windows 手动配置步骤](MODELS-AND-PROMPTS.md#windows-manual-configuration) 修改，或从 [完整用户配置补丁](examples/windows-team-config.patch.yml) 开始填写。每个成员可独立设置 `provider`、`model` 和 `reasoning_effort`；effort 默认 `max`，实际支持范围由目标模型的原生 adapter 验证。示例里的两个 model ID 都是待替换占位符。

保留原文件的其他条目和组件的既有选项。配置生效、原生模型选择授权保存后，新建根会话再 plan/launch；重复 launch 不会给已有成员更换模型。修改用户配置无需重新打包或安装插件。

## GitHub Actions 证明什么

工作流只用 `windows-2022` x64 runner，不需要仓库 secret 或模型账号：

- 运行独立源码的 Node 测试并打包；历史 macOS 文件权限用例明确显示 skip，当前会话、模板、控制路径和原生契约模拟照常执行。
- 下载固定官方 Windows 安装器，校验安装器与 ASAR SHA256，解出完整官方应用。该步骤验证官方 payload，不测试 NSIS 安装向导或注册表集成。
- 使用官方初始化函数创建隔离 profile；先安装固定 rc.5 基线并确认旧 skill，再使用安装包自带 CLI 升级 TGZ，重载 Host 后确认只有一份新版 skill。
- 调用原生 `/dsh-team plan`，检查命令结果与持久事件，断言没有模型 turn 或成员／任务创建。
- 检查配置 skill 对根会话可见，通过原生设置 RPC 保存模板，验证当前已绑定根不变、新根采用新模板；不通过付费模型驱动工具。
- 正常停止并重启 Host，被动回读命令记录；再用官方 CLI 卸载插件，重启确认命令消失。
- 重启后回读已保存模板及配置、替换两个 skill，卸载后确认两个 skill 同时消失。
- 在官方 Electron 中执行已安装 TGZ 的原生准入、profile 持久化和完整替换脚本。使用本地 scripted provider 与独立临时 Session/profile，覆盖 Standby、真实任务改派／写回、失败同候选恢复、多任务部分移交、依赖拒绝、取消及完整 Loader 重载；无账号或远程推理。另下载并校验固定 rc.6 包，以未改旧实现通过原生 Commands 建队，再分别验证原默认值自动迁移、默认值改变后验证 adopt 的完整链路。
- 在官方 Electron 内导入真实 ToolsService、原生执行器、Scope 与 SkillRegistry，验证角色工具隔离、临时文件读写、父级限制、最终拒绝及旧 skill 缓存替换；该探针使用隔离身份和临时文件处理函数，不声称验证了 OS 沙箱后端。
- 在同一原生工具管线验证稳定角色的消息、列表、任务 owner 寻址；完整替换脚本还通过真实 manager 和 JSONL 验证首次、再次替换与冷重载后的实际消息投递。
- 执行已安装包的 `accept-native-multi-role.mjs`：真实配置工具查询六模板、预览两成员变四成员、原生审批拒绝与确认、自定义模板保存；验证同模板不同模型及工具、运行中热保存不重挂载、增员及失败保留、种子任务责任、任意名及新增成员替换、移除后冷恢复准入。固定并校验已发布 rc.7 TGZ，以其原实现建队后升级，保留原 Settings/JSONL 并显式增员。

`windows-host-<commit>` artifact 保存 `artifact.json`、`acceptance.json`、`native-admission.json`、`native-replacement-store.json`、`native-team-addressing.json`、`native-replacement.json`、`native-multi-role.json` 与有界日志。`acceptance.json.status=passed` 才表示上述 Host 链路全部通过；核对新回执的 `sourceHead` 与该次已安装 TGZ 摘要，不能混用不同提交的结果。TGZ artifact 只在全部步骤成功时上传。临时 profile、账号目录和原始会话文件不上传。

**这不证明 Windows GUI 操作、模型驱动的完整 skill 对话、实际 provider 的 effort 元数据解析或付费模型协作已经通过。** 原生配置链使用本地脚本化审批响应，多成员模型使用本地 scripted provider；并发冲突、取消和写入不确定分支另有隔离回归。真实模型行为仍需明确授权的测试账号与预算，不能引用历史 macOS low-effort 结果代替。

## 旧入口边界

历史 `/dsh-subagent-live`、`/dsh-team-live`、显式绑定的 `/dsh-team-launcher` 与离线 prepare 依赖 POSIX 所有权／权限位，仅保留 macOS 支持。Windows 返回 `LEGACY_BOUND_ENTRY_REQUIRES_MACOS`；不要改权限检查来强行使用。Windows 使用通用 TGZ 的 `/dsh-team` 当前会话入口。

## 在独立 Windows 环境复现

需要 Node.js 22+、npm 和 PATH 中的 7-Zip；指定一个尚不存在的临时目录：

```powershell
npm test
./scripts/accept-windows.ps1 -WorkDir "$env:TEMP/dsh-team-acceptance-new"
```

脚本从官方站点下载约 300 MB 安装器。子进程使用新的 OS home、DSH home、agents home 与 workspace，不继承账号密钥，也不读日常 profile。重复执行须另选空目录，以保留前次证据。
