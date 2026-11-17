/**
 * The last ADE Cloud answer for each account, on disk, for the brain. A brain
 * that just started asks the server a few seconds in; until then its agents'
 * skills (the `ade-cloud` skill and the guidance that names the skill roots)
 * follow the answer this brain last had for the signed-in account, so a chat
 * resumed right after a restart gets the same prompt as before it. The server
 * answer replaces it as soon as it comes.
 *
 * One small JSON file under the brain's own folder. It holds the account
 * directory, the account id and a yes or no for each account: no token, no
 * secret. Only fs and path here, so the brain can read it on its boot path.
 */

import fs from "node:fs";
import path from "node:path";

/** At most this many accounts are kept; the oldest answer goes first. */
const MAX_REMEMBERED_ACCOUNTS = 8;

type RememberedAnswers = Record<string, { enabled: boolean; at: number }>;

let memoryFile: string | null = null;
/** The file's answers, read once; undefined until then. */
let remembered: RememberedAnswers | undefined;

/** One account on one account directory: the key of the answer, in memory and on disk. */
export function cloudAccessKey(directoryBaseUrl: string | null, accountId: string | null): string {
  return `${directoryBaseUrl ?? ""}|${accountId ?? ""}`;
}

/** Where this process keeps its answers. Only the brain sets it; elsewhere nothing is read or written. */
export function useCloudAccessMemory(file: string | null): void {
  memoryFile = file;
  remembered = undefined;
}

function readAnswers(): RememberedAnswers {
  if (remembered) return remembered;
  remembered = {};
  if (!memoryFile) return remembered;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
    const answers = parsed && typeof parsed === "object" ? (parsed as { answers?: unknown }).answers : null;
    if (answers && typeof answers === "object") {
      for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
        const entry = value as { enabled?: unknown; at?: unknown } | null;
        if (typeof entry?.enabled === "boolean" && typeof entry.at === "number") {
          remembered[key] = { enabled: entry.enabled, at: entry.at };
        }
      }
    }
  } catch {
    // No file yet, or one that cannot be read: no answer is remembered.
  }
  return remembered;
}

/** The last answer this brain had for the account, or null when it has none. */
export function rememberedCloudAccess(key: string): boolean | null {
  if (!memoryFile || key.endsWith("|")) return null;
  return readAnswers()[key]?.enabled ?? null;
}

/** Keeps the server's answer for the account. Writes only when the answer changed. */
export function rememberCloudAccess(key: string, enabled: boolean): void {
  if (!memoryFile || key.endsWith("|")) return;
  const answers = readAnswers();
  if (answers[key]?.enabled === enabled) return;
  answers[key] = { enabled, at: Date.now() };
  const kept = Object.entries(answers)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_REMEMBERED_ACCOUNTS);
  remembered = Object.fromEntries(kept);
  const tmp = `${memoryFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, answers: remembered })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, memoryFile);
  } catch {
    // The answer stays in memory; the next change tries the write again.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}
