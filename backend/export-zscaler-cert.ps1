#
# Exports this machine's Zscaler root CA from the Windows certificate store
# to backend/zscaler-root-ca.crt (PEM), so the backend Docker image can trust
# whatever TLS-inspecting proxy this machine's network actually uses.
#
# Run this once per machine (and again if Docker build starts failing with
# CERTIFICATE_VERIFY_FAILED, which usually means the cert rotated) before
# `docker compose build backend`.
#

$cert = Get-ChildItem -Path Cert:\LocalMachine\Root, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like "*Zscaler*" } |
    Select-Object -First 1

if (-not $cert) {
    Write-Error "No Zscaler root certificate found in the Windows certificate store. Is this machine on the Zscaler network?"
    exit 1
}

$outPath = Join-Path $PSScriptRoot "zscaler-root-ca.crt"
$base64 = [Convert]::ToBase64String($cert.RawData, [Base64FormattingOptions]::InsertLineBreaks)
$pem = "-----BEGIN CERTIFICATE-----`n$base64`n-----END CERTIFICATE-----`n"

Set-Content -Path $outPath -Value $pem -NoNewline

Write-Host "Exported '$($cert.Subject)' to $outPath"
