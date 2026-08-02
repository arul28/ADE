[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath,
  [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail([string]$Message) {
  throw "ADE Windows runtime signing: $Message"
}

function Normalize-Thumbprint([string]$Value) {
  return ($Value -replace '\s+', '').ToUpperInvariant()
}

$resolvedBinary = [IO.Path]::GetFullPath($BinaryPath)
if (-not (Test-Path -LiteralPath $resolvedBinary -PathType Leaf)) {
  Fail "runtime binary is missing: $resolvedBinary"
}

$certificateSource = [string]$env:WINDOWS_CSC_LINK
$certificatePassword = [string]$env:WINDOWS_CSC_KEY_PASSWORD
$expectedSubject = ([string]$env:WINDOWS_SIGNING_EXPECTED_SUBJECT).Trim()
$expectedThumbprint = Normalize-Thumbprint ([string]$env:WINDOWS_SIGNING_EXPECTED_THUMBPRINT)
if ([string]::IsNullOrWhiteSpace($certificateSource) -or [string]::IsNullOrWhiteSpace($certificatePassword)) {
  Fail "WINDOWS_CSC_LINK and WINDOWS_CSC_KEY_PASSWORD are required"
}
if ([string]::IsNullOrWhiteSpace($expectedSubject) -and [string]::IsNullOrWhiteSpace($expectedThumbprint)) {
  Fail "WINDOWS_SIGNING_EXPECTED_SUBJECT or WINDOWS_SIGNING_EXPECTED_THUMBPRINT is required"
}

$certificatePath = Join-Path ([IO.Path]::GetTempPath()) ("ade-runtime-signing-" + [Guid]::NewGuid().ToString("N") + ".pfx")
try {
  $trimmedSource = $certificateSource.Trim()
  if (Test-Path -LiteralPath $trimmedSource -PathType Leaf) {
    Copy-Item -LiteralPath $trimmedSource -Destination $certificatePath
  } elseif ($trimmedSource.StartsWith("file://", [StringComparison]::OrdinalIgnoreCase)) {
    $sourceUri = [Uri]$trimmedSource
    Copy-Item -LiteralPath $sourceUri.LocalPath -Destination $certificatePath
  } elseif ($trimmedSource.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) {
    Invoke-WebRequest -UseBasicParsing -Uri $trimmedSource -OutFile $certificatePath
  } elseif ($trimmedSource.StartsWith("http://", [StringComparison]::OrdinalIgnoreCase)) {
    Fail "WINDOWS_CSC_LINK must use HTTPS, a local path, or an encoded certificate payload"
  } else {
    try {
      [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($trimmedSource))
    } catch {
      Fail "WINDOWS_CSC_LINK is not a valid certificate path, HTTPS URL, or Base64 payload"
    }
  }

  $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [IO.File]::ReadAllBytes($certificatePath),
    $certificatePassword,
    $flags
  )
  try {
    if (-not $certificate.HasPrivateKey) {
      Fail "the configured certificate has no private key"
    }

    $signingResult = Set-AuthenticodeSignature `
      -LiteralPath $resolvedBinary `
      -Certificate $certificate `
      -HashAlgorithm SHA256 `
      -TimestampServer $TimestampServer
    if ($signingResult.Status -ne [Management.Automation.SignatureStatus]::Valid) {
      Fail "runtime signing failed with status $($signingResult.Status)"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $resolvedBinary
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
      Fail "signed runtime validation failed with status $($signature.Status)"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
      Fail "signed runtime has no trusted Authenticode timestamp"
    }
    $actualSubject = ([string]$signature.SignerCertificate.Subject).Trim()
    $actualThumbprint = Normalize-Thumbprint ([string]$signature.SignerCertificate.Thumbprint)
    if ($expectedSubject -and -not [string]::Equals($actualSubject, $expectedSubject, [StringComparison]::OrdinalIgnoreCase)) {
      Fail "signed runtime publisher subject does not match WINDOWS_SIGNING_EXPECTED_SUBJECT"
    }
    if ($expectedThumbprint -and -not [string]::Equals($actualThumbprint, $expectedThumbprint, [StringComparison]::Ordinal)) {
      Fail "signed runtime certificate does not match WINDOWS_SIGNING_EXPECTED_THUMBPRINT"
    }
  } finally {
    $certificate.Dispose()
  }

  Write-Output "Signed and validated the standalone Windows runtime."
} finally {
  Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
}
