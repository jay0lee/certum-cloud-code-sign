<#
.SYNOPSIS
    Verifies that Certum code signing certificates are available in the Windows certificate store
    and discovers the x64 signtool.exe path.
.DESCRIPTION
    Polls Cert:\CurrentUser\My until a valid code signing certificate (with private key)
    appears, logs its details, sets Action outputs, discovers x64 signtool.exe, and adds
    signtool to the system PATH.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$timeoutSeconds = if ($env:INPUT_TIMEOUT) { [int]$env:INPUT_TIMEOUT } else { 60 }
$targetSha1 = if ($env:INPUT_CERT_SHA1) { $env:INPUT_CERT_SHA1.Replace(' ', '').Trim().ToUpper() } else { '' }
$screenshotsDir = if ($env:INPUT_SCREENSHOTS_DIR) { $env:INPUT_SCREENSHOTS_DIR } else { (Join-Path $env:RUNNER_TEMP "certum-screenshots") }
$isDebug = ($env:INPUT_DEBUG -eq 'true')

Write-Host "=== Verifying Certum Certificate Store ==="
Write-Host "Timeout (seconds) : $timeoutSeconds"
if ($targetSha1) {
    Write-Host "Target Thumbprint : $targetSha1"
} else {
    Write-Host "Target            : Any valid Code Signing / Certum certificate"
}

$startTime = [DateTime]::UtcNow
$foundCert = $null
$allCerts = @()

while (([DateTime]::UtcNow - $startTime).TotalSeconds -lt $timeoutSeconds) {
    $allCerts = @(Get-ChildItem -Path Cert:\CurrentUser\My -ErrorAction SilentlyContinue)

    if ($allCerts.Count -gt 0) {
        if ($targetSha1) {
            $foundCert = $allCerts | Where-Object { $_.Thumbprint.ToUpper() -eq $targetSha1 } | Select-Object -First 1
        } else {
            # Find certificates with Code Signing EKU (1.3.6.1.5.5.7.3.3) or issued by Certum
            $codeSigningCerts = $allCerts | Where-Object {
                $isCodeSigning = $false
                foreach ($eku in $_.EnhancedKeyUsageList) {
                    if ($eku.ObjectId -eq '1.3.6.1.5.5.7.3.3' -or $eku.FriendlyName -like '*Code Signing*') {
                        $isCodeSigning = $true
                        break
                    }
                }
                $isCertum = $_.Issuer -like '*Certum*'
                return ($isCodeSigning -or $isCertum)
            }

            if ($codeSigningCerts) {
                # Prefer cert with private key available
                $withKey = $codeSigningCerts | Where-Object { $_.HasPrivateKey } | Select-Object -First 1
                $foundCert = if ($withKey) { $withKey } else { $codeSigningCerts | Select-Object -First 1 }
            }
        }

        if ($foundCert) {
            break
        }
    }

    $elapsed = [Math]::Round(([DateTime]::UtcNow - $startTime).TotalSeconds)
    Write-Host "Waiting for certificate to appear in Cert:\CurrentUser\My ($elapsed/${timeoutSeconds}s)..."
    Start-Sleep -Seconds 3
}

if (-not $foundCert) {
    Write-Error "No matching certificate was found in Cert:\CurrentUser\My within $timeoutSeconds seconds."
    
    Write-Host "`n--- Current Certificates in Cert:\CurrentUser\My ---"
    if ($allCerts.Count -eq 0) {
        Write-Host "Store is empty."
    } else {
        foreach ($c in $allCerts) {
            Write-Host "Thumbprint: $($c.Thumbprint)"
            Write-Host "Subject   : $($c.Subject)"
            Write-Host "Issuer    : $($c.Issuer)"
            Write-Host "Private Key: $($c.HasPrivateKey)"
            Write-Host "-------------------------------------------"
        }
    }

    # Dump logs if available
    Write-Host "`n--- Diagnostic Logs ---"
    $ssdOutLog = Join-Path $screenshotsDir "ssd_out.log"
    $ssdErrLog = Join-Path $screenshotsDir "ssd_err.log"
    $installLog = Join-Path $env:RUNNER_TEMP "install.log"

    if (Test-Path $ssdOutLog) {
        Write-Host "--- ssd_out.log ---"
        Get-Content $ssdOutLog | ForEach-Object { Write-Host $_ }
    }
    if (Test-Path $ssdErrLog) {
        Write-Host "--- ssd_err.log ---"
        Get-Content $ssdErrLog | ForEach-Object { Write-Host $_ }
    }
    if (Test-Path $installLog) {
        Write-Host "--- install.log (tail 30) ---"
        Get-Content $installLog -Tail 30 | ForEach-Object { Write-Host $_ }
    }

    exit 1
}

Write-Host "`n=== Certificate Verified Successfully ==="
Write-Host "Subject        : $($foundCert.Subject)"
Write-Host "Issuer         : $($foundCert.Issuer)"
Write-Host "Thumbprint     : $($foundCert.Thumbprint)"
Write-Host "Valid From     : $($foundCert.NotBefore.ToString('yyyy-MM-dd HH:mm:ss UTC'))"
Write-Host "Valid To       : $($foundCert.NotAfter.ToString('yyyy-MM-dd HH:mm:ss UTC'))"
Write-Host "Has Private Key: $($foundCert.HasPrivateKey)"

# Set GitHub Action outputs
if ($env:GITHUB_OUTPUT) {
    Add-Content -Path $env:GITHUB_OUTPUT -Value "cert-thumbprint=$($foundCert.Thumbprint)"
    Add-Content -Path $env:GITHUB_OUTPUT -Value "cert-subject=$($foundCert.Subject)"
    Add-Content -Path $env:GITHUB_OUTPUT -Value "cert-issuer=$($foundCert.Issuer)"
    Add-Content -Path $env:GITHUB_OUTPUT -Value "cert-expiration=$($foundCert.NotAfter.ToString('o'))"
    Add-Content -Path $env:GITHUB_OUTPUT -Value "cert-count=$($allCerts.Count)"
}

# Set GitHub Action environment variables for convenience
if ($env:GITHUB_ENV) {
    Add-Content -Path $env:GITHUB_ENV -Value "CERTUM_CERT_THUMBPRINT=$($foundCert.Thumbprint)"
    Add-Content -Path $env:GITHUB_ENV -Value "CERTUM_CERT_SUBJECT=$($foundCert.Subject)"
}

# 2. Discover x64 signtool.exe
# Note: Always explicitly use x64 version of signtool.exe on both x64 and ARM64 Windows,
# as SimplySign Desktop virtual driver is 64-bit and ARM64 signtool cannot interface with it.
Write-Host "`n=== Locating x64 signtool.exe ==="
$signtoolPath = $null

$searchPaths = @(
    "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
    "C:\Program Files\Windows Kits\10\bin\*\x64\signtool.exe"
)

foreach ($searchPattern in $searchPaths) {
    $matches = Get-ChildItem -Path $searchPattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
    if ($matches) {
        $signtoolPath = $matches[0].FullName
        break
    }
}

if (-not $signtoolPath) {
    # Check if signtool is in PATH
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $signtoolPath = $cmd.Source
    }
}

if ($signtoolPath -and (Test-Path $signtoolPath)) {
    Write-Host "Found signtool: $signtoolPath"
    $signtoolDir = Split-Path -Path $signtoolPath -Parent

    # Add signtool directory to GITHUB_PATH so callers can invoke 'signtool' directly
    if ($env:GITHUB_PATH) {
        Add-Content -Path $env:GITHUB_PATH -Value $signtoolDir
        Write-Host "Added to GITHUB_PATH: $signtoolDir"
    }

    if ($env:GITHUB_OUTPUT) {
        Add-Content -Path $env:GITHUB_OUTPUT -Value "signtool-path=$signtoolPath"
    }
    if ($env:GITHUB_ENV) {
        Add-Content -Path $env:GITHUB_ENV -Value "CERTUM_SIGNTOOL_PATH=$signtoolPath"
    }

    # Verify signtool runs
    try {
        $signtoolHelp = & $signtoolPath /? 2>&1
        Write-Host "Verified signtool executable runs properly."
    } catch {
        Write-Warning "Could not execute signtool test: $($_.Exception.Message)"
    }
} else {
    Write-Warning "x64 signtool.exe was not found in standard Windows SDK locations."
    Write-Warning "Ensure Windows 10/11 SDK is installed on the runner if signing with signtool.exe."
}

Write-Host "`n=== Ready for Signing ==="
Write-Host "Example signing command:"
Write-Host "signtool sign /sha1 $($foundCert.Thumbprint) /tr http://time.certum.pl /td SHA256 /fd SHA256 /v <target-binary>"
exit 0
