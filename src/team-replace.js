import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fail } from './config.js';
import { parseReplacementRequest, REPLACEMENT_CHILD_ID } from './member-replacement.js';

const codeOf = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'TEAM_REPLACEMENT_FAILED';
const ID = REPLACEMENT_CHILD_ID;
const MEMBER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Root-only Agent entry. The native tool pipeline still owns permissions. */
export async function applyTeamReplacement(ctx, launcher, { defineTool }) {
  if (typeof defineTool !== 'function' || typeof launcher?.replacement !== 'function'
    || typeof ctx.tools?.register !== 'function' || typeof ctx.skills?.register !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  let closing = false;
  ctx.effect(() => () => { closing = true; });
  ctx.tools.register(defineTool({
    name: 'dsh_team_replace',
    description: 'Manage members of this root team by stable member name. inspect lists the roster; replace swaps one idle member for explicit model/effort/persona/prompt/tools; add creates one new member (complete template member object) in the launched team; remove retires one quiet member with no unfinished tasks; recover/cancel an existing replacement; adopt authenticates an original legacy template. Preserves other members, task IDs, dependencies and history. Replace and add call the member model; native authorization, sandbox and approvals remain in force. Inspect first and bind expectedOldChildId for replace.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'replace', 'recover', 'cancel', 'adopt', 'add', 'remove'] },
      member: { type: 'object', additionalProperties: true,
        description: 'For add: one complete template member (name, description, prompt, persona_prompt, provider, model, reasoning_effort, native_tool_allowlist; optional role). Its Preset id is assigned per root.' },
      name: { type: 'string', description: 'For remove: stable member name returned by inspect.' },
      template: { type: 'object', additionalProperties: true,
        description: 'For adopt: exact original legacy team template, authenticated against its retained native launch fingerprint.' },
      role: { type: 'string', description: 'For replace: stable member name returned by inspect.' },
      expectedOldChildId: { type: 'string', description: 'For replace: exact current member id returned by inspect.' },
      operationId: { type: 'string', description: 'For recover: existing operation id returned by inspect or replacement.' },
      provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' },
      personaPrompt: { type: 'string' }, prompt: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } }, progressFacts: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      try {
        if (closing) fail('UNLOADING');
        exec.signal.throwIfAborted();
        launcher.assertRoot(exec.agent);
        if (!args || typeof args !== 'object' || Array.isArray(args)) fail('REPLACEMENT_REQUEST_INVALID');
        const { action, expectedOldChildId, operationId, ...input } = args;
        let request;
        if (action === 'replace') {
          if (operationId !== undefined || !ID.test(expectedOldChildId ?? '')
            || typeof input.role !== 'string' || !MEMBER_NAME.test(input.role) || input.role === 'lead') fail('REPLACEMENT_REQUEST_INVALID');
          request = { action, expectedOldChildId, request: parseReplacementRequest(input) };
        } else if (action === 'add') {
          if (Object.keys(args).length !== 2 || !args.member || typeof args.member !== 'object' || Array.isArray(args.member)) fail('MEMBER_REQUEST_INVALID');
          request = { action, request: { member: args.member } };
        } else if (action === 'remove') {
          if (Object.keys(args).length !== 2 || typeof args.name !== 'string' || !MEMBER_NAME.test(args.name) || args.name === 'lead') fail('MEMBER_REQUEST_INVALID');
          request = { action, request: { name: args.name } };
        } else if (action === 'adopt') {
          if (Object.keys(args).length !== 2 || !args.template) fail('REPLACEMENT_REQUEST_INVALID');
          request = { action, originalTemplate: args.template };
        } else if (action === 'recover' || action === 'cancel') {
          if (Object.keys(args).length !== 2 || typeof operationId !== 'string'
            || !/^replace-[0-9a-f-]{36}$/.test(operationId)) fail('REPLACEMENT_REQUEST_INVALID');
          request = { action, operationId };
        } else if (action === 'inspect' && Object.keys(args).length === 1) request = { action };
        else fail('REPLACEMENT_REQUEST_INVALID');
        return JSON.stringify(await launcher.replacement({ agent: exec.agent, signal: exec.signal, ...request }));
      } catch (error) {
        return JSON.stringify({ ok: false, code: codeOf(error), stopFurtherMutation: true, noAutomaticRetry: true });
      }
    },
  }));
  const path = new URL('../skills/dsh-team-replace/SKILL.md', import.meta.url);
  const content = (await readFile(path, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  ctx.skills.register({ name: 'dsh-team-replace', source: 'runtime',
    description: '管理已有团队成员：按稳定成员名替换、显式增员或安全移除，保留任务与历史；对不确定的替换恢复同一操作。',
    invocation: { modelInvocable: true, userInvocable: true }, path: fileURLToPath(path),
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('.', path)) }, content });
}
