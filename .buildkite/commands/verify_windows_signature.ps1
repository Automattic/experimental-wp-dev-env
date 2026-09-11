$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$artifacts = @(Get-ChildItem -Path "dist\*.exe" -File -ErrorAction SilentlyContinue)
if ($artifacts.Count -eq 0) {
    Write-Host "[!] No Windows .exe artifacts found in dist."
    exit 1
}

if ([string]::IsNullOrWhiteSpace($env:SIGNTOOL_PATH)) {
    Write-Host "[!] SIGNTOOL_PATH is not set."
    exit 1
}

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_EXPECTED_SIGNER_SUBJECT)) {
    Write-Host "[!] WINDOWS_EXPECTED_SIGNER_SUBJECT must be set to verify the artifact signer identity."
    exit 1
}

foreach ($artifact in $artifacts) {
    Write-Host "Verifying Authenticode signature for $($artifact.FullName)"
    & $env:SIGNTOOL_PATH verify /pa /v $artifact.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $signature = Get-AuthenticodeSignature -FilePath $artifact.FullName
    if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
        Write-Host "[!] $($artifact.Name) does not have a valid Authenticode signature."
        Write-Host "Status: $($signature.Status)"
        exit 1
    }

    $actualSubject = $signature.SignerCertificate.Subject
    if ($actualSubject.IndexOf($env:WINDOWS_EXPECTED_SIGNER_SUBJECT.Trim(), [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Write-Host "[!] $($artifact.Name) was not signed by the expected subject."
        Write-Host "Expected subject to contain: $($env:WINDOWS_EXPECTED_SIGNER_SUBJECT.Trim())"
        Write-Host "Actual signer subject:       $actualSubject"
        exit 1
    }

    if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_EXPECTED_SIGNER_ISSUER)) {
        $actualIssuer = $signature.SignerCertificate.Issuer
        if ($actualIssuer.IndexOf($env:WINDOWS_EXPECTED_SIGNER_ISSUER.Trim(), [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Write-Host "[!] $($artifact.Name) was not signed by the expected issuer."
            Write-Host "Expected issuer to contain: $($env:WINDOWS_EXPECTED_SIGNER_ISSUER.Trim())"
            Write-Host "Actual signer issuer:       $actualIssuer"
            exit 1
        }
    }

    Write-Host "$($artifact.Name) signer identity verified."
}
