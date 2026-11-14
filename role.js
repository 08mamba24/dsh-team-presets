import { randomUUID } from 'node:crypto';
import { fail } from './src/config.js';

export const name = 'dsh-live-implementer-role';
export const inject = ['systemPrompt', 'tools'];
export async function apply(ctx, config) {
  if (!config?.ownedSessionId || !config.runTag || !config.personaNonce) fail('INVALID_ROLE_CONFIG');
  ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0,
    text: `You are the synthetic implementer. Your personaNonce is ${config.personaNonce}. Return JSON with role=implementer, personaNonce, and value=5 for the task 2+3. Do not delegate or use tools.` });
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.origin !== 'subagent' || agent.session.header.parentSession !== config.ownedSessionId) fail('ROLE_WRONG_PARENT');
    const tools = agent.ctx.tools;
    tools.restrict({ allow: [] });
    tools.register({ name: 'dsh_live_echo', description: 'Synthetic capability probe; no file, shell or network access.',
      parameters: { type: 'object', properties: { probe: { type: 'string' } }, required: ['probe'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { if (args?.probe !== 'owned-audit') fail('BAD_SYNTHETIC_PROBE'); return { value: 5 }; },
    });
    const controller = new AbortController();
    agent.ctx.effect(() => () => controller.abort());
    const toolSet = await tools.resolve({ agent, modelSelection: agent.model.current(), signal: controller.signal });
    try {
      const names = [...toolSet.view(agent).keys()];
      if (names.length !== 1 || names[0] !== 'dsh_live_echo') fail('ROLE_TOOL_LEAK');
      const execute = async (name, args) => {
        const id = `dsh-role-${randomUUID()}`;
        const batch = await tools.execute({ agent, signal: controller.signal, toolSet,
          calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] });
        if (batch.results?.length !== 1 || batch.results[0].callId !== id || batch.additionalContexts?.length !== 0 || batch.concluded !== false) fail('ROLE_AUDIT_FAILED');
        return batch.results[0].result;
      };
      const allowed = await execute('dsh_live_echo', { probe: 'owned-audit' });
      const denied = await execute('bash', { command: 'DO_NOT_EXECUTE' });
      if (allowed.isError !== false || allowed.value?.value !== 5 || denied.isError !== true) fail('ROLE_AUDIT_FAILED');
      ctx.emit('dsh-live-one/role-audit', { childId: agent.id, parentSessionId: config.ownedSessionId,
        runTag: config.runTag, allowedTool: 'dsh_live_echo', allowedResult: 5, forbiddenTool: 'bash', forbiddenResult: 'rejected_by_native_executor', toolNames: names });
    } finally { toolSet.dispose(); }
  });
}
