---
name: dsh-team-configure
description: 在 DSH Agent 会话中查看可用模型，配置实现和复核角色的 provider、模型、effort 与提示词，预检并保存团队默认模板。用于配置或调整团队，不自动启动成员。
---

# 配置 DSH 团队

使用插件提供的 `dsh_team_configure` 工具完成配置，无需用户手工编辑 YAML。该 skill 在安装插件的 Harness profile 中对所有根会话可用，需要插件 0.5.0-rc.5 或更新版本。

例如：“实现角色用 codeagent 的模型 A，复核角色用模型 B，两者 max；复核时先核查证据。”模型名先解析成工具返回的真实 ID。保留当前两角色的稳定 ID `implementer` / `reviewer`；职责通过 description 与 persona_prompt 表达。

1. 调用 `action: inspect` 读取当前模板、配置 revision、本机 provider 和当前根会话授权路由。仅当用户选择的模型 ID 不明确时，调用 `action: models` 查询相应 provider。只询问影响配置的缺失选择，不索取整份 profile、凭据或全部模型的 effort。
2. 以用户要求生成 `members` 局部修改。支持 provider、model、reasoning_effort、description、persona_prompt、prompt；保留其他角色字段、工具与种子任务。未要求修改的 effort 保持原值；新模板默认 max。用户要求任意新角色数量或替换现有成员时，说明当前执行器只支持实现/复核两角色，不把提示词改名当成新增角色功能。
3. 使用 inspect 的 `expectedRevision` 调用 `action: preview`。工具用原生 adapter 检查明确修改的模型路由与 effort；仅修改提示词时无需查询模型元数据。不支持的 effort 或模型解析失败应报告，不能自动换 provider、换模型或降档。元数据通过不代表远端模型已执行。
4. 用户已明确要求修改时，使用相同 members、revision 和 preview 的 `expectedFingerprint` 调用 `action: apply`，无需重复索取同一配置授权。工具仍遵循 Harness 原生的本次操作审批；审批拒绝、取消或 revision 冲突后停止，不手工编辑文件绕过。用户只是询问方案时停在 preview。
5. 只有返回 `persisted: true` 才报告已保存。给出各角色的 provider/model/effort 和简要提示词变化，说明这是当前 profile 中尚未绑定团队的根会话默认值，已有成员未被修改。

配置不会扩大模型授权。若 currentSessionAuthorization 有 false，需要用户在原生子智能体模型选择中授权所需路由，保存后创建新根会话。若 currentSessionNeedsNewRoot 为 true，旧根已固定模板，也应使用新根。全局选项不会追溯修改旧会话 policy。

已绑定根的模板固定在当前 Host 生命周期内。完整 Host 重启后的旧成员冷恢复尚未验收；不要承诺新默认值能修改旧成员，或在改默认值后用旧根的 plan/launch 迁移旧团队。

只配置不调用模型、不创建成员、不执行 launch。用户另外要求启动时，再按原生 plan/launch 流程处理。不要用重复 launch 更换已有成员。写入结果不确定时先报告并用 inspect 核对，不自动重试、回滚或删除配置。

若 `dsh_team_configure` 不存在，说明当前环境未安装或加载相应插件，报告这个缺口；不要把临时手改配置冒充 skill 已成功执行。
