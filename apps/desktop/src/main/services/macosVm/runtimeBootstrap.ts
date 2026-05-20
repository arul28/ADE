import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * In-guest agent runtime bootstrap.
 *
 * This module installs the ade-runtime binary inside the macOS guest using
 * SSH+SCP. v1 scaffolding ships a marker-only bootstrap script so the UI
 * flow can be exercised end-to-end; the actual runtime download/install will
 * land in a follow-up.
 *
 * Phases (each maps to a `onProgress` label):
 *   1. ssh-probe          — confirm host reachability + credentials.
 *   2. write-script       — drop the bootstrap shell script into a temp file.
 *   3. scp-script         — copy the script to the guest under /tmp.
 *   4. run-script         — execute the script via ssh.
 *   5. verify-marker      — ssh in once more to confirm the success marker.
 */

const SSH_BINARY = "/usr/bin/ssh";
const SCP_BINARY = "/usr/bin/scp";

/**
 * Resolve the `sshpass` binary across the macOS install layouts we see in the
 * wild: Apple Silicon Homebrew (`/opt/homebrew/bin`), Intel Homebrew
 * (`/usr/local/bin`), MacPorts (`/opt/local/bin`), and PATH for custom builds.
 * If nothing is found we still return the bare name so the eventual spawn
 * surfaces a clear `ENOENT` rather than dispatching to a phantom path.
 */
const SSHPASS_KNOWN_PATHS: readonly string[] = [
  "/opt/homebrew/bin/sshpass",
  "/usr/local/bin/sshpass",
  "/opt/local/bin/sshpass",
];

function resolveSshpassBinary(): string {
  for (const candidate of SSHPASS_KNOWN_PATHS) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and keep scanning
    }
  }
  const pathDirs = String(process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "sshpass");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "sshpass";
}

export type RuntimeBootstrapPhase =
  | "ssh-probe"
  | "write-script"
  | "scp-script"
  | "run-script"
  | "verify-marker";

export type RuntimeBootstrapProgress = (phase: RuntimeBootstrapPhase, message: string) => void;

export type InstallRuntimeArgs = {
  ipAddress: string;
  username: string;
  password: string;
  vmName: string;
  onProgress?: RuntimeBootstrapProgress | null;
  /** Override for tests; defaults to spawning ssh/scp/sshpass. */
  runner?: BootstrapRunner;
  /** Override the temp dir where the bootstrap script is staged on the host. */
  tempDir?: string;
};

export type InstallRuntimeResult = {
  ok: true;
  markerPath: string;
  detail: string;
};

export type BootstrapRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; stdin?: string | null; extraEnv?: NodeJS.ProcessEnv },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

function defaultRunner(
  command: string,
  args: string[],
  options: { timeoutMs: number; stdin?: string | null; extraEnv?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.extraEnv ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin?.end(options.stdin ?? undefined);
  });
}

const COMMON_SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=10",
];

/**
 * The bootstrap script that runs inside the guest.
 *
 * TODO: actually download + install the ade-runtime binary in the guest.
 *       v1 just writes a marker so the UI install-phase can be wired up
 *       end-to-end. The real script will:
 *         - download the matching ade-runtime release for the guest arch
 *         - place it under ~/.ade/bin/ade-runtime
 *         - chmod +x and run `ade-runtime --version` to verify
 *         - drop a launchd plist (or similar) for auto-start on next boot
 */
const GUEST_BOOTSTRAP_SCRIPT = `#!/bin/bash
set -euo pipefail
echo "ade-runtime-bootstrap: starting"
mkdir -p "$HOME/.ade/bin"
# TODO: actually download + install ade-runtime binary in the guest.
# Required artifacts (none yet packaged):
#   - ade-runtime release tarball for darwin-arm64 (matching desktop app version)
#   - signed launchd plist for ~/Library/LaunchAgents (auto-start on login)
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$HOME/.ade-runtime-installed"
echo "OK"
`;

/**
 * SSH usernames are interpolated into `user@host` so a `@` in the username
 * would let the actual host be hijacked. Reject anything that isn't a plain
 * shell-safe identifier; the credentials prompt enforces the same rule.
 */
function assertSshSafeUsername(username: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new Error(
      "Guest username contains characters that are not safe for SSH (allowed: letters, digits, '.', '_', '-').",
    );
  }
}

function buildSshCommand(args: InstallRuntimeArgs): { command: string; baseArgs: string[]; extraEnv?: NodeJS.ProcessEnv } {
  const { ipAddress, username, password } = args;
  assertSshSafeUsername(username);
  if (!password) {
    return {
      command: SSH_BINARY,
      baseArgs: [...COMMON_SSH_OPTS, `${username}@${ipAddress}`],
    };
  }
  // `sshpass -e` reads the password from the SSHPASS env var so it never
  // appears in argv (i.e. `ps aux` cannot see it).
  return {
    command: resolveSshpassBinary(),
    baseArgs: ["-e", SSH_BINARY, ...COMMON_SSH_OPTS, `${username}@${ipAddress}`],
    extraEnv: { SSHPASS: password },
  };
}

function buildScpCommand(
  args: InstallRuntimeArgs,
  source: string,
  remotePath: string,
): { command: string; baseArgs: string[]; extraEnv?: NodeJS.ProcessEnv } {
  const { ipAddress, username, password } = args;
  assertSshSafeUsername(username);
  const remote = `${username}@${ipAddress}:${remotePath}`;
  if (!password) {
    return {
      command: SCP_BINARY,
      baseArgs: [...COMMON_SSH_OPTS, source, remote],
    };
  }
  return {
    command: resolveSshpassBinary(),
    baseArgs: ["-e", SCP_BINARY, ...COMMON_SSH_OPTS, source, remote],
    extraEnv: { SSHPASS: password },
  };
}

export async function installAdeRuntimeInVm(args: InstallRuntimeArgs): Promise<InstallRuntimeResult> {
  const runner = args.runner ?? defaultRunner;
  const emit = (phase: RuntimeBootstrapPhase, message: string): void => {
    try {
      args.onProgress?.(phase, message);
    } catch {
      // Progress sink failures must not abort the install.
    }
  };

  if (!args.ipAddress.trim()) throw new Error("Guest IP address is required to install the agent runtime.");
  if (!args.username.trim()) throw new Error("Guest username is required to install the agent runtime.");
  if (!args.password) {
    throw new Error(
      "Guest password is required to install the agent runtime over SSH. "
      + "Save credentials in the VM tab before installing the runtime.",
    );
  }

  // 1. SSH probe.
  emit("ssh-probe", `Probing ${args.username}@${args.ipAddress} over SSH.`);
  const sshCommand = buildSshCommand(args);
  const probeResult = await runner(sshCommand.command, [...sshCommand.baseArgs, "echo", "ade-probe-ok"], {
    timeoutMs: 20_000,
    extraEnv: sshCommand.extraEnv,
  });
  if (probeResult.exitCode !== 0 || !/ade-probe-ok/.test(probeResult.stdout)) {
    const detail = (probeResult.stderr || probeResult.stdout || "").trim()
      || `SSH probe to ${args.username}@${args.ipAddress} failed (exit ${probeResult.exitCode ?? "unknown"}).`;
    throw new Error(detail);
  }

  // 2. Write the bootstrap script to a host-side temp file.
  emit("write-script", "Staging bootstrap script on the host.");
  const ownsTempDir = !args.tempDir;
  const tempDir = args.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-bootstrap-"));
  const localScriptPath = path.join(tempDir, "ade-runtime-bootstrap.sh");
  fs.writeFileSync(localScriptPath, GUEST_BOOTSTRAP_SCRIPT, { mode: 0o755 });

  try {
    // 3. scp the script into the guest.
    emit("scp-script", `Copying bootstrap script to ${args.ipAddress}:/tmp.`);
    const remoteScriptPath = "/tmp/ade-runtime-bootstrap.sh";
    const scpCommand = buildScpCommand(args, localScriptPath, remoteScriptPath);
    const scpResult = await runner(scpCommand.command, scpCommand.baseArgs, {
      timeoutMs: 30_000,
      extraEnv: scpCommand.extraEnv,
    });
    if (scpResult.exitCode !== 0) {
      const detail = (scpResult.stderr || scpResult.stdout || "").trim()
        || `scp of bootstrap script failed (exit ${scpResult.exitCode ?? "unknown"}).`;
      throw new Error(detail);
    }

    // 4. Run the script via ssh.
    emit("run-script", "Running bootstrap script inside the guest.");
    const runResult = await runner(sshCommand.command, [
      ...sshCommand.baseArgs,
      "bash",
      remoteScriptPath,
    ], { timeoutMs: 120_000, extraEnv: sshCommand.extraEnv });
    if (runResult.exitCode !== 0 || !/\bOK\b/.test(runResult.stdout)) {
      const detail = (runResult.stderr || runResult.stdout || "").trim()
        || `Bootstrap script exited with code ${runResult.exitCode ?? "unknown"}.`;
      throw new Error(detail);
    }

    // 5. Verify the success marker.
    emit("verify-marker", "Verifying ade-runtime installation marker.");
    // We don't know the guest's HOME, so build the marker path from the
    // conventional macOS user home for surface display only. The actual
    // check runs in the remote shell against $HOME.
    const markerPath = `/Users/${args.username}/.ade-runtime-installed`;
    const verifyResult = await runner(sshCommand.command, [
      ...sshCommand.baseArgs,
      "test",
      "-f",
      "$HOME/.ade-runtime-installed",
      "&&",
      "cat",
      "$HOME/.ade-runtime-installed",
    ], { timeoutMs: 15_000, extraEnv: sshCommand.extraEnv });
    if (verifyResult.exitCode !== 0) {
      const detail = (verifyResult.stderr || verifyResult.stdout || "").trim()
        || `Marker verification failed (exit ${verifyResult.exitCode ?? "unknown"}).`;
      throw new Error(detail);
    }

    return {
      ok: true,
      markerPath,
      detail: `ade-runtime bootstrap completed on ${args.username}@${args.ipAddress}.`,
    };
  } finally {
    // Best-effort cleanup of the staged bootstrap script so repeated runs do
    // not leak host temp files. If the caller supplied `tempDir`, we only
    // remove the script we created inside it (the caller owns the directory).
    try {
      if (ownsTempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } else {
        fs.rmSync(localScriptPath, { force: true });
      }
    } catch {
      // ignore
    }
  }
}
