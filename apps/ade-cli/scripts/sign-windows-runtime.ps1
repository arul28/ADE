[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath,
  # Azure Artifact Signing certificates are valid for 72 hours, so an RFC3161
  # countersignature is what keeps a released binary verifiable past that.
  [string]$TimestampServer = "http://timestamp.acs.microsoft.com"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail([string]$Message) {
  throw "ADE Windows runtime signing: $Message"
}

$resolvedBinary = [IO.Path]::GetFullPath($BinaryPath)
if (-not (Test-Path -LiteralPath $resolvedBinary -PathType Leaf)) {
  Fail "runtime binary is missing: $resolvedBinary"
}

# The signing key is held by Azure Artifact Signing and never leaves it, so the
# only credential this script carries is a Microsoft Entra service principal.
# These three names are exactly what Azure.Identity's EnvironmentCredential
# reads, and EnvironmentCredential is tried before any managed-identity probe,
# which a GitHub-hosted runner cannot satisfy.
$missingCredentials = @(
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET"
) | Where-Object { [string]::IsNullOrWhiteSpace([string][Environment]::GetEnvironmentVariable($_)) }
if ($missingCredentials.Count -gt 0) {
  Fail "$($missingCredentials -join ', ') are required to sign with Azure Artifact Signing"
}

$signingEndpoint = ([string]$env:WINDOWS_SIGNING_ENDPOINT).Trim()
if ([string]::IsNullOrWhiteSpace($signingEndpoint)) {
  $signingEndpoint = "https://eus.codesigning.azure.net"
}
$signingAccountName = ([string]$env:WINDOWS_SIGNING_ACCOUNT_NAME).Trim()
if ([string]::IsNullOrWhiteSpace($signingAccountName)) {
  $signingAccountName = "arulsigning"
}
$certificateProfileName = ([string]$env:WINDOWS_SIGNING_CERTIFICATE_PROFILE).Trim()
if ([string]::IsNullOrWhiteSpace($certificateProfileName)) {
  $certificateProfileName = "adePublicTrust"
}

$expectedSubject = ([string]$env:WINDOWS_SIGNING_EXPECTED_SUBJECT).Trim()
if ([string]::IsNullOrWhiteSpace($expectedSubject)) {
  Fail "WINDOWS_SIGNING_EXPECTED_SUBJECT is required so the runtime cannot be signed by an unexpected publisher"
}
# Azure Artifact Signing renews its certificate daily and expires it after 72
# hours. A pinned thumbprint would reject every release within days, so the name
# is rejected rather than ignored - an ignored pin is a pin nobody notices is gone.
if (-not [string]::IsNullOrWhiteSpace(([string]$env:WINDOWS_SIGNING_EXPECTED_THUMBPRINT).Trim())) {
  Fail "WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported by the Azure Artifact Signing pipeline; the service renews its certificate daily and expires it after 72 hours. Unset it and pin WINDOWS_SIGNING_EXPECTED_SUBJECT instead"
}

# Same signing mechanism electron-builder 26 uses for the desktop installer, so
# the desktop and standalone Windows artifacts go through one code path with one
# set of verified parameter names. Microsoft's successor module is
# `ArtifactSigning` (`Invoke-ArtifactSigning`), which the current GitHub Action
# uses; electron-builder 26.8.1 hardcodes `TrustedSigning` and only moves off it
# in v27, which replaces the module with `signtool /dlib`. Migrate both together
# when the desktop build moves, so the two Windows artifacts never diverge.
if (-not (Get-Module -ListAvailable -Name TrustedSigning)) {
  if ($null -eq (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
  }
  Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser
}
Import-Module TrustedSigning -Force

Invoke-TrustedSigning `
  -Endpoint $signingEndpoint `
  -CodeSigningAccountName $signingAccountName `
  -CertificateProfileName $certificateProfileName `
  -Files $resolvedBinary `
  -FileDigest "SHA256" `
  -TimestampRfc3161 $TimestampServer `
  -TimestampDigest "SHA256"

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedBinary
if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
  Fail "signed runtime validation failed with status $($signature.Status)"
}
if ($null -eq $signature.TimeStamperCertificate) {
  Fail "signed runtime has no trusted Authenticode timestamp"
}
$actualSubject = ([string]$signature.SignerCertificate.Subject).Trim()
if (-not [string]::Equals($actualSubject, $expectedSubject, [StringComparison]::OrdinalIgnoreCase)) {
  Fail "signed runtime publisher subject does not match WINDOWS_SIGNING_EXPECTED_SUBJECT"
}

Write-Output "Signed and validated the standalone Windows runtime."
