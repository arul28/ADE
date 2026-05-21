import { spawn } from "node:child_process";

/**
 * macOS Keychain-backed credentials store for VM guest accounts.
 *
 * keytar is not a dependency in this repo, so this implementation shells out
 * to the macOS `security` CLI. The credential lives in the user's login
 * keychain under service `ade-macos-vm-<vmName>` with account `ade-cli`.
 *
 * The stored payload is `${username}\n${password}` so the username can be
 * read back without the password. Renderers receive only a summary; the
 * password never crosses the IPC boundary.
 */

const SECURITY_BINARY = "/usr/bin/security";
const ACCOUNT = "ade-cli";

export type StoredCredentials = {
  username: string;
  password: string;
  savedAt: string;
};

export type CredentialsRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; stdin?: string | null },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

type CreateCredentialsStoreArgs = {
  platform?: NodeJS.Platform;
  runCommand?: CredentialsRunner;
};

function serviceName(vmName: string): string {
  const trimmed = vmName.trim();
  if (!trimmed) throw new Error("VM name is required for credential storage.");
  return `ade-macos-vm-${trimmed}`;
}

/**
 * Usernames flow into `user@host` SSH targets, so a `@` (or whitespace, or
 * shell-control char) would let a malicious credential entry redirect SSH to
 * a different host. Mirror the rule that `runtimeBootstrap` enforces so a bad
 * username never reaches Keychain in the first place.
 */
function assertSafeUsername(username: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new Error(
      "Guest username must contain only letters, digits, '.', '_', or '-' (no '@', spaces, or special characters).",
    );
  }
}

function encodePayload(username: string, password: string, savedAt: string): string {
  return JSON.stringify({ username, password, savedAt });
}

function decodePayload(raw: string): StoredCredentials | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<StoredCredentials>;
    if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
    return {
      username: parsed.username,
      password: parsed.password,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; stdin?: string | null },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // `clearKill` defaults to true so error/exit paths cancel the pending
    // SIGKILL fallback. The timeout path passes false so the SIGKILL still
    // fires 500 ms later if the child keeps ignoring SIGTERM.
    const finish = (
      result: { exitCode: number | null; stdout: string; stderr: string },
      clearKill = true,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (clearKill && killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      // Match macosVmService.ts: try SIGTERM, then SIGKILL 500 ms later,
      // and settle the promise even if the child never exits so callers
      // never await indefinitely (e.g. a permission dialog blocking
      // `security add-generic-password`).
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 500);
      finish(
        {
          exitCode: null,
          stdout,
          stderr: stderr || `${command} timed out after ${options.timeoutMs}ms.`,
        },
        false,
      );
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
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      finish({ exitCode, stdout, stderr });
    });
    child.stdin?.end(options.stdin ?? undefined);
  });
}

export type CredentialsStore = {
  saveCredentials(vmName: string, username: string, password: string): Promise<{ savedAt: string }>;
  loadCredentials(vmName: string): Promise<StoredCredentials | null>;
  clearCredentials(vmName: string): Promise<boolean>;
};

export function createCredentialsStore(args: CreateCredentialsStoreArgs = {}): CredentialsStore {
  const platform = args.platform ?? process.platform;
  const runCommand = args.runCommand ?? defaultRunCommand;

  const requireMac = (): void => {
    if (platform !== "darwin") {
      throw new Error("macOS Keychain-backed credential storage is only available on macOS.");
    }
  };

  return {
    async saveCredentials(vmName, username, password) {
      requireMac();
      const trimmedUsername = username.trim();
      if (!trimmedUsername) throw new Error("Guest username cannot be empty.");
      assertSafeUsername(trimmedUsername);
      if (!password) throw new Error("Guest password cannot be empty.");
      const savedAt = new Date().toISOString();
      const payload = encodePayload(trimmedUsername, password, savedAt);
      const result = await runCommand(SECURITY_BINARY, [
        "add-generic-password",
        "-a",
        ACCOUNT,
        "-s",
        serviceName(vmName),
        "-w",
        payload,
        "-U",
      ], { timeoutMs: 10_000 });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(detail || `security add-generic-password exited with code ${result.exitCode ?? "unknown"}`);
      }
      return { savedAt };
    },

    async loadCredentials(vmName) {
      requireMac();
      const result = await runCommand(SECURITY_BINARY, [
        "find-generic-password",
        "-a",
        ACCOUNT,
        "-s",
        serviceName(vmName),
        "-w",
      ], { timeoutMs: 5_000 });
      if (result.exitCode !== 0) {
        const stderr = (result.stderr || result.stdout || "").trim();
        if (/could not be found/i.test(stderr)) return null;
        // Distinguish "item not in keychain" (legitimate null) from other
        // failures (permission denied, security daemon down, etc.) so we
        // surface them rather than silently pretending no creds exist.
        throw new Error(
          stderr || `security find-generic-password exited with code ${result.exitCode ?? "unknown"}`,
        );
      }
      return decodePayload(result.stdout);
    },

    async clearCredentials(vmName) {
      requireMac();
      const result = await runCommand(SECURITY_BINARY, [
        "delete-generic-password",
        "-a",
        ACCOUNT,
        "-s",
        serviceName(vmName),
      ], { timeoutMs: 5_000 });
      if (result.exitCode === 0) return true;
      if (/could not be found/i.test(result.stderr || result.stdout || "")) return false;
      const detail = (result.stderr || result.stdout || "").trim();
      throw new Error(detail || `security delete-generic-password exited with code ${result.exitCode ?? "unknown"}`);
    },
  };
}
