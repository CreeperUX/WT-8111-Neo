Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "src-winui\bin\x64\Release\net8.0-windows10.0.22621.0\win-x64"
$ClientDir = Join-Path $RepoRoot "WT8111Neo-Client"

function Assert-WorkspaceChildDirectory {
    param(
        [string]$Path
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
    $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')

    if (-not $resolvedPath.StartsWith("$resolvedRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside repository: $resolvedPath"
    }
}

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

function Sync-ClientDirectory {
    param(
        [string]$Source,
        [string]$Destination
    )

    Assert-WorkspaceChildDirectory -Path $Destination

    if (-not (Test-Path $Source)) {
        throw "WinUI output directory does not exist: $Source"
    }

    if (Test-Path $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    New-Item -ItemType Directory -Path $Destination | Out-Null
    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

Push-Location $RepoRoot
try {
    $runningOutputProcesses = @(
        Test-RunningOutputProcess -Directory $OutputDir
        Test-RunningOutputProcess -Directory $ClientDir
    )
    if ($runningOutputProcesses.Count -gt 0) {
        $processList = $runningOutputProcesses |
            ForEach-Object { "PID $($_.ProcessId): $($_.Name)" }
        throw "Close the running WT 8111 Neo output app before rebuilding: $($processList -join ', ')"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-service.ps1
    & dotnet build src-winui/WT8111Neo.Control.csproj -c Release -p:Platform=x64
    Sync-ClientDirectory -Source $OutputDir -Destination $ClientDir
    Write-Host "Client launcher ready: $ClientDir\WT8111Neo.Control.exe"
}
finally {
    Pop-Location
}
