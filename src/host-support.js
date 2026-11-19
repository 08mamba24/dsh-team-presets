export const HOST_ARCHIVE = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

// Each entry binds one inspected native API version to the physical macOS archive reviewed for it.
export const REVIEWED_HOSTS = Object.freeze({
  '0.2.2-rc.2': '1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d',
  '0.2.2-rc.5': '6f019878f523428f452957dbaad601c6468051df4093eda8af751ec65226f88e',
});

export const hostVersionForArchive = digest => Object.keys(REVIEWED_HOSTS)
  .find(version => REVIEWED_HOSTS[version] === digest);
