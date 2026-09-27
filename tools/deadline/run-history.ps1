[CmdletBinding()]
param([switch]$Dispatch)
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -Force -ErrorAction Stop
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class EredLuinDeadlinePower { [DllImport("kernel32.dll", SetLastError = true)] public static extern uint SetThreadExecutionState(uint flags); }'
$previousKey = [Environment]::GetEnvironmentVariable('NANSEN_API_KEY', 'Process')
$secureKey = $null
$keyPointer = [IntPtr]::Zero
$powerRequested = $false
try {
  $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
  Set-Location -LiteralPath $root
  $launcher = Join-Path $root 'tools/pnpm-node24.ps1'
  $runner = Join-Path $root 'tools/deadline/history-runner.mjs'
  $config = Join-Path $env:LOCALAPPDATA 'Ered-Luin/d2m-usdc-history/deadline-usdc-history-20260927/runner.json'
  $preflightOutput = & $launcher exec node $runner --config $config
  if ($LASTEXITCODE -ne 0) { throw 'Bounded history preflight failed.' }
  $preflightText = ($preflightOutput | Out-String).Trim()
  $preflight = $preflightText | ConvertFrom-Json
  if ($preflight.mode -ne 'DRY_RUN' -or $preflight.providerCalls -ne 0 -or $preflight.credentialRead -ne $false -or -not $preflight.configSha256) { throw 'Bounded history preflight did not pass.' }
  if (-not $Dispatch) { Write-Output $preflightText; return }
  $powerRequested = [EredLuinDeadlinePower]::SetThreadExecutionState([uint32]([long]2147483649)) -ne 0
  if (-not $powerRequested) { throw 'Could not keep the computer awake for the bounded run.' }
  $keyPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Ered-Luin/secrets') 'nansen-api-key.dpapi'
  $secureKey = ConvertTo-SecureString ([IO.File]::ReadAllText($keyPath))
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer), 'Process')
  & $launcher exec node $runner --config $config --dispatch --preflight-sha256 $preflight.configSha256
  if ($LASTEXITCODE -ne 0) { throw 'Bounded history runner stopped safely.' }
} finally {
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', $previousKey, 'Process')
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($null -ne $secureKey) { $secureKey.Dispose() }
  if ($powerRequested) { [void][EredLuinDeadlinePower]::SetThreadExecutionState([uint32]([long]2147483648)) }
}
