<#
.SYNOPSIS
    Downloads and silently installs Certum SimplySign Desktop MSI on Windows runners.
.DESCRIPTION
    Handles downloading the designated version of SimplySign Desktop 64-bit MSI installer,
    running msiexec in silent mode (/qn) with comprehensive logging, and validating that
    the executable was installed successfully.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$version = if ($env:INPUT_VERSION) { $env:INPUT_VERSION } else { '9.4.4.92' }
$url = $env:INPUT_DOWNLOAD_URL
if (-not $url) {
    $url = "https://files.certum.eu/software/SimplySignDesktop/Windows/$version/SimplySignDesktop-$version-64-bit-en.msi"
}

$appPath = if ($env:INPUT_APP_PATH) { $env:INPUT_APP_PATH } else { 'C:\Program Files\Certum\SimplySign Desktop\SimplySignDesktop.exe' }
$isDebug = ($env:INPUT_DEBUG -eq 'true')

Write-Host "=== Certum SimplySign Desktop Installation ==="
Write-Host "Target Version: $version"
Write-Host "Download URL  : $url"
Write-Host "Expected Path : $appPath"

# 1. Check if SimplySign Desktop is already installed
if (Test-Path $appPath) {
    Write-Host "SimplySign Desktop is already installed at: $appPath"
    try {
        $fileVer = (Get-Item $appPath).VersionInfo.ProductVersion
        Write-Host "Detected installed version: $fileVer"
    } catch {
        # ignore version read errors
    }
    exit 0
}

$tempDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$msiPath = Join-Path $tempDir "SimplySignDesktop-$version.msi"
$logPath = Join-Path $tempDir "install.log"

# 2. Download MSI with retry logic
$maxRetries = 3
$downloaded = $false

for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
    try {
        Write-Host "Downloading SimplySign Desktop (Attempt $attempt of $maxRetries)..."
        # Enable TLS 1.2 / TLS 1.3
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls13
        
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($url, $msiPath)
        
        if ((Test-Path $msiPath) -and ((Get-Item $msiPath).Length -gt 1048576)) {
            $sizeMb = [Math]::Round((Get-Item $msiPath).Length / 1MB, 2)
            Write-Host "Successfully downloaded MSI (${sizeMb} MB) to: $msiPath"
            $downloaded = $true
            break
        } else {
            Write-Warning "Downloaded file is too small or missing. Retrying..."
        }
    } catch {
        Write-Warning "Download attempt $attempt failed: $($_.Exception.Message)"
        if ($attempt -lt $maxRetries) {
            Start-Sleep -Seconds ($attempt * 3)
        }
    }
}

if (-not $downloaded) {
    Write-Error "Failed to download SimplySign Desktop from $url after $maxRetries attempts."
    exit 1
}

# 3. Silently install MSI
Write-Host "Installing SimplySign Desktop via msiexec (silent mode)..."
Write-Host "Installer Log: $logPath"

$msiArgs = @(
    "/i",
    "`"$msiPath`"",
    "/qn",
    "/norestart",
    "/l*!",
    "`"$logPath`""
)

$proc = Start-Process -FilePath "msiexec.exe" -ArgumentList ($msiArgs -join " ") -Wait -PassThru -NoNewWindow
$exitCode = $proc.ExitCode
Write-Host "msiexec completed with exit code: $exitCode"

# Exit codes: 0 = Success, 3010 = Success (Reboot required)
if ($exitCode -ne 0 -and $exitCode -ne 3010) {
    Write-Error "msiexec failed with exit code $exitCode."
    if (Test-Path $logPath) {
        Write-Host "--- Tail of install.log ---"
        Get-Content $logPath -Tail 50 | ForEach-Object { Write-Host $_ }
        Write-Host "---------------------------"
    }
    exit $exitCode
}

# 4. Verify binary exists on disk
if (-not (Test-Path $appPath)) {
    # Check alternate Program Files (x86)
    $altPath = 'C:\Program Files (x86)\Certum\SimplySign Desktop\SimplySignDesktop.exe'
    if (Test-Path $altPath) {
        Write-Host "Found SimplySign Desktop at alternative location: $altPath"
        $appPath = $altPath
        if ($env:GITHUB_ENV) {
            Add-Content -Path $env:GITHUB_ENV -Value "CERTUM_APP_PATH=$altPath"
        }
    } else {
        Write-Error "Installation completed but SimplySign Desktop executable was not found at $appPath."
        exit 1
    }
}

Write-Host "SimplySign Desktop installed and verified at: $appPath"
exit 0
