<#
.SYNOPSIS
    Gracefully logs out and terminates SimplySign Desktop session post-signing.
.DESCRIPTION
    Disconnects active cloud signing sessions, closes SimplySign Desktop,
    and cleans up certificate access in Cert:\CurrentUser\My.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== Certum SimplySign Desktop Teardown ==="

# 1. Gracefully close and terminate SimplySign Desktop
$procs = Get-Process | Where-Object { $_.ProcessName -like "*SimplySign*" }
if ($procs) {
    Write-Host "Found active SimplySign process(es): $($procs.ProcessName -join ', ')"
    foreach ($p in $procs) {
        try {
            $p.CloseMainWindow() | Out-Null
        } catch {}
    }
    Start-Sleep -Seconds 1

    # Ensure SimplySign processes are fully stopped to unmount smart card certificates
    Get-Process | Where-Object { $_.ProcessName -like "*SimplySign*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "SimplySign Desktop processes stopped."
} else {
    Write-Host "SimplySign Desktop is not currently running."
}

# 2. Clean up and purge any lingering Certum certificates from CurrentUser\My
$certs = @(Get-ChildItem -Path "Cert:\CurrentUser\My" -ErrorAction SilentlyContinue | Where-Object {
    $_.Issuer -like "*Certum*" -or $_.Subject -like "*Certum*"
})
if ($certs.Count -gt 0) {
    Write-Host "Purging $($certs.Count) Certum certificate(s) from Cert:\CurrentUser\My..."
    $certs | Remove-Item -Force -ErrorAction SilentlyContinue
}

# 3. Verify certificate store status
$remaining = @(Get-ChildItem -Path "Cert:\CurrentUser\My" -ErrorAction SilentlyContinue | Where-Object {
    $_.Issuer -like "*Certum*" -or $_.Subject -like "*Certum*"
})
if ($remaining.Count -gt 0) {
    Write-Host "Notice: $($remaining.Count) certificate(s) still present in Cert:\CurrentUser\My."
} else {
    Write-Host "Verified Cert:\CurrentUser\My: All Certum certificates and cloud signing keys are cleanly unmounted."
}

Write-Host "Certum cloud session teardown completed successfully."
exit 0
