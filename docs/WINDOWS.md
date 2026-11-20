# Windows 安装与验收

`0.5.0-rc.4` 是 Windows x64 候选，同时包含默认 `max` 与可配置模型改动。目标宿主为官方 **DeepSeek Harness 0.2.2-rc.5 Windows x64**。macOS 既有支持继续保留；本次没有新增 Ubuntu 支持。

## 安装候选

1. 打开本仓库 [Windows plugin acceptance](https://github.com/08mamba24/dsh-team-presets/actions/workflows/windows.yml)，选择对应提交的成功运行。下载 `windows-plugin-<commit>` artifact，解压得到 `dsh-subagent-live-rc2-local-0.5.0-rc.4.tgz`。需要有本私有仓库访问权限的 GitHub 账号。
2. 在 Harness 官方插件管理器安装完整 TGZ。默认组件使用当前会话；无需填写 Session ID 或运行 prepare。若已有旧个人绑定包，保留原组件及 Preset，先核对迁移方案，避免已有成员失去预设。
3. 在目标会话执行 `/dsh-team plan`。它应列出 implementer、reviewer 的创建或冲突计划，不调用模型。
4. 按 [模型与提示词](MODELS-AND-PROMPTS.md) 配置实际可用的 provider/model；在原生子智能体模型选择中授权所需路由，保存后使用新根会话。确认计划后执行 `/dsh-team launch`。这一步会调用模型，并由原生 policy/adapter 再次校验。

如果 workflow 还没有成功结果，则此候选还没有 Windows 实跑证据，不应把源码检查当成安装验收。已发布的 `v0.5.0-rc.2` 只支持 macOS，不含 Windows 适配或默认 max 改动。

Windows 的应用目录从运行中的 `DeepSeek Harness.exe` 定位，支持带空格的安装路径、用户目录安装与 Program Files 安装。插件同时核对物理 `resources/app.asar` SHA256 和原生模块版本；未知归档继续拒绝加载。指纹见 [支持矩阵](HOST-COMPATIBILITY.md)。

如需在普通 Node 中检查安装目录：

```powershell
npm run check:compat -- --app-executable "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
```

路径以实际安装位置为准。`--upstream` 可选，需要已安装 `gh`；不加该参数时不会联网。

## GitHub Actions 证明什么

工作流只用 `windows-2022` x64 runner，不需要仓库 secret 或模型账号：

- 运行独立源码的 Node 测试并打包；历史 macOS 文件权限用例明确显示 skip，当前会话、模板、控制路径和原生契约模拟照常执行。
- 下载固定官方 Windows 安装器，校验安装器与 ASAR SHA256，解出完整官方应用。该步骤验证官方 payload，不测试 NSIS 安装向导或注册表集成。
- 使用官方初始化函数创建隔离 profile，使用安装包自带 CLI 安装 TGZ，再启动真实 Desktop Host。
- 调用原生 `/dsh-team plan`，检查命令结果与持久事件，断言没有模型 turn 或成员／任务创建。
- 正常停止并重启 Host，被动回读命令记录；再用官方 CLI 卸载插件，重启确认命令消失。

`windows-host-<commit>` artifact 保存 `artifact.json`、`acceptance.json` 与有界日志。`acceptance.json.status=passed` 才表示上述 Host 链路全部通过；TGZ artifact 只在全部步骤成功时上传。临时 profile、账号目录和原始会话文件不上传。

**这不证明 Windows 上的 GUI 操作、双模型建队或后续协作已经通过。** 这些需要另用明确授权的测试账号与预算执行，不能引用历史 macOS low-effort 结果代替。

## 旧入口边界

历史 `/dsh-subagent-live`、`/dsh-team-live`、显式绑定的 `/dsh-team-launcher` 与离线 prepare 依赖 POSIX 所有权／权限位，仅保留 macOS 支持。Windows 返回 `LEGACY_BOUND_ENTRY_REQUIRES_MACOS`；不要改权限检查来强行使用。Windows 使用通用 TGZ 的 `/dsh-team` 当前会话入口。

## 在独立 Windows 环境复现

需要 Node.js 22+、npm 和 PATH 中的 7-Zip；指定一个尚不存在的临时目录：

```powershell
npm test
./scripts/accept-windows.ps1 -WorkDir "$env:TEMP/dsh-team-acceptance-new"
```

脚本从官方站点下载约 300 MB 安装器。子进程使用新的 OS home、DSH home、agents home 与 workspace，不继承账号密钥，也不读日常 profile。重复执行须另选空目录，以保留前次证据。
