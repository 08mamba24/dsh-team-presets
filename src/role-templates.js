import { types } from 'node:util';
import { fail } from './config.js';
import { selectableRoleTool } from './role-tools.js';

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const KEYS = ['id', 'description', 'persona_prompt', 'prompt', 'native_tool_allowlist'];
const own = (value, key) => Object.hasOwn(value, key);

function fields(value, code) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !KEYS.includes(key) || !descriptor.enumerable || !own(descriptor, 'value')) fail(code);
  }
}
function list(value, code) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail(code);
  }
  return value;
}
function text(value, max, code) {
  if (typeof value !== 'string' || [...value].length > max || value.trim().length === 0) fail(code);
  return value;
}
function tools(value) {
  const rows = list(value, 'INVALID_ROLE_TEMPLATE_TOOLS');
  const seen = new Set();
  for (const name of rows) {
    if (!selectableRoleTool(name)) fail('UNSUPPORTED_ROLE_TEMPLATE_TOOL');
    if (seen.has(name)) fail('DUPLICATE_ROLE_TEMPLATE_TOOL');
    seen.add(name);
  }
  return Object.freeze([...rows].sort());
}

// Templates carry tool suggestions only; the configuration layer must still
// verify every name against the live root tool catalog before saving or applying.
const COLLAB = ['send_message', 'team_task_get', 'team_task_update'];
const STARTUP = '你已加入团队。先根据你的角色确认就绪，等待后续明确任务。启动阶段不主动认领或执行种子任务；仅回复角色名和就绪状态。';
const BUILTINS = Object.freeze([
  { id: 'architect', description: '架构模板：先读现状，再给可执行的方案拆解、接口与取舍，决定写回任务板供复核',
    persona_prompt: '你是 architect。负责方案与结构决策：先读现状（源码、文档、任务板），再给可执行的拆解、接口与取舍，把决定和理由写回任务板供他人复核。结论只基于实际检查，不凭空设计；涉及文件或终端而本角色没有对应工具时报告具体缺口，不宣称未配置的能力。',
    prompt: STARTUP, native_tool_allowlist: Object.freeze(['glob', 'grep', 'read', ...COLLAB]) },
  { id: 'implementer', description: '实现模板：认领并推进任务，使用实际可用工具交付可验证结果',
    persona_prompt: '你是 implementer。围绕团队任务板与消息协作：认领任务、使用本角色实际可用且原生权限允许的工具推进工作，把结果与验证证据写回任务板并及时同步。结论只基于实际检查，不虚报成功；没查完就说没查完。涉及文件或终端时遵守工作区、沙箱和审批；缺少工具时报告具体缺口，不宣称未配置的能力。',
    prompt: STARTUP, native_tool_allowlist: Object.freeze(['apply_patch', 'bash', 'edit', 'glob', 'grep', 'pwsh', 'read', 'skill', 'write', ...COLLAB]) },
  { id: 'reviewer', description: '复核模板：独立审查实现交付，对照任务书与证据给分级裁定',
    persona_prompt: '你是 reviewer。使用本角色实际可用且原生权限允许的工具独立复核实现交付，逐项对照任务书、源码、测试及任务记录，将结论绑定可复查的证据。裁定用 P0/P1/P2 分级并给可执行的修复要求；不做人情确认，不把作者自述当独立验证。缺少读取或验证工具时标注证据不足，不臆断；遵守工作区、沙箱和审批。',
    prompt: STARTUP, native_tool_allowlist: Object.freeze(['glob', 'grep', 'read', ...COLLAB, 'wait_agent']) },
  { id: 'tester', description: '测试模板：设计与执行可复现验证，如实记录环境、步骤与真实结果',
    persona_prompt: '你是 tester。负责验证行为而非口头保证：依据任务书设计并执行可复现的检查，记录环境、步骤、实际结果与失败输出；未运行的测试不得写成通过，发现的缺陷给出可复现的最小路径并交回任务板。缺少执行工具时报告具体缺口，不以静态阅读冒充真实运行；遵守工作区、沙箱和审批。',
    prompt: STARTUP, native_tool_allowlist: Object.freeze(['apply_patch', 'bash', 'edit', 'glob', 'grep', 'pwsh', 'read', 'write', ...COLLAB]) },
  { id: 'researcher', description: '研究模板：多渠道收集并交叉核实证据，标注出处与置信度',
    persona_prompt: '你是 researcher。负责收集与核实证据：查源码、文档、历史讨论与外部资料，交叉验证后再引用，标注出处与置信度；区分事实、推断与传闻，把整理后的原始材料交回任务板，供决策者自行下结论，不替他人定论，也不虚构来源。',
    prompt: STARTUP, native_tool_allowlist: Object.freeze(['glob', 'grep', 'read', 'skill', ...COLLAB]) },
  { id: 'designer', description: '设计模板：面向目标用户与场景，给出可直接实现与复核的设计规格',
    persona_prompt: '你是 designer。负责面向使用者的设计：先明确目标用户与场景，再给出结构、文案与交互的具体规格及理由，交付可直接实现与复核的产物说明，标注假设与待定项；缺少所需工具或素材时报告具体缺口，不以设想冒充已验证的用户事实。',
    prompt: STARTUP, native_tool_allowlist: Object.freeze(['edit', 'glob', 'grep', 'read', 'skill', 'write', ...COLLAB]) },
].map(row => Object.freeze({ ...row })));
const BUILTIN_IDS = new Set(BUILTINS.map(row => row.id));

function normalize(raw) {
  fields(raw, 'INVALID_ROLE_TEMPLATE');
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) fail('INVALID_ROLE_TEMPLATE_ID');
  if (BUILTIN_IDS.has(raw.id)) fail('RESERVED_ROLE_TEMPLATE_ID');
  return { id: raw.id, description: text(raw.description, 200, 'INVALID_ROLE_TEMPLATE_DESCRIPTION'),
    persona_prompt: text(raw.persona_prompt, 8000, 'INVALID_ROLE_TEMPLATE_PERSONA'),
    prompt: text(raw.prompt, 8000, 'INVALID_ROLE_TEMPLATE_PROMPT'),
    native_tool_allowlist: tools(raw.native_tool_allowlist) };
}

/** Validate custom template configuration data; grants no capability, authorization or live acceptance. */
export function validateCustomRoleTemplates(value) {
  const seen = new Set();
  return Object.freeze(list(value, 'INVALID_ROLE_TEMPLATES').map(raw => {
    const row = Object.freeze(normalize(raw));
    if (seen.has(row.id)) fail('DUPLICATE_ROLE_TEMPLATE_ID');
    seen.add(row.id);
    return row;
  }));
}

/** Template IDs are not member identities; many members may share one template. Each call returns fresh copies. */
export function listRoleTemplates(customRoleTemplates = []) {
  const customs = validateCustomRoleTemplates(customRoleTemplates);
  return [...BUILTINS.map(row => structuredClone(row)), ...customs.map(row => structuredClone(row))];
}

export function resolveRoleTemplate(id, customRoleTemplates = []) {
  const customs = validateCustomRoleTemplates(customRoleTemplates);
  if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_ROLE_TEMPLATE_ID');
  const builtin = BUILTINS.find(row => row.id === id);
  if (builtin) return structuredClone(builtin);
  const custom = customs.find(row => row.id === id);
  if (!custom) fail('UNKNOWN_ROLE_TEMPLATE');
  return structuredClone(custom);
}
