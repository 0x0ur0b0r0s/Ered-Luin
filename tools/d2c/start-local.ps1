[CmdletBinding()]
param(
  [ValidateSet('api', 'dashboard')]
  [string]$Component = 'api',
  [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'Ered-Luin\d2c-local.json'),
  [switch]$AllowTypeSafeAnalysis
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $root
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$launcherPath = Join-Path $root 'tools/pnpm-node24.ps1'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'D2c external local configuration is missing; copy the checked-in example and fill its local-only inputs.' }
$preflightArgs = @('exec', 'node', 'tools/d2c/preflight.mjs', '--config', $ConfigPath)
if ($AllowTypeSafeAnalysis) { $preflightArgs += '--allow-typesafe-analysis' }
$preflightOutput = & $launcherPath @preflightArgs
$preflightExit = $LASTEXITCODE
$preflightOutput | Write-Output
if ($preflightExit -ne 0) { throw 'D2c preflight did not pass. Review the report; no app process was started.' }
$report = $preflightOutput | ConvertFrom-Json
if ($report.safeToStartLocal -ne $true) { throw 'D2c preflight did not confirm local readiness. No app process was started.' }
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
$oldValues = @{}
$managedKeys = if ($Component -eq 'api') { @($config.environment.Keys) } else {
  @('NODE_ENV', 'D2_OPERATOR_SECRET', 'NANSEN_API_KEY', 'ALCHEMY_API_KEY', 'TYPESAFE_API_KEY',
    'G3C_SIGNER_PRIVATE_KEY_PATH', 'G3C_SIGNER_HMAC_SECRET_PATH', 'G3C_SIGNER_STATE_PATH',
    'G3C_EVIDENCE_TRUST_PATH', 'G3C_EVIDENCE_SIGNING_KEY_PATH', 'D2_BASE_RPC_URL', 'ALCHEMY_CONFIG_PATH')
}
try {
  foreach ($key in $managedKeys) {
    $oldValues[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    if ($Component -eq 'api') { [Environment]::SetEnvironmentVariable($key, [string]$config.environment[$key], 'Process') }
    elseif ($key -eq 'NODE_ENV') { [Environment]::SetEnvironmentVariable($key, 'development', 'Process') }
    else { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
  }
  if ($Component -eq 'api') {
    & $launcherPath run build
    if ($LASTEXITCODE -ne 0) { throw 'Workspace build failed; API startup was skipped.' }
    Write-Output 'Starting the API on its configured loopback port. Press Ctrl+C to stop it.'
    & $launcherPath --filter @ered-luin/api start
    if ($LASTEXITCODE -ne 0) { throw 'API process exited with an error.' }
  } else {
    Write-Output 'Starting the dashboard dev server. Press Ctrl+C to stop it.'
    & $launcherPath --filter @ered-luin/dashboard dev
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard process exited with an error.' }
  }
} finally {
  foreach ($key in $oldValues.Keys) {
    [Environment]::SetEnvironmentVariable($key, $oldValues[$key], 'Process')
  }
}