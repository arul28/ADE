import { spawnSync } from "node:child_process";

export function commandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("where", [command], {
        encoding: "utf8",
        windowsHide: true,
      });
      return result.status === 0;
    }
    const result = spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const COMMAND_EXISTS_CACHE_MS = 60_000;
const commandExistsCache = new Map<string, { available: boolean; checkedAt: number }>();

/**
 * `commandExists` with a short memory. Each probe is a synchronous login shell
 * (~10-20 ms on macOS, where `path_helper` runs), so callers on per-message or
 * per-tool paths must not probe every time: it blocks the brain's event loop.
 */
export function commandExistsCached(command: string): boolean {
  const nowMs = Date.now();
  const cached = commandExistsCache.get(command);
  if (cached && nowMs - cached.checkedAt < COMMAND_EXISTS_CACHE_MS) return cached.available;
  const available = commandExists(command);
  commandExistsCache.set(command, { available, checkedAt: nowMs });
  return available;
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
