import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { sha256Hex, stableStringify } from "../shared/utils";

type JsonRecord = Record<string, unknown>;

function sha256Record(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function readJsonl(filePath: string): { entries: JsonRecord[]; raw: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], raw: "" };
    throw err;
  }
  const entries: JsonRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as JsonRecord);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return { entries, raw };
}

function withPrevHashes(entries: JsonRecord[]): JsonRecord[] {
  const next: JsonRecord[] = [];
  let previousPayload: JsonRecord | null = null;
  for (const entry of entries) {
    const payload = { ...entry };
    payload.prevHash = previousPayload ? sha256Record(previousPayload) : "genesis";
    next.push(payload);
    previousPayload = payload;
  }
  return next;
}

function writeJsonl(filePath: string, entries: JsonRecord[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  fs.writeFileSync(filePath, body, "utf8");
}

export function createLogIntegrityService(args: { logger?: Logger | null } = {}) {
  // Cache the hash of the last entry per file to avoid re-reading on every append.
  const lastHashCache = new Map<string, string>();

  const normalizeJsonlFile = (filePath: string): { changed: boolean; count: number } => {
    const { entries: originalEntries, raw: existingBody } = readJsonl(filePath);
    const normalizedEntries = withPrevHashes(originalEntries);
    const normalizedBody = normalizedEntries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    if (normalizedBody !== existingBody) {
      writeJsonl(filePath, normalizedEntries);
      args.logger?.info?.("ade.log_integrity.normalized", { filePath, count: normalizedEntries.length });
      if (normalizedEntries.length > 0) {
        lastHashCache.set(filePath, sha256Record(normalizedEntries[normalizedEntries.length - 1]!));
      }
      return { changed: true, count: normalizedEntries.length };
    }
    if (normalizedEntries.length > 0) {
      lastHashCache.set(filePath, sha256Record(normalizedEntries[normalizedEntries.length - 1]!));
    }
    return { changed: false, count: normalizedEntries.length };
  };

  const appendEntry = <T extends JsonRecord>(filePath: string, entry: T): T & { prevHash: string } => {
    let prevHash = lastHashCache.get(filePath);
    if (prevHash === undefined) {
      // Cold start: read just the last entry's hash
      const { entries } = readJsonl(filePath);
      if (entries.length > 0) {
        const normalized = withPrevHashes(entries);
        prevHash = sha256Record(normalized[normalized.length - 1]!);
      } else {
        prevHash = "genesis";
      }
    }
    const next = { ...entry, prevHash } as T & { prevHash: string };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(next)}\n`, "utf8");
    lastHashCache.set(filePath, sha256Record(next));
    return next;
  };

  return {
    normalizeJsonlFile,
    appendEntry,
  };
}

export type LogIntegrityService = ReturnType<typeof createLogIntegrityService>;
