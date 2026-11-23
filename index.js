import { parseConfig } from './src/config.js';
import { nativeHostFromApp } from './src/host.js';
import { bindHostContext } from './src/host-adapter.js';
import { applyLive } from './src/driver.js';

export const name = 'native-subagent-live-one';
export const inject = { required: ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections'], optional: ['subagentModelSelection'] };
export async function apply(ctx, config = {}) {
  const parsed = parseConfig(config);
  if (!parsed) return applyLive(ctx, config, null);
  const host = await nativeHostFromApp();
  bindHostContext(ctx, host.adapter);
  return applyLive(ctx, config, host.nativeSubagent);
}
