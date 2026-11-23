import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './config.js';

/** Native delegation inherits the live directory, not the immutable Session header. */
export function assertWorkingDirectory(ctx, config, agent) {
  if (typeof ctx.workingDirectory?.get !== 'function') fail('HOST_CONTRACT_UNAVAILABLE');
  if (ctx.workingDirectory.get(agent.session) !== config.workspace) fail('WRONG_WORKSPACE');
}

export async function assertOwned(ctx, c, agent) {
  if (process.platform === 'win32') fail('LEGACY_BOUND_ENTRY_REQUIRES_MACOS');
  if (!agent || agent.id !== c.ownedSessionId || agent.session?.id !== agent.id
    || ctx.agents.get(agent.id) !== agent || agent.session.header?.origin === 'subagent') fail('WRONG_AGENT');
  if (await realpath(c.workspace) !== c.workspace || await realpath(agent.session.header.cwd) !== c.workspace) fail('WRONG_WORKSPACE');
  const path = join(c.workspace, '.dsh-subagent-live.json');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
    || before.uid !== process.getuid() || before.size > 4096) fail('INVALID_MARKER');
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat(); const marker = JSON.parse(await f.readFile('utf8'));
    if (s.ino !== before.ino || s.dev !== before.dev || marker.purpose !== 'dsh-subagent-live-one'
      || marker.ownedSessionId !== c.ownedSessionId || marker.runTag !== c.runTag) fail('INVALID_MARKER');
  } finally { await f.close(); }
  assertWorkingDirectory(ctx, c, agent);
}
