import { pathToFileURL } from 'node:url';
import { hostArchiveForExecutable, hostPathApi } from '../../src/host-support.js';

// Model the current platform's Host layout without loading it or changing execPath.
// The synthetic native adapters consume this URL without reading an installed app.
const entryPath = hostPathApi().join(hostArchiveForExecutable(), 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-tool-subagent-control', 'lib', 'index.js');
export const CONTROL_ENTRY = pathToFileURL(entryPath, { windows: process.platform === 'win32' }).href;
export const CONTROL = { name: CONTROL_ENTRY, config: { interrupt: false } };
