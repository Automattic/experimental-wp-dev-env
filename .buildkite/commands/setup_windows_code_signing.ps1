# Configures Windows code signing via Azure Trusted Signing.
#
# `setup_azure_trusted_signing.ps1` (a8c-ci-toolkit) installs signtool + the Azure DLib and
# exports the env vars that `scripts/azure-sign.cjs` reads during `npm run dist:win`. It also runs
# a signing smoke test that fails here, with diagnostics, if the Azure credentials are wrong.
# Host prep (native compilation tools, Python, Windows 10 SDK) is pre-provisioned in the custom
# Windows AMI as of a8c-ci-toolkit 6.0.0, so there is no separate host-preparation step.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

& "setup_azure_trusted_signing.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

function Assert-SigningToolIntegrity {
    param (
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedSha256EnvVar
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        Write-Host "[!] $Description path is not set."
        exit 1
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host "[!] $Description was not found at $Path."
        exit 1
    }

    $expectedSha256 = [Environment]::GetEnvironmentVariable($ExpectedSha256EnvVar)
    if (-not [string]::IsNullOrWhiteSpace($expectedSha256)) {
        $actualSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
        if ($actualSha256 -ne $expectedSha256.Trim().ToUpperInvariant()) {
            Write-Host "[!] $Description SHA256 mismatch."
            Write-Host "Expected: $($expectedSha256.Trim().ToUpperInvariant())"
            Write-Host "Actual:   $actualSha256"
            exit 1
        }

        Write-Host "$Description SHA256 matched $ExpectedSha256EnvVar."
        return
    }

    $signature = Get-AuthenticodeSignature -FilePath $Path
    if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
        Write-Host "[!] $Description does not have a valid Authenticode signature."
        Write-Host "Status: $($signature.Status)"
        exit 1
    }

    $subject = $signature.SignerCertificate.Subject
    if ($subject.IndexOf("Microsoft", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Write-Host "[!] $Description is not signed by an expected Microsoft certificate."
        Write-Host "Actual signer subject: $subject"
        exit 1
    }

    Write-Host "$Description Authenticode signature is valid: $subject"
}

Assert-SigningToolIntegrity `
    -Path $env:SIGNTOOL_PATH `
    -Description "signtool.exe" `
    -ExpectedSha256EnvVar "WINDOWS_SIGNTOOL_SHA256"

Assert-SigningToolIntegrity `
    -Path $env:AZURE_CODE_SIGNING_DLIB `
    -Description "Azure Trusted Signing DLib" `
    -ExpectedSha256EnvVar "AZURE_CODE_SIGNING_DLIB_SHA256"
