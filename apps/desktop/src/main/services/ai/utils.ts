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
/**
 * The last answer for each command. `checkedAt` is when the last probe that
 * finished for it returned, or 0 while none has. A probe that fails leaves both
 * fields as they were, so the next call past the TTL probes again at once.
 */
const commandExistsCache = new Map<string, { available: boolean; checkedAt: number }>();
/** The probe in flight for each command. A caller that asks again joins it. */
const commandExistsRefreshing = new Map<string, Promise<void>>();

/**
 * `commandExists`, run off the event loop. Resolves `null` when the probe could
 * not run or timed out: that says nothing about the command, so the caller keeps
 * its last answer instead of reading a hung probe as "not installed". The probe
 * starts before this function returns, so a caller can count it at once.
 */
async function commandExistsOffThread(command: string): Promise<boolean | null> {
  const { file, args } = commandExistsProbe(command);
  if (offThreadSpawnEnabled()) {
    const result = await execFileOffThread(file, args, { timeoutMs: COMMAND_EXISTS_PROBE_TIMEOUT_MS });
    return result.exitCode === null ? null : result.exitCode === 0;
  }
  return new Promise((resolve) => {
    execFile(file, args, { timeout: COMMAND_EXISTS_PROBE_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (!error) resolve(true);
      else resolve(typeof error.code === "number" ? false : null);
    });
  });
}

/**
 * Starts a probe for `command`, unless one is already in flight. The returned
 * promise settles once the cache holds the probe's answer.
 */
function refreshCommandExists(command: string): Promise<void> {
  const inFlight = commandExistsRefreshing.get(command);
  if (inFlight) return inFlight;
  const refresh = commandExistsOffThread(command)
    .catch(() => null)
    .then((available) => {
      if (available !== null) {
        commandExistsCache.set(command, { available, checkedAt: Date.now() });
      } else if (!commandExistsCache.has(command)) {
        // Never answered: report "not installed", as a failed `commandExists` does,
        // but leave checkedAt at 0 so the next call probes again.
        commandExistsCache.set(command, { available: false, checkedAt: 0 });
      }
    })
    .finally(() => {
      commandExistsRefreshing.delete(command);
    });
  commandExistsRefreshing.set(command, refresh);
  return refresh;
}

/** Starts a background probe when the cached answer for `command` is past its TTL. */
function refreshIfStale(command: string): void {
  const cached = commandExistsCache.get(command);
  if (cached && Date.now() - cached.checkedAt >= COMMAND_EXISTS_CACHE_MS) void refreshCommandExists(command);
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
 * synchronously, once per process, unless a probe for it is already running
 * (see {@link prewarmCommandExists}). In that case there is no answer to give
 * and a second probe would block the loop, so this returns `false` and caches
 * nothing. {@link settleCommandExists} lets an async caller wait for the answer.
 */
export function commandExistsCached(command: string): boolean {
  const cached = commandExistsCache.get(command);
  if (cached) {
    refreshIfStale(command);
    return cached.available;
  }
  if (commandExistsRefreshing.has(command)) return false;
  const available = commandExists(command);
  commandExistsCache.set(command, { available, checkedAt: Date.now() });
  return available;
}

/** Starts the first probe of each command in the background, so its first `commandExistsCached` call does not block. */
export function prewarmCommandExists(commands: readonly string[]): void {
  for (const command of commands) {
    if (!commandExistsCache.has(command)) void refreshCommandExists(command);
  }
}

/**
 * Makes sure each command has an answer in the cache, so the next
 * `commandExistsCached` call for it reads the cache and does not probe. A command
 * that already has an answer is not waited for: a stale one refreshes in the
 * background, as `commandExistsCached` does. Only a command with no answer yet
 * waits, for its first probe, and joins a probe that is already running.
 *
 * Returns `null` when nothing had to wait, so a caller that awaits only a
 * non-null result keeps its synchronous path while the cache is warm.
 */
export function settleCommandExists(commands: readonly string[]): Promise<void> | null {
  const firstProbes: Promise<void>[] = [];
  for (const command of commands) {
    if (commandExistsCache.has(command)) refreshIfStale(command);
    else firstProbes.push(refreshCommandExists(command));
  }
  return firstProbes.length > 0 ? Promise.all(firstProbes).then(() => undefined) : null;
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
