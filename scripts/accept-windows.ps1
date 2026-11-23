param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [ValidateSet('0.2.2-rc.5', '0.2.3-alpha.2')][string]$HostVersion = '0.2.2-rc.5'
)
$ErrorActionPreference = 'Stop'
if (Test-Path $WorkDir) { throw 'Acceptance WorkDir must not exist.' }
New-Item -ItemType Directory -Path $WorkDir | Out-Null
$receiptDir = Join-Path $WorkDir 'receipts'
New-Item -ItemType Directory -Path $receiptDir | Out-Null
$distributions = @{
  '0.2.2-rc.5' = @{
    installerSha256 = '013e28bc8c714749331308386d814108336851914d243aa6bcfd14de1ab30923'
    archiveSha256 = '5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69'
  }
  '0.2.3-alpha.2' = @{
    installerSha256 = '79ef8ab8d5c4dc10566986e179aeaf2a27237ad3f1f962cddbc8ce912d6dd3a2'
    archiveSha256 = 'dbd860998178fb23fe5802704fa1cf919f5b6957e4b3cc2c1b778efdb61297ab'
  }
}
function Expand-OfficialHost([string]$Version, [string]$Target) {
  New-Item -ItemType Directory -Path $Target | Out-Null
  $installer = Join-Path $Target "deepseek-harness-$Version-win-x64.exe"
  $url = "https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-$Version-win-x64.exe"
  Invoke-WebRequest -Uri $url -OutFile $installer
  $installerSha = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installerSha -ne $distributions[$Version].installerSha256) { throw 'Official installer digest changed.' }
  $payloadDir = Join-Path $Target 'payload'
  & 7z x $installer "-o$payloadDir" '-y' '$PLUGINSDIR/app-64.7z' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'NSIS payload extraction failed.' }
  $installDir = Join-Path $Target 'DeepSeek Harness'
  & 7z x (Join-Path $payloadDir '$PLUGINSDIR/app-64.7z') "-o$installDir" '-y' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Application extraction failed.' }
  $asarSha = (Get-FileHash (Join-Path $installDir 'resources/app.asar') -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($asarSha -ne $distributions[$Version].archiveSha256) { throw 'Windows app.asar does not match the exact Host pin.' }
  return @{ url = $url; installerSha256 = $installerSha; archiveSha256 = $asarSha;
    hostVersion = $Version; installDir = $installDir; executable = (Join-Path $installDir 'DeepSeek Harness.exe') }
}
$selected = Expand-OfficialHost $HostVersion (Join-Path $WorkDir 'selected-host')
$installDir = $selected.installDir
$legacyHost = $null
if ($HostVersion -eq '0.2.3-alpha.2') {
  $legacyHost = Expand-OfficialHost '0.2.2-rc.5' (Join-Path $WorkDir 'legacy-host')
}
@{ selected = $selected; legacy = $legacyHost; platform = 'win32'; arch = 'x64';
   layout = 'official NSIS payload'; gitCommit = $env:GITHUB_SHA } |
  ConvertTo-Json -Depth 5 | Set-Content (Join-Path $receiptDir 'artifact.json')

$packageRoot = Split-Path $PSScriptRoot -Parent
$baselineDir = Join-Path $WorkDir 'baseline'
New-Item -ItemType Directory -Path $baselineDir | Out-Null
$previousTgz = Join-Path $baselineDir 'dsh-subagent-live-rc2-local-0.5.0-rc.5.tgz'
Invoke-WebRequest -Uri 'https://github.com/08mamba24/dsh-team-presets/releases/download/v0.5.0-rc.5/dsh-subagent-live-rc2-local-0.5.0-rc.5.tgz' -OutFile $previousTgz
if ((Get-FileHash $previousTgz -Algorithm SHA256).Hash.ToLowerInvariant() -ne '4cfd9ae7215f511f370a25a357aafe513c9621bef184429792bf092f05070765') {
  throw 'Previous rc.5 upgrade baseline digest changed.'
}
$legacyTgz = Join-Path $baselineDir 'dsh-subagent-live-rc2-local-0.5.0-rc.6.tgz'
Invoke-WebRequest -Uri 'https://github.com/08mamba24/dsh-team-presets/releases/download/v0.5.0-rc.6/dsh-subagent-live-rc2-local-0.5.0-rc.6.tgz' -OutFile $legacyTgz
if ((Get-FileHash $legacyTgz -Algorithm SHA256).Hash.ToLowerInvariant() -ne '2cf65d1b843ead3b5fc051df2f1b6f8027022c4ecabb1d9d0375173cfd47f03d') {
  throw 'Legacy rc.6 team baseline digest changed.'
}
$legacyDir = Join-Path $baselineDir 'legacy-rc6'
New-Item -ItemType Directory -Path $legacyDir | Out-Null
& tar.exe -xzf $legacyTgz -C $legacyDir
if ($LASTEXITCODE -ne 0) { throw 'Legacy package extraction failed.' }
$multiRoleTgz = Join-Path $baselineDir 'dsh-subagent-live-rc2-local-0.5.0-rc.7.tgz'
Invoke-WebRequest -Uri 'https://github.com/08mamba24/dsh-team-presets/releases/download/v0.5.0-rc.7/dsh-subagent-live-rc2-local-0.5.0-rc.7.tgz' -OutFile $multiRoleTgz
if ((Get-FileHash $multiRoleTgz -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'e87677e91b24ac51505b22c64e81674f12c9c460452ad2e3c084db0d2c97ba16') {
  throw 'Published rc.7 migration baseline digest changed.'
}
$multiRoleDir = Join-Path $baselineDir 'multi-role-rc7'
New-Item -ItemType Directory -Path $multiRoleDir | Out-Null
& tar.exe -xzf $multiRoleTgz -C $multiRoleDir
if ($LASTEXITCODE -ne 0) { throw 'rc.7 migration package extraction failed.' }
Push-Location $packageRoot
try {
  $pack = & npm pack --json --ignore-scripts --pack-destination $WorkDir
  if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
  $tgz = Join-Path $WorkDir (($pack | ConvertFrom-Json)[0].filename)
  $legacyHostArgs = @()
  if ($null -ne $legacyHost) { $legacyHostArgs = @('--legacy-host-executable', $legacyHost.executable) }
  & node (Join-Path $PSScriptRoot 'accept-windows-host.mjs') `
    --install-dir $installDir --tgz $tgz --previous-tgz $previousTgz --legacy-plugin (Join-Path $legacyDir 'package') `
    --multi-role-legacy-plugin (Join-Path $multiRoleDir 'package') `
    --lab-dir (Join-Path $WorkDir 'lab') --receipt-dir $receiptDir @legacyHostArgs
  if ($LASTEXITCODE -ne 0) { throw 'Real Windows Host acceptance failed. See receipts.' }
} finally {
  Pop-Location
}
