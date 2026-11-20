import { posix, win32 } from 'node:path';
import { fail } from './config.js';

export const MAC_HOST_ARCHIVE = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

// A native API version is admitted only with its inspected archive on this OS.
export const REVIEWED_HOSTS = Object.freeze({
  darwin: Object.freeze({
    '0.2.2-rc.2': '1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d',
    '0.2.2-rc.5': '6f019878f523428f452957dbaad601c6468051df4093eda8af751ec65226f88e',
  }),
  win32: Object.freeze({
    '0.2.2-rc.5': '5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69',
  }),
});

export function hostPathApi(platform = process.platform) {
  if (platform === 'darwin') return posix;
  if (platform === 'win32') return win32;
  fail('HOST_PLATFORM_UNSUPPORTED');
}

/** The Windows resource directory is next to the running app, including per-user installs. */
export function hostArchiveForExecutable(executable = process.execPath, platform = process.platform) {
  const path = hostPathApi(platform);
  if (platform === 'darwin') return MAC_HOST_ARCHIVE;
  if (typeof executable !== 'string' || !/^[A-Za-z]:\\/.test(executable)
    || !path.isAbsolute(executable) || path.normalize(executable) !== executable) fail('WRONG_HOST_PROCESS');
  return path.join(path.dirname(executable), 'resources', 'app.asar');
}

export function assertHostExecutable(executable = process.execPath, platform = process.platform) {
  const path = hostPathApi(platform);
  if (platform === 'darwin') {
    if (!executable.startsWith('/Applications/DeepSeek Harness.app/Contents/')) fail('WRONG_HOST_PROCESS');
  } else if (path.basename(executable).toLowerCase() !== 'deepseek harness.exe') fail('WRONG_HOST_PROCESS');
  return hostArchiveForExecutable(executable, platform);
}

export function hostVersionForArchive(digest, platform = process.platform) {
  const versions = REVIEWED_HOSTS[platform];
  return versions && Object.keys(versions).find(version => versions[version] === digest);
}

/** Check native control exports against the same archive used by the running Host. */
export function isHostControlPath(candidate, suffix, archive = hostArchiveForExecutable(), platform = process.platform) {
  const path = hostPathApi(platform);
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) return false;
  const modules = path.join(archive, 'dsh', 'node_modules') + path.sep;
  const ending = path.sep + path.join('node_modules', '@deepseek-ai', 'dsh-tool-subagent-control', suffix);
  const comparable = value => platform === 'win32' ? value.toLowerCase() : value;
  return comparable(candidate).startsWith(comparable(modules)) && comparable(candidate).endsWith(comparable(ending));
}
