import { parseConfig } from './src/config.js';
import { nativeSubagentFromHost } from './src/host.js';
import { applyLive } from './src/driver.js';

export const name = 'native-subagent-live-one';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections'];
export async function apply(ctx, config = {}) {
  const parsed = parseConfig(config);
  return applyLive(ctx, config, parsed ? await nativeSubagentFromHost() : null);
}
