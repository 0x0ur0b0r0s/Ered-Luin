[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ParentRunId)
$ErrorActionPreference = 'Stop'
$previous = [Environment]::GetEnvironmentVariable('NANSEN_API_KEY', 'Process')
$secureKey = $null
$keyPointer = [IntPtr]::Zero
try {
  $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
  Set-Location -LiteralPath $root
  $keyPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Ered-Luin/secrets') 'nansen-api-key.dpapi'
  $secureKey = ConvertTo-SecureString ([IO.File]::ReadAllText($keyPath))
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer), 'Process')
  & (Join-Path $root 'tools/pnpm-node24.ps1') exec node (Join-Path $PSScriptRoot 'refresh-paper-demo-usdc.mjs') $ParentRunId
  if ($LASTEXITCODE -ne 0) { throw 'Paper-demo USDC refresh stopped; preserve its separate ledger as recorded.' }
} finally {
  [Environment]::SetEnvironmentVariable('NANSEN_API_KEY', $previous, 'Process')
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($null -ne $secureKey) { $secureKey.Dispose() }
}
