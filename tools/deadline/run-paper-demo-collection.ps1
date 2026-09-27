[CmdletBinding()]
param([string]$ResumeRunId)
$ErrorActionPreference = 'Stop'
$previous = [Environment]::GetEnvironmentVariable('NANSEN_API_KEY', 'Process')
$secureKey = $null
$keyPointer = [IntPtr]::Zero
try {
  $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
  Set-Location -LiteralPath $root
  $launcher = Join-Path $root 'tools/pnpm-node24.ps1'
  $runner = Join-Path $PSScriptRoot 'paper-demo-collection.mjs'
  if ($ResumeRunId) {
    & $launcher exec node $runner --dry-run --resume $ResumeRunId
  } else {
    & $launcher exec node $runner --dry-run
  }
  if ($LASTEXITCODE -ne 0) { throw 'Paper-demo collection preflight failed.' }
  $keyPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Ered-Luin/secrets') 'nansen-api-key.dpapi'
  if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw 'Credential unavailable.' }
  $secureKey = ConvertTo-SecureString ([IO.File]::ReadAllText($keyPath))
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer), 'Process')
  if ($ResumeRunId) {
    & $launcher exec node $runner --resume $ResumeRunId
  } else {
    & $launcher exec node $runner
  }
  if ($LASTEXITCODE -ne 0) { throw 'Paper-demo collection stopped; inspect the external run manifest and ledger.' }
} finally {
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', $previous, 'Process')
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($null -ne $secureKey) { $secureKey.Dispose() }
}
