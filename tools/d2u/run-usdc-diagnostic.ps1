[CmdletBinding()]
param([switch]$Dispatch)
$ErrorActionPreference = 'Stop'
# Explicit import avoids a bundled-host module autoload failure before DPAPI access.
Import-Module Microsoft.PowerShell.Security -Force -ErrorAction Stop
$previousKey = [Environment]::GetEnvironmentVariable('NANSEN_API_KEY', 'Process')
$secureKey = $null
$keyPointer = [IntPtr]::Zero
try {
  if ($Dispatch) {
    $privateRoot = Join-Path $env:LOCALAPPDATA 'Ered-Luin'
    $keyPath = Join-Path $privateRoot 'secrets\nansen-api-key.dpapi'
    $secureKey = ConvertTo-SecureString ([IO.File]::ReadAllText($keyPath))
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer), 'Process')
  }
  $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
  Set-Location -LiteralPath $root
  $launcherPath = Join-Path $root 'tools/pnpm-node24.ps1'
  $runnerPath = Join-Path $root 'tools/d2u/run-usdc-diagnostic.mjs'
  if ($Dispatch) {
    & $launcherPath exec node $runnerPath --dispatch
  } else {
    & $launcherPath exec node $runnerPath --dry-run
  }
  if ($LASTEXITCODE -ne 0) { throw 'D2u diagnostic did not complete successfully.' }
} finally {
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', $previousKey, 'Process')
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($null -ne $secureKey) { $secureKey.Dispose() }
}
