export const AUTHENTICODE_FILE_PATH_ENV = "ADE_WINDOWS_AUTHENTICODE_FILE_PATH";

/**
 * Status the probe reports when Get-AuthenticodeSignature itself threw, as
 * opposed to answering. Callers treat it as retryable: the observed cause is
 * environmental (a virus scanner holding a just-written multi-GB installer),
 * not a property of the artifact.
 */
export const AUTHENTICODE_PROBE_ERROR_STATUS = "AdeProbeError";

export function createAuthenticodeProbe(filePath, baseEnv = process.env) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    throw new Error("Authenticode validation requires a file path.");
  }

  // A thrown Get-AuthenticodeSignature (file locked by a scanner, unreadable,
  // provider error) previously left $sig null, so every field stringified to
  // empty and the caller reported `not ... signed with a valid signature: `
  // with nothing after the colon — the one release-blocking failure that then
  // carried zero diagnosis. Catch it and put the exception message where the
  // caller already looks, under a status no real signature check can produce.
  const script = [
    "$result = $null",
    "try {",
    `  $sig = Get-AuthenticodeSignature -LiteralPath $env:${AUTHENTICODE_FILE_PATH_ENV} -ErrorAction Stop`,
    "  $result = [pscustomobject]@{",
    "    Status = [string]$sig.Status;",
    "    StatusMessage = [string]$sig.StatusMessage;",
    "    Subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null };",
    "    Thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { $null };",
    "    TimestampSubject = if ($sig.TimeStamperCertificate) { [string]$sig.TimeStamperCertificate.Subject } else { $null }",
    "  }",
    "} catch {",
    "  $result = [pscustomobject]@{",
    `    Status = "${AUTHENTICODE_PROBE_ERROR_STATUS}";`,
    "    StatusMessage = [string]$_.Exception.Message;",
    "    Subject = $null;",
    "    Thumbprint = $null;",
    "    TimestampSubject = $null",
    "  }",
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("\n");

  // Windows PowerShell 5.1 must not inherit PowerShell 7's PSModulePath. On
  // GitHub runners every workflow step runs under pwsh, which exports a
  // PSModulePath whose PS7 Microsoft.PowerShell.Security shadows 5.1's
  // built-in; 5.1 finds the Core-only module first and fails to load it, so
  // Get-AuthenticodeSignature dies with "the module could not be loaded" on
  // every probe -- which is exactly how the first signed release run failed.
  // Reproduced locally by pointing PSModulePath at a Core-only Security
  // module. Dropping the variable makes 5.1 rebuild its default module path.
  const env = {
    ...baseEnv,
    [AUTHENTICODE_FILE_PATH_ENV]: normalizedPath,
  };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") delete env[key];
  }

  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    env,
  };
}
