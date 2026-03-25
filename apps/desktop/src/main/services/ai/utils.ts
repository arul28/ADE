import { spawnSync } from "node:child_process";

export function commandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("where", [command], { encoding: "utf8" });
      return result.status === 0;
    }
    const result = spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], { encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
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
