# Legacy bound installation (0.4)

This historical file-bound workflow is macOS-only. On Windows use the current-session `/dsh-team` entry described in [WINDOWS.md](WINDOWS.md). The prepare command and bound-file readers reject Windows before using POSIX ownership checks.

This historical flow uses the explicit bound launcher export. The 0.5 generic bundle uses the current-session entry; follow the repository README for a new installation. Existing bound installations need a checked migration before replacement.

## 一次性准备

需要 Node.js 22 或更新版本、npm，以及一个**已经存在**的 Harness 根会话。准备好该会话准确的 `session-…` ID 和工作目录。会检查工作目录及父路径权限，共享可写目录会被拒绝；准备期间不要移动或替换目录。该会话的原生 Session policy 必须允许模板里的模型路由；模板或安装本插件都不会授予模型权限。rc.3 起两角色可选择相同路由，provider/model/effort 的支持情况由原生配置验证。

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

rc.3 默认模板使用 max；启动预算仍为每角色最多一次普通 stream、maxTokens1024，这不是总 token 或金额上限。自定义模板显式填写各角色的 reasoning_effort，原生 adapter 不支持时会拒绝。模板里的种子任务默认只作为就绪后的工作背景，启动不会要求自动完成业务任务。

只有准备命令以退出码 `0` 完成，且最终 `PREPARED.json` 的状态为 `PREPARED_FOR_OFFICIAL_INSTALL`，才能进入安装步骤。如果准备过程中报告部分完成，先按错误报告核对已创建的文件；不要仅凭某个文件存在就安装。不要覆盖、删除既有标记或盲目重跑。准备成功只证明本地文件与打包合同成立，不证明 Session 存在、模型已获授权或真实运行成功。

`PARTIAL_PREPARATION`仅表示workspace已有本次创建的文件；其他失败也可能留下输出目录产物，始终核对报告中的`outputDir`与`createdWorkspacePaths`。目录检查不隔离恶意同UID进程；收据完整写入后的原子发布也不代表完整断电恢复保证。

## 安装与启动

1. 在 Harness 官方插件管理器中，选择准备命令生成的**本地绑定 TGZ**。不要安装另一会话的绑定包。与其他任务共享 Desktop/profile 时，先协调操作窗口。
2. 回到准备时指定的同一会话，执行 `/dsh-team-launcher plan`，核对角色创建／冲突计划。路由从模板检查，目录从当前原生会话核对；plan 不输出这些值，也不验证模型授权，launch 才执行原生 policy 与路由解析准入。`plan` 不创建或唤醒成员。
3. 确认计划符合预期后，执行 `/dsh-team-launcher launch`。已有同名成员且配置无法确认时会返回冲突，并保留成员 ID；不会自动复用或重复唤醒。
4. 仅在原操作恢复权仍在、根会话无排队输入、原根与成员空闲且未被替换、完整任务板自启动结束后未变时，可执行 `/dsh-team-launcher restore` 恢复之前的 Team 模式。业务写回改变任务 revision、状态或描述后会拒绝，成员条件也可能更早拒绝；不能承诺工作结束后恢复成功。冲突时保留现场与当前模式，停止自动补偿，不清空任务、倒改依赖或重跑来强行恢复。成员 Session 和原生任务记录会保留。
5. 等待所有本插件操作和子成员结束，再经官方管理器正常卸载。出现 `draining`、`pending`、`restart-required` 或并发冲突时停止后续修改，不强卸守卫或重启规避。

`restore` 只恢复受本次操作约束的模式，不删除历史会话、任务、模板或标记。修改模板或切换会话需要新的准备与配置审查；不要改写已消费的验收标记。

