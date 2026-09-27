[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$InvocationId,
  [switch]$Dispatch
)
$ErrorActionPreference = 'Stop'
$previousKey = [Environment]::GetEnvironmentVariable('NANSEN_API_KEY', 'Process')
$secureKey = $null
$keyPointer = [IntPtr]::Zero
try {
  $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
  Set-Location -LiteralPath $root
  $launcher = Join-Path $root 'tools/pnpm-node24.ps1'
  $runner = Join-Path $root 'tools/d2v/run-refresh.mjs'
  $resolvedConfig = (Resolve-Path -LiteralPath $Config).Path
  $preflightOutput = & $launcher exec node $runner --config $resolvedConfig --invocation-id $InvocationId --dry-run
  if ($LASTEXITCODE -ne 0) { throw 'D2v refresh preflight failed.' }
  $preflightText = ($preflightOutput | Out-String).Trim()
  $preflight = $preflightText | ConvertFrom-Json
  if (-not $preflight.dispatchReady -or -not $preflight.configSha256) { throw 'D2v refresh is not ready.' }
  if (-not $Dispatch) {
    Write-Output $preflightText
    return
  }
  if (-not $preflight.cacheCandidate) {
    $privateRoot = Join-Path $env:LOCALAPPDATA 'Ered-Luin'
    $keyPath = Join-Path (Join-Path $privateRoot 'secrets') 'nansen-api-key.dpapi'
    $secureKey = ConvertTo-SecureString ([IO.File]::ReadAllText($keyPath))
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer), 'Process')
  }
  & $launcher exec node $runner --config $resolvedConfig --invocation-id $InvocationId --dispatch --preflight-sha256 $preflight.configSha256
  if ($LASTEXITCODE -ne 0) { throw 'D2v refresh did not complete successfully.' }
} finally {
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', $previousKey, 'Process')
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($null -ne $secureKey) { $secureKey.Dispose() }
}
