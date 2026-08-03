export const AUTHENTICODE_FILE_PATH_ENV = "ADE_WINDOWS_AUTHENTICODE_FILE_PATH";

export function createAuthenticodeProbe(filePath, baseEnv = process.env) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    throw new Error("Authenticode validation requires a file path.");
  }

  const script = [
    `$sig = Get-AuthenticodeSignature -LiteralPath $env:${AUTHENTICODE_FILE_PATH_ENV}`,
    "[pscustomobject]@{",
    "  Status = [string]$sig.Status;",
    "  StatusMessage = [string]$sig.StatusMessage;",
    "  Subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null };",
    "  Thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { $null };",
    "  TimestampSubject = if ($sig.TimeStamperCertificate) { [string]$sig.TimeStamperCertificate.Subject } else { $null }",
    "} | ConvertTo-Json -Compress",
  ].join("\n");

  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    env: {
      ...baseEnv,
      [AUTHENTICODE_FILE_PATH_ENV]: normalizedPath,
    },
  };
}
