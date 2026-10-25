# ============================================================
#  Diorama launcher (street-corner miniature scene)
#  Checks whether the local dev server is up; starts it hidden if
#  needed, then opens the diorama page in the browser.
#  ASCII-only on purpose: avoids Windows PowerShell 5.1 UTF-8
#  decoding problems (see README section 12).
# ============================================================

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Port = 4175
$Url  = "http://127.0.0.1:$Port/"
$Log  = Join-Path $PSScriptRoot 'launch-diorama.log'

function Write-Log {
    param([string]$Msg)
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Msg
    Add-Content -Path $Log -Value $line -Encoding UTF8
}

function Test-Server {
    param([string]$Target)
    try {
        $r = Invoke-WebRequest -Uri $Target -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        return $false
    }
}

function Show-Error {
    param([string]$Msg)
    Write-Log "ERROR: $Msg"
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show(
            $Msg, 'Diorama - launch failed',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch {
        # no GUI available: stay silent
    }
}

Write-Log "---- launch start ----"
Write-Log "Root=$Root  Port=$Port"

try {
    # 1. already serving? just open the page
    if (Test-Server -Target $Url) {
        Write-Log "server already running, opening browser"
        Start-Process $Url
        exit 0
    }

    # 2. locate node
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Show-Error "Node.js not found. Please install Node.js 18+ and retry."
        exit 1
    }
    $nodeExe = $nodeCmd.Source

    $viteJs = Join-Path $Root 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path $viteJs)) {
        Show-Error "vite not found. Run 'npm install' in the project folder first."
        exit 1
    }

    # 3. start dev server (hidden window)
    Write-Log "starting vite dev server"
    $proc = Start-Process -FilePath $nodeExe `
        -ArgumentList @("`"$viteJs`"", '--port', "$Port", '--strictPort', '--host', '127.0.0.1') `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Write-Log "vite PID = $($proc.Id)"

    # 4. wait until ready (max 30s)
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) {
            Write-Log "vite exited early, code = $($proc.ExitCode)"
            break
        }
        if (Test-Server -Target $Url) { $ready = $true; break }
    }

    if (-not $ready) {
        Show-Error "Local server did not start.`nPort $Port may be busy, or dependencies are missing.`nSee tools\launch-diorama.log."
        exit 1
    }

    Write-Log "server ready, opening browser"
    Start-Process $Url
    Write-Log "---- launch ok ----"
    exit 0
} catch {
    Write-Log "EXCEPTION: $($_.Exception.Message)"
    Show-Error "Exception while launching:`n$($_.Exception.Message)"
    exit 1
}
