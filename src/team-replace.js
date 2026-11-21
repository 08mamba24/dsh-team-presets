import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fail } from './config.js';
import { parseReplacementRequest } from './member-replacement.js';

const codeOf = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code) ? error.code : 'TEAM_REPLACEMENT_FAILED';
const ID = /^session-[a-zA-Z0-9][a-zA-Z0-9-]{6,62}$/;

/** Root-only Agent entry. The native tool pipeline still owns permissions. */
export async function applyTeamReplacement(ctx, launcher, { defineTool }) {
  if (typeof defineTool !== 'function' || typeof launcher?.replacement !== 'function'
    || typeof ctx.tools?.register !== 'function' || typeof ctx.skills?.register !== 'function') fail('REPLACEMENT_HOST_UNAVAILABLE');
  let closing = false;
  ctx.effect(() => () => { closing = true; });
  ctx.tools.register(defineTool({
    name: 'dsh_team_replace',
    description: 'Inspect this root team, replace one idle implementer/reviewer with explicit model/effort/persona/prompt/tools, or recover one existing replacement operation. Preserves task IDs and history. Replacement may call the candidate model and continue its work; native authorization, sandbox and approvals remain in force. Inspect first and bind expectedOldChildId. Recover the existing operation after an uncertain result.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'replace', 'recover', 'cancel'] },
      role: { type: 'string', enum: ['implementer', 'reviewer'] },
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
            || !['implementer', 'reviewer'].includes(input.role)) fail('REPLACEMENT_REQUEST_INVALID');
          request = { action, expectedOldChildId, request: parseReplacementRequest(input) };
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
    description: '在原团队中替换空闲实现/复核成员，交接任务并核验接管；对不确定结果恢复同一操作。',
    invocation: { modelInvocable: true, userInvocable: true }, path: fileURLToPath(path),
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('.', path)) }, content });
}
