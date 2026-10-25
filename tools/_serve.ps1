$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
Start-Process -FilePath $node `
  -ArgumentList 'node_modules/vite/bin/vite.js','--port','4175','--strictPort','--host','127.0.0.1' `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Root 'server.log') `
  -RedirectStandardError (Join-Path $Root 'server.err.log')
Write-Output 'started'
