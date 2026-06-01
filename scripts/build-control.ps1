Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "src-winui\bin\x64\Release\net8.0-windows10.0.22621.0\win-x64"

function Test-RunningOutputProcess {
    param(
        [string]$Directory
    )

    if (-not (Test-Path $Directory)) {
        return @()
    }

    $escapedDirectory = $Directory.TrimEnd('\').Replace('\', '\\')
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.ExecutablePath -and
            $_.ExecutablePath -match "^$escapedDirectory\\" -and
            ($_.Name -eq "WT8111Neo.Control.exe" -or $_.Name -eq "wt-8111-neo.exe")
        } |
        Select-Object ProcessId, Name, ExecutablePath
}

Push-Location $RepoRoot
try {
    $runningOutputProcesses = @(Test-RunningOutputProcess -Directory $OutputDir)
    if ($runningOutputProcesses.Count -gt 0) {
        $processList = $runningOutputProcesses |
            ForEach-Object { "PID $($_.ProcessId): $($_.Name)" }
        throw "Close the running WT 8111 Neo output app before rebuilding: $($processList -join ', ')"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-service.ps1
    & dotnet build src-winui/WT8111Neo.Control.csproj -c Release -p:Platform=x64
}
finally {
    Pop-Location
}
