import { nativeTeamFromHost } from './src/team-host.js';
import { applyCurrentLauncher } from './src/launcher-current.js';
import { nativeConfigurationFromHost } from './src/configure-host.js';
import { applyTeamConfigurator } from './src/team-configure.js';
import * as roleTemplates from './src/role-templates.js';
import { ROOT_SESSION_ID } from './src/replacement-store.js';
import { applyTeamReplacement } from './src/team-replace.js';
import { installRootAddressing } from './src/team-addressing.js';
import { bindHostContext } from './src/host-adapter.js';

const nativeConfiguration = await nativeConfigurationFromHost();
const { Schema } = nativeConfiguration;
export const Config = Schema.object({
  mode: Schema.string().default('current-session'),
  template: Schema.any().volatile(),
  replacementRecords: Schema.dict(Schema.any(), Schema.string().pattern(ROOT_SESSION_ID)).default({}).volatile(),
  timeoutMs: Schema.number().default(120000),
  // Per stable member name; omitted members get one ordinary startup stream.
  maxStreams: Schema.dict(Schema.number()).default({}),
  // Operator-provided duty-template seeds; the saved settings row stays
  // authoritative once the configurator persists its own customRoleTemplates.
  // Volatile like template/replacementRecords: a Ref-shaped hot-update field,
  // so activation reads .get() and later catalog saves never remount the
  // running current-team entry (real-Host RED: native-multi-integrated-r1.log).
  customRoleTemplates: Schema.array(Schema.any()).default([]).volatile(),
});

export const name = 'native-current-team';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams', 'workingDirectory', 'skills', 'settings', 'sandboxPolicy', 'sessionQuery', 'sessions'];

export async function apply(ctx, raw) {
  bindHostContext(ctx, nativeConfiguration.adapter);
  const { nativeSubagent, controlEntry } = await nativeTeamFromHost();
  const readTemplate = () => raw.template?.get();
  const launcher = await applyCurrentLauncher(ctx, { mode: raw.mode, template: readTemplate(),
    timeoutMs: raw.timeoutMs, maxStreams: raw.maxStreams }, nativeSubagent, controlEntry,
  { readTemplate, readRecords: () => raw.replacementRecords.get(),
    prepareRoot: agent => installRootAddressing(ctx, agent) });
  await applyTeamConfigurator(ctx, launcher, nativeConfiguration,
    { roleTemplates, defaultCustomTemplates: raw.customRoleTemplates?.get() });
  await applyTeamReplacement(ctx, launcher, nativeConfiguration);
}
