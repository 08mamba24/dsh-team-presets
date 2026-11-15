# DSH 团队预设与一键建队

为 implementer、reviewer 分别设置模型、持久角色提示词和原生团队工具，再在现有 DeepSeek Harness 会话中执行一次 `launch` 创建团队，无需逐个切换主会话模型。

## 版本与支持范围

- **0.3.2 已完成首版限定实机验收**：双角色首次建队并就绪、重复启动安全冲突、恢复原 Team 模式、官方正常卸载和环境恢复；独立裁定为 Pro 1183。
- **0.4.0-rc.1 已通过独立差分复审1284，仅覆盖离线准备与PRIVATE候选**。作者本地测试193/193通过；Pro独立核实际包与源码，没有运行Node测试。本候选尚未做新的Harness安装或模型实测。
- 当前仅支持 macOS、固定的 Harness `0.2.2-rc.2` App 及归档校验值。App 升级或替换后会拒绝加载，不会自动放宽检查。
- 能力限于模板声明的原生任务与消息工具，不包含文件或 shell 工具。正向复用已有成员、冷恢复和复杂业务续接尚未实机验收。

## 一次性准备

需要 Node.js 22 或更新版本、npm，以及一个**已经存在**的 Harness 根会话。准备好该会话准确的 `session-…` ID 和工作目录。会检查工作目录及父路径权限，共享可写目录会被拒绝；准备期间不要移动或替换目录。该会话的原生 Session policy 必须允许模板里的两条不同模型路由；模板或安装本插件都不会授予模型权限。

**Session ID由用户提供，离线prepare不验证其存在或原生授权。** 这些条件仍由安装后的原生运行准入检查，准备成功不能替代它们。

1. 下载通用 TGZ 并解压，进入解压得到的 `package` 目录。这个通用包不含任何用户会话绑定。尚未配置时，直接安装只会得到惰性的 launcher，不会创建成员。
2. 复制 `examples/team-template.json` 为自己的模板，编辑两名成员的 `provider`、`model`、`persona_prompt`、启动 `prompt` 与 `native_tool_allowlist`。示例使用 Flash／Pro；实际可用性由原生配置和 policy 决定。
3. 执行离线准备命令，把占位参数替换为自己的现有会话：

```sh
node scripts/prepare-launcher.mjs \
  --session-id 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' \
  --workspace '/absolute/path/to/project' \
  --template './my-team.json' \
  --output-dir '../prepared-team'
```

输出目录必须位于解压的 `package` 目录之外；上例使用它的同级目录。准备命令不会启动 Harness、安装插件、修改 profile 或调用模型。它校验模板，以独占方式在指定工作目录创建 `.dsh-team-template.json` 和 `.dsh-team-launcher.json`，并输出绑定该会话的本地安装包与准备收据。模板和标记文件为 `0600`，输出目录为 `0700`；已有同名文件或输出目录会被拒绝，不会覆盖。

默认启动预算为每角色最多一次普通 stream、low、maxTokens1024；这不是总 token 或金额上限。模板里的种子任务默认只作为就绪后的工作背景，启动不会要求自动完成业务任务。

只有准备命令以退出码 `0` 完成，且最终 `PREPARED.json` 的状态为 `PREPARED_FOR_OFFICIAL_INSTALL`，才能进入安装步骤。如果准备过程中报告部分完成，先按错误报告核对已创建的文件；不要仅凭某个文件存在就安装。不要覆盖、删除既有标记或盲目重跑。准备成功只证明本地文件与打包合同成立，不证明 Session 存在、模型已获授权或真实运行成功。

`PARTIAL_PREPARATION`仅表示workspace已有本次创建的文件；其他失败也可能留下输出目录产物，始终核对报告中的`outputDir`与`createdWorkspacePaths`。目录检查不隔离恶意同UID进程；收据完整写入后的原子发布也不代表完整断电恢复保证。

## 安装与启动

1. 在 Harness 官方插件管理器中，选择准备命令生成的**本地绑定 TGZ**。不要安装另一会话的绑定包。与其他任务共享 Desktop/profile 时，先协调操作窗口。
2. 回到准备时指定的同一会话，执行 `/dsh-team-launcher plan`，核对两角色、模型与冲突情况。`plan` 不创建或唤醒成员。
3. 确认计划符合预期后，执行 `/dsh-team-launcher launch`。已有同名成员且配置无法确认时会返回冲突，并保留成员 ID；不会自动复用或重复唤醒。
4. 工作结束后执行 `/dsh-team-launcher restore`，恢复之前的 Team 模式。成员 Session 和原生任务记录会保留。
5. 等待所有本插件操作和子成员结束，再经官方管理器正常卸载。出现 `draining`、`pending`、`restart-required` 或并发冲突时停止后续修改，不强卸守卫或重启规避。

`restore` 只恢复受本次操作约束的模式，不删除历史会话、任务、模板或标记。修改模板或切换会话需要新的准备与配置审查；不要改写已消费的验收标记。

## 下载与隐私

源码已推送到 [08mamba24/dsh-team-presets](https://github.com/08mamba24/dsh-team-presets)，[0.4.0-rc.1 私有候选下载](https://github.com/08mamba24/dsh-team-presets/releases/tag/v0.4.0-rc.1)已提供通用TGZ与SHA256SUMS。需要登录有仓库权限的GitHub账号；尚未公开发行。`prepared-team` 中的绑定安装包、配置和收据，以及工作目录中的模板与标记，都属于本地会话产物，不作为发行资产上传。

不要上传 profile、凭据、原始会话日志或个人生成的绑定包。源码与发布树的审查、离线测试、真实运行验收分别记录，不能互相替代。

## 验证

源码目录运行 `npm test`。测试覆盖离线准备、配置拒绝、打包入口及模拟 Host 下的运行守卫；测试不会代替真实 Harness／provider 验收。RC安装包保持送审时的冻结字节，包内README是当时快照；本仓库README与发行页记录后续1284裁定和下载状态，不改写已审TGZ。
