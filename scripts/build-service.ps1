Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ServiceExe = Join-Path $RepoRoot "src-tauri\target\release\wt-8111-neo.exe"
$CargoCommand = Get-Command cargo -ErrorAction SilentlyContinue

function Test-RunningFileProcess {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return @()
    }

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.ExecutablePath -and
            [System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $fullPath
        } |
        Select-Object ProcessId, Name, ExecutablePath
}

if ($CargoCommand) {
    $CargoPath = $CargoCommand.Source
}
else {
    $CargoPath = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
}

if (-not (Test-Path $CargoPath)) {
    throw "Could not find cargo. Install Rust or add cargo.exe to PATH."
}

Push-Location $RepoRoot
try {
    $runningServiceProcesses = @(Test-RunningFileProcess -Path $ServiceExe)
    if ($runningServiceProcesses.Count -gt 0) {
        $processList = $runningServiceProcesses |
            ForEach-Object { "PID $($_.ProcessId): $($_.Name)" }
        throw "Close the running Rust service before rebuilding: $($processList -join ', ')"
    }

    & npm.cmd run build
    & $CargoPath build --manifest-path src-tauri/Cargo.toml --release
}
finally {
    Pop-Location
}
