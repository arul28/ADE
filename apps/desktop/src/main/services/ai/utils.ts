import { execFile, spawnSync } from "node:child_process";
import { execFileOffThread, offThreadSpawnEnabled } from "../shared/offThreadSpawn";

/** The probe for one command: `where` on Windows, a login shell's `command -v` elsewhere. */
function commandExistsProbe(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "where", args: [command] };
  return { file: "sh", args: ["-lc", `command -v ${command} >/dev/null 2>&1`] };
}

export function commandExists(command: string): boolean {
  try {
    const { file, args } = commandExistsProbe(command);
    const result = spawnSync(file, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const COMMAND_EXISTS_CACHE_MS = 60_000;
const COMMAND_EXISTS_PROBE_TIMEOUT_MS = 10_000;
const commandExistsCache = new Map<string, { available: boolean; checkedAt: number }>();
const commandExistsRefreshing = new Set<string>();

/**
 * `commandExists`, run off the event loop. Resolves `null` when the probe could
 * not run or timed out: that says nothing about the command, so the caller keeps
 * its last answer instead of reading a hung probe as "not installed".
 */
function commandExistsOffThread(command: string): Promise<boolean | null> {
  const { file, args } = commandExistsProbe(command);
  if (offThreadSpawnEnabled()) {
    return execFileOffThread(file, args, { timeoutMs: COMMAND_EXISTS_PROBE_TIMEOUT_MS })
      .then((result) => (result.exitCode === null ? null : result.exitCode === 0));
  }
  return new Promise((resolve) => {
    execFile(file, args, { timeout: COMMAND_EXISTS_PROBE_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (!error) resolve(true);
      else resolve(typeof error.code === "number" ? false : null);
    });
  });
}

/** One background probe per command at a time; its answer lands in the cache when it finishes. */
function refreshCommandExists(command: string): void {
  if (commandExistsRefreshing.has(command)) return;
  commandExistsRefreshing.add(command);
  void commandExistsOffThread(command)
    .catch(() => null)
    .then((available) => {
      // A probe that could not run keeps the last answer, and retries after the next TTL.
      const last = commandExistsCache.get(command)?.available ?? false;
      commandExistsCache.set(command, { available: available ?? last, checkedAt: Date.now() });
    })
    .finally(() => {
      commandExistsRefreshing.delete(command);
    });
}

/**
 * `commandExists` with a short memory that never blocks the brain's event loop
 * after the first answer. Each probe is a login shell (10-20 ms on macOS, where
 * `path_helper` runs; 40 ms on Windows for `where`), and callers on per-message
 * paths ask on every send.
 *
 * A cached answer is returned at once, whatever its age. Once it is older than
 * the TTL, the call starts a background probe; the first call made after that
 * probe finishes returns the new answer. A command with no answer yet is probed
 * synchronously, once per process, unless {@link prewarmCommandExists} already
 * started it.
 */
export function commandExistsCached(command: string): boolean {
  const cached = commandExistsCache.get(command);
  if (cached) {
    if (Date.now() - cached.checkedAt >= COMMAND_EXISTS_CACHE_MS) refreshCommandExists(command);
    return cached.available;
  }
  const available = commandExists(command);
  commandExistsCache.set(command, { available, checkedAt: Date.now() });
  return available;
}

/** Starts the first probe of each command in the background, so its first `commandExistsCached` call does not block. */
export function prewarmCommandExists(commands: readonly string[]): void {
  for (const command of commands) {
    if (!commandExistsCache.has(command)) refreshCommandExists(command);
  }
}

export function isCursorAdminApiKey(value: string | null | undefined): boolean {
  return Boolean(value?.trim().startsWith("key_"));
}

export function extractFirstJsonObject(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("{") && raw.endsWith("}")) return raw;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }

  const first = raw.indexOf("{");
  if (first >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = first; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(first, index + 1);
        }
      }
    }
  }

  return null;
}

export function parseStructuredOutput(text: string): unknown {
  const candidate = extractFirstJsonObject(text);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const boundedTimeout = Math.max(1_000, Math.floor(timeoutMs || 0));
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), boundedTimeout);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
