import { execFile } from "node:child_process";
import { resolveTrustedWindowsTool } from "./windowsSystemTools.js";

/**
 * Code-signing state of the runtime binary, for a support bundle.
 *
 * An embedder who signs their app but forgets the nested runtime does not get a
 * clean error — the process dies on launch under the hardened runtime, on a
 * user's machine, never on the developer's. `doctor().runtime.signature` is the
 * cheapest way to see that before a release goes out, so this probe never
 * throws and never blocks: a failure to read the state is reported as "not
 * known" (`null`), which is honest, rather than as "not signed", which is not.
 */

export type RuntimeSignature = {
  /** True when the OS reports a signature of any kind, ad-hoc included. */
  signed: boolean;
  /** The signing authority, when readable: a certificate subject or Team ID. */
  authority?: string;
  /** True when the OS accepts the binary for execution (Gatekeeper / a valid Authenticode chain). */
  accepted?: boolean;
};

export type SignatureCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * True when the command did not run to completion — a timeout, a kill, or a
   * spawn failure such as ENOENT.
   *
   * `code` cannot carry this. Node reports a timeout as `error.killed` with a
   * null code and a spawn failure as a string code like `"ENOENT"`, and both
   * used to collapse onto exit code 1, which `codesign` also uses for "not
   * signed at all". So a probe that never ran read back as a definitive "this
   * binary is unsigned" — the exact dishonesty this module refuses.
   */
  failed?: boolean;
};

/**
 * Injectable so the per-platform parsing is testable without a signed binary,
 * a macOS host, or a Windows host.
 */
export type SignatureCommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<SignatureCommandResult>;

export type ProbeRuntimeSignatureOptions = {
  platform?: NodeJS.Platform;
  spawn?: SignatureCommandRunner;
};

const PROBE_TIMEOUT_MS = 10_000;

const defaultRunner: SignatureCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const numericCode =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as unknown as { code: number }).code
            : null;
        // "The command answered with an exit code" versus "the command did not
        // run". A killed process (timeout) and a non-numeric code (ENOENT and
        // friends) are the second case, and must not be reported as an answer.
        const failed =
          Boolean(error) && (numericCode === null || (error as { killed?: unknown }).killed === true);
        resolve({
          code: numericCode ?? (error ? 1 : 0),
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(failed ? { failed: true } : {}),
        });
      },
    );
  });

/** PowerShell single-quoted literal: the only escape inside one is a doubled quote. */
function powerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `codesign -dv --verbose=2` writes its report to stderr. Both streams are
 * scanned so a future macOS release that moves it to stdout does not silently
 * turn every signed binary into an unsigned one.
 */
function parseCodesign(result: SignatureCommandResult): RuntimeSignature {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code !== 0) {
    // `codesign -dv` exits non-zero for "code object is not signed at all",
    // which is a real answer rather than a probe failure.
    return { signed: false };
  }
  const authority = /^Authority=(.+)$/m.exec(text)?.[1]?.trim();
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
  const team = teamIdentifier && teamIdentifier !== "not set" ? teamIdentifier : undefined;
  const resolved = authority || team;
  return resolved ? { signed: true, authority: resolved } : { signed: true };
}

async function probeMac(
  binaryPath: string,
  run: SignatureCommandRunner,
): Promise<RuntimeSignature | null> {
  let display: SignatureCommandResult;
  try {
    display = await run("/usr/bin/codesign", ["-dv", "--verbose=2", binaryPath], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  // The probe did not run at all, so there is no answer to parse. `null` says
  // "not known", which is the honest report; `{ signed: false }` would tell an
  // embedder their signing pipeline is broken because `codesign` took more
  // than ten seconds on a large binary.
  if (display.failed) return null;
  const signature = parseCodesign(display);
  if (!signature.signed) return signature;

  try {
    const assess = await run("/usr/sbin/spctl", ["--assess", "--type", "execute", binaryPath], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    // Gatekeeper could not be consulted, so acceptance stays unknown rather
    // than being reported as a rejection.
    if (assess.failed) return signature;
    return { ...signature, accepted: assess.code === 0 };
  } catch {
    // Gatekeeper could not be consulted. The signature facts still stand;
    // acceptance is simply unknown, so the field stays absent.
    return signature;
  }
}

async function probeWindows(
  binaryPath: string,
  run: SignatureCommandRunner,
): Promise<RuntimeSignature | null> {
  let powershell: string;
  try {
    powershell = resolveTrustedWindowsTool("powershell");
  } catch {
    // Refusing an untrusted PowerShell is the correct outcome; reporting the
    // binary as unsigned because of it would not be.
    return null;
  }

  // Structured argv, never a shell string: the path may contain spaces, and a
  // `%VAR%` in it cannot be escaped on a cmd.exe command line at all.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$signature = Get-AuthenticodeSignature -LiteralPath ${powerShellSingleQuotedLiteral(binaryPath)}`,
    "Write-Output ('status=' + $signature.Status)",
    "if ($signature.SignerCertificate) { Write-Output ('subject=' + $signature.SignerCertificate.Subject) }",
  ].join("; ");

  // PowerShell 7's PSModulePath shadows Windows PowerShell 5.1's own
  // Microsoft.PowerShell.Security module, which is where
  // Get-AuthenticodeSignature lives. Dropping the variable is the same fix
  // `apps/desktop/scripts/windows-authenticode.mjs` carries.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PSModulePath;

  let result: SignatureCommandResult;
  try {
    result = await run(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeoutMs: PROBE_TIMEOUT_MS, env },
    );
  } catch {
    return null;
  }
  if (result.failed || result.code !== 0) return null;

  const status = /^status=(.+)$/m.exec(result.stdout)?.[1]?.trim();
  if (!status) return null;
  if (status === "NotSigned") return { signed: false };

  const subject = /^subject=(.+)$/m.exec(result.stdout)?.[1]?.trim();
  const signature: RuntimeSignature = { signed: true, accepted: status === "Valid" };
  return subject ? { ...signature, authority: subject } : signature;
}

/**
 * Read the code-signing state of a runtime binary.
 *
 * Returns `null` on Linux (there is no OS-level signature to read), when the
 * probe could not run, and when its output could not be understood. Never
 * throws, and never takes longer than 10 s per command.
 */
export async function probeRuntimeSignature(
  binaryPath: string,
  options: ProbeRuntimeSignatureOptions = {},
): Promise<RuntimeSignature | null> {
  const platform = options.platform ?? process.platform;
  const run = options.spawn ?? defaultRunner;
  if (!binaryPath.trim()) return null;
  try {
    if (platform === "darwin") return await probeMac(binaryPath, run);
    if (platform === "win32") return await probeWindows(binaryPath, run);
    return null;
  } catch {
    return null;
  }
}
