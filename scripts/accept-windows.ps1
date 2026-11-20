param(
  [Parameter(Mandatory = $true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
if (Test-Path $WorkDir) { throw 'Acceptance WorkDir must not exist.' }
New-Item -ItemType Directory -Path $WorkDir | Out-Null
$receiptDir = Join-Path $WorkDir 'receipts'
New-Item -ItemType Directory -Path $receiptDir | Out-Null
$installer = Join-Path $WorkDir 'deepseek-harness-0.2.2-rc.5-win-x64.exe'
$url = 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.5-win-x64.exe'
Invoke-WebRequest -Uri $url -OutFile $installer
$installerSha = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installerSha -ne '013e28bc8c714749331308386d814108336851914d243aa6bcfd14de1ab30923') {
  throw 'Official installer digest changed; review the new artifact before accepting it.'
}

# Extract the official NSIS payload without starting the GUI or touching a user profile.
$payloadDir = Join-Path $WorkDir 'payload'
& 7z x $installer "-o$payloadDir" '-y' '$PLUGINSDIR/app-64.7z' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'NSIS payload extraction failed.' }
$installDir = Join-Path $WorkDir 'DeepSeek Harness'
& 7z x (Join-Path $payloadDir '$PLUGINSDIR/app-64.7z') "-o$installDir" '-y' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Application extraction failed.' }
$exe = Join-Path $installDir 'DeepSeek Harness.exe'
$asar = Join-Path $installDir 'resources/app.asar'
$asarSha = (Get-FileHash $asar -Algorithm SHA256).Hash.ToLowerInvariant()
if ($asarSha -ne '5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69') {
  throw 'Windows app.asar digest does not match the reviewed Host.'
}
@{ url = $url; installerSha256 = $installerSha; archiveSha256 = $asarSha;
   hostVersion = '0.2.2-rc.5'; platform = 'win32'; arch = 'x64'; layout = 'official NSIS payload';
   gitCommit = $env:GITHUB_SHA } | ConvertTo-Json | Set-Content (Join-Path $receiptDir 'artifact.json')

$packageRoot = Split-Path $PSScriptRoot -Parent
Push-Location $packageRoot
try {
  $pack = & npm pack --json --ignore-scripts --pack-destination $WorkDir
  if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
  $tgz = Join-Path $WorkDir (($pack | ConvertFrom-Json)[0].filename)
  & node (Join-Path $PSScriptRoot 'accept-windows-host.mjs') `
    --install-dir $installDir --tgz $tgz --lab-dir (Join-Path $WorkDir 'lab') --receipt-dir $receiptDir
  if ($LASTEXITCODE -ne 0) { throw 'Real Windows Host acceptance failed. See receipts.' }
} finally {
  Pop-Location
}
