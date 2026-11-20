# DSH 团队预设与一键建队

在 DeepSeek Harness 的目标会话中，一次创建 implementer 和 reviewer，为两者分别配置模型路由、持久角色提示词与原生任务／消息工具。

**当前源码：0.5.0-rc.4 Windows 候选。** 两个默认角色均使用 `max` effort；模型和 effort 由实际配置的原生 adapter 验证，不再受插件的模型名单限制。本次更新尚未进行付费实机运行。已发布的 0.5.0-rc.2 在 2026-11-19 通过了 macOS Harness rc.5 的独立实机复核，当时使用 low；该结果仍只覆盖 rc.2。[验收范围与已知限制](docs/ACCEPTANCE.md)。

Windows x64 适配面向已检查的 Harness 0.2.2-rc.5 和当前会话 `/dsh-team` 入口，见 [Windows 安装与 CI 验收](docs/WINDOWS.md)。旧的本地文件绑定入口仍只支持 macOS。

## 下载与安装

在本源码包目录执行以下命令，生成 rc.4 Windows 候选：

```sh
npm pack
```

在 Harness 官方插件管理器中安装生成的 `dsh-subagent-live-rc2-local-0.5.0-rc.4.tgz`。打包不会更新已安装副本。0.5 通用包默认注册当前会话入口，无需填写 Session ID，也无需运行离线绑定准备命令。已有旧版个人绑定包时，先核对保留原组件和 Preset 的迁移方案，避免旧成员失去预设。此前仅面向 rc.2 的 0.5.0-rc.1 sidecar 不是 rc.5 安装源。

[已发布的 v0.5.0-rc.2 私有预发行](https://github.com/08mamba24/dsh-team-presets/releases/tag/v0.5.0-rc.2) 保持原先实机验收时的 low 配置，不包含本次 max 更新。该插件未发布到 npm 或插件市场。包名中的 `rc2-local` 是历史名称。

## 允许两条模型路由

默认模板使用：

| 角色 | provider/model | 原生工具 |
| --- | --- | --- |
| implementer | `deepseek-account/deepseek-flash` | `team_task_get`、`team_task_update`、`send_message` |
| reviewer | `deepseek-account/deepseek-v4-pro` | `team_task_get`、`team_task_update`、`wait_agent` |

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

这一步会调用模型，创建两个角色并让其确认就绪。种子任务保持待处理，业务工作需要另外下达。每个根会话有独立的角色 Preset；同一安装可以服务不同的根会话。

再次执行 `launch` 时，已有同名成员会触发 `LAUNCHER_MEMBER_CONFLICT` 等冲突结果。本次实测保留原成员与任务，零新增、零唤醒、零模型步骤。它是重复保护，不表示已经实现同名成员的等价复用。

命令结果可能显示为可展开的命令记录。首条结果未及时出现的现象仍未定位；先检查命令记录／轨迹，不要通过追加问候或重复 `launch` 来判断是否安装成功。

## 给现有成员分配任务

本模板提供原生任务板与成员消息工具，未配置文件或 shell 能力。可先分配一个能通过任务板验真的小任务。工作顺序应当是：

1. Lead 只分配可执行的实现任务。
2. implementer 写回证据、完成实现任务，再向 reviewer 交接实际任务 ID。
3. reviewer 读取实际任务，确认前置任务已 completed、执行阻塞解除且依赖边仍保留，然后领取复核任务，独立验证并写回结果。
4. 工具拒绝时停止并报告；保留依赖，不通过清空依赖来强行分配。

实机完成了 `17 × 23 = 391` 的写回、直接交接与另一种算法复核。验收中 Lead 曾在任务被阻塞后临时移除并恢复依赖，这是保留的 P2 编排偏差；严格指令遵循未通过。上述澄清后的工作顺序尚未另行实机执行。

## 配置、恢复与限制

`examples/team-template.json` 是完整两角色模板。可在当前组件配置中将可选 `template` 替换为同格式对象，调整角色提示词、模型、启动提示与原生工具白名单。组件支持 `timeoutMs` 和每角色 `maxStreams`；默认每角色一次普通启动 stream，可配置 1～12 次。模板只表达配置，真实准入仍由原生 policy 和工具权限决定。逐字段说明见[修改模型与提示词](docs/MODELS-AND-PROMPTS.md)。

默认模板的 `reasoning_effort` 已改为 `max`，也可逐角色填入其原生模型支持的 effort ID。两名角色可以使用同一个 provider/model。原生 `resolveCallConfig` 会在修改 Team 或创建成员前拒绝路由解析失败、不支持的 effort，不会偷偷降档；元数据检查不代表远端模型一定执行成功。启动请求的 `maxTokens=1024` 是独立限制，不是团队生命周期、总 token 或金额上限；历史 rc.2 验收中的后续任务和自我介绍曾使用 `maxTokens=256000`。本次更新不修改续接 token 预算。

```text
/dsh-team restore
```

该命令仅在原操作的恢复权限仍在、根会话无排队输入、原根与成员均空闲且未被替换、完整任务板自启动结束后保持不变时，才可还原先前 Team 模式。普通业务写回会改变任务 revision、状态或描述，导致 `RESTORE_BOARD_CONFLICT`；成员条件不满足时可能更早拒绝。因此，业务完成后不能承诺 `restore` 成功。遇拒绝应保留当前 Team 模式与证据，停止自动补偿；不要清空任务、倒改依赖或重跑工作来强行恢复。命令保留成员和任务。插件或 Host 重载后，应先在原根会话执行 `plan` 重建角色预设注册；它不会重建先前的内存恢复权限。本次没有验收完整冷恢复、正向成员复用、自动 Lead 唤醒或所有部分失败恢复路径。卸载使用官方管理器，等待已有操作和成员结束。

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
