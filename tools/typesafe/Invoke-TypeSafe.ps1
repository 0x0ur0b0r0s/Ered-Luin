param(
  [Parameter(Mandatory=$true)][string]$Packet,
  [switch]$Live
)
$ErrorActionPreference = 'Stop'
$previousKey = $env:TYPESAFE_API_KEY
$previousAudit = $env:TYPESAFE_AUDIT_DIR
$secureKey = $null
$keyPointer = [IntPtr]::Zero
try {
  if ($Live) {
    $privateRoot = Join-Path $env:LOCALAPPDATA 'Ered-Luin'
    $keyPath = Join-Path $privateRoot 'secrets\typesafe-api-key.dpapi'
    $secureKey = ConvertTo-SecureString ([System.IO.File]::ReadAllText($keyPath))
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $env:TYPESAFE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    $env:TYPESAFE_AUDIT_DIR = Join-Path $privateRoot 'typesafe-audit'
  }
  $runner = Join-Path $PSScriptRoot 'shadow.mjs'
  if ($Live) { & node $runner $Packet --live }
  else { & node $runner $Packet }
  if ($LASTEXITCODE -ne 0) { throw 'TypeSafe check did not complete; Astra review remains required.' }
} finally {
  $env:TYPESAFE_API_KEY = $previousKey
  $env:TYPESAFE_AUDIT_DIR = $previousAudit
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($null -ne $secureKey) { $secureKey.Dispose() }
}
