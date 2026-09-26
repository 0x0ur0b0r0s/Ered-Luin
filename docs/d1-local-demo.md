# D1 local paper demo

The D1 dashboard uses deterministic synthetic observations and synthetic paper quotes. It makes no Nansen or TypeSafe request, does not contact a quote provider, and has no signing or broadcast path. The G3c status tiles are typed synthetic examples, not chain receipts.

## Requirements

Use the repository setup in the README: Windows PowerShell 7, Node.js 24.20.0, pnpm 11.25.0, and dependencies installed from the lockfile.

## Start the API

Build the workspace, then initialize a paper database outside the repository. In PowerShell:

    & .\tools\pnpm-node24.ps1 run build
    $paperStatePath = Join-Path $env:LOCALAPPDATA 'Ered-Luin\d1-paper.sqlite'
    New-Item -ItemType Directory -Force (Split-Path -Parent $paperStatePath) | Out-Null
    & .\tools\pnpm-node24.ps1 --filter @ered-luin/api run init-paper-store -- init $paperStatePath

Start the API in that same terminal:

    $env:PAPER_STATE_PATH = $paperStatePath
    $env:NANSEN_API_ENABLED = 'false'
    $env:NANSEN_CREDIT_BUDGET = '0'
    $env:LIVE_EXECUTION_ENABLED = 'false'
    $env:EXECUTION_MODE = 'paper'
    $env:NODE_ENV = 'development'
    & .\tools\pnpm-node24.ps1 --filter @ered-luin/api start

The paper database is persistent and the initialization command does not overwrite an existing file. Use a new filename if you need a clean replay history.

## Start the dashboard

In a second PowerShell terminal:

    & .\tools\pnpm-node24.ps1 --filter @ered-luin/dashboard dev

Open the local Vite address printed by the command. The dashboard proxies /healthz and /v1 requests to the local API at 127.0.0.1:3000. Build a scenario proposal, inspect its synthetic observations, then run the firewall to persist and retrieve the paper result.
