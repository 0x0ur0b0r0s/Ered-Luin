$ErrorActionPreference = 'Stop'
$localTools = Split-Path -Parent $MyInvocation.MyCommand.Path
$localShim = Join-Path $localTools 'pnpm.cmd'
$nodeCommand = Get-Command node -CommandType Application | Select-Object -First 1
if (-not $nodeCommand) { throw 'Node.js was not found on PATH.' }
$nodeVersion = (& $nodeCommand.Source --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { throw 'Could not parse the Node.js version.' }
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
$patch = [int]$Matches[3]
if ($major -ne 24 -or $minor -lt 20 -or ($minor -eq 20 -and $patch -lt 0)) {
  throw "D2 requires Node >=24.20.0 <25; PATH selects $nodeVersion."
}
$shimCommand = Get-Command pnpm -CommandType Application -All |
  Where-Object { $_.Source -ne $localShim } |
  Select-Object -First 1
if (-not $shimCommand) { throw 'An upstream pnpm shim was not found on PATH.' }
$pnpmEntry = Join-Path (Split-Path -Parent $shimCommand.Source) '..\..\node\node_modules\pnpm\bin\pnpm.mjs'
$pnpmEntry = (Resolve-Path -LiteralPath $pnpmEntry).Path
$originalPath = $env:PATH
try {
  $env:PATH = $localTools + ';' + $originalPath
  & $nodeCommand.Source $pnpmEntry @args
  $exitCode = $LASTEXITCODE
} finally {
  $env:PATH = $originalPath
}
exit $exitCode
