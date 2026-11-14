import { fail } from './src/config.js';
import { TEAM_ROLES, TEAM_ROLE_TOOLS } from './src/team-config.js';

export const name = 'dsh-live-team-role';
export const inject = ['systemPrompt', 'tools'];

/** AgentPreset persona and native capability restriction, without replacing Team tools. */
export async function apply(ctx, config) {
  if (!config || Object.keys(config).sort().join(',') !== 'ownedSessionId,personaNonce,role,runTag'
    || !config.ownedSessionId || !config.runTag || !config.personaNonce || !TEAM_ROLES.includes(config.role)) fail('INVALID_TEAM_ROLE_CONFIG');
  const workflow = config.role === 'implementer'
    ? 'Claim the supplied implementation task with its current revision, perform the task, save the result in its description, complete it, and send the result to the reviewer through send_message. Do not send a completion message to the lead.'
    : 'Wait for the implementer with wait_agent before claiming the supplied review task. Read the completed implementation task, independently check its result, complete the review task only if correct, then report your verdict. Do not send a completion message to the lead.';
  ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0,
    text: `You are the ${config.role} in an owned two-model Team. Your personaNonce is ${config.personaNonce}. ${workflow} Use only the native Team task and messaging tools provided. Use current task revisions, do not delegate, and do not attempt shell or file access. End with a JSON object containing your role, personaNonce, and your actual result or verdict; never invent tool success or evidence.` });
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent' || agent.session.header.parentSession !== config.ownedSessionId) fail('ROLE_WRONG_PARENT');
    // Native Team discovery requires activation ownership, which is registered after this hook.
    // Restrict here; the stream gate verifies the actual prepared tool set before provider dispatch.
    agent.ctx.tools.restrict({ allow: [...TEAM_ROLE_TOOLS] });
  });
}
