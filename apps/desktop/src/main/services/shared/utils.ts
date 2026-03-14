/**
 * Shared backend utility functions.
 *
 * These were previously duplicated across 10+ service files.
 * Import from here instead of re-declaring locally.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// ── Type guards ─────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── Coercion helpers ────────────────────────────────────────────────

export function asString(value: unknown, fallback: string = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── Timestamps ──────────────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString();
}

// ── Error handling ──────────────────────────────────────────────────

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isEnoentError(error: unknown): boolean {
  return error != null && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT";
}

export function toMemoryEntryDto<T extends { embedded?: boolean }>(memory: T): T & { embedded: boolean } {
  return { ...memory, embedded: memory.embedded === true };
}

// ── Array helpers ───────────────────────────────────────────────────

export function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ── Async helpers ──────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Git helpers ─────────────────────────────────────────────────────

export function parseDiffNameOnly(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ── Safe JSON parsing ───────────────────────────────────────────────

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Path helpers ────────────────────────────────────────────────────

/** Returns true if `candidate` is equal to or nested inside `root`. */
export function isWithinDir(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ── String helpers ──────────────────────────────────────────────────

/** Return trimmed string or null if empty/non-string. */
export function toOptionalString(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : null;
}

// ── File helpers ────────────────────────────────────────────────────

/** Write text to a file atomically (write to tmp, rename). */
export function writeTextAtomic(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup errors
      }
      throw error;
    }
  }
}

/** Return file size or 0 if the file doesn't exist. */
export function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ── Filesystem existence checks ─────────────────────────────────────

export function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read at most `maxBytes` from a file. Returns empty string on any error.
 */
export function safeReadText(absPath: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.slice(0, Math.max(0, read)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ── Path normalization ─────────────────────────────────────────────

/** Normalize a relative path to forward slashes, strip leading "./" or "/". */
export function normalizeRelative(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

// ── Binary detection ───────────────────────────────────────────────

/** Strip refs/heads/ and origin/ prefixes from a branch name. */
export function normalizeBranchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

/** Returns true if the buffer contains a null byte in the first 8192 bytes. */
export function hasNullByte(buf: Buffer): boolean {
  const max = Math.min(buf.length, 8192);
  for (let i = 0; i < max; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ── Date/time helpers ───────────────────────────────────────────────

/** Parse ISO string to epoch ms, or NaN if invalid/missing. */
export function parseIsoToEpoch(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : Number.NaN;
}

// ── Hashing helpers ─────────────────────────────────────────────────

/** SHA-256 hex digest of a string or Buffer. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON.stringify with sorted keys (deep). */
export function stableStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((entry) => normalize(entry));
    if (input && typeof input === "object") {
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        next[key] = normalize((input as Record<string, unknown>)[key]);
      }
      return next;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

// ── Glob / pattern matching ─────────────────────────────────────────

export function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim();
  if (!normalized.length) return /^$/;
  const parts = normalized.split("*").map((chunk) => escapeRegExp(chunk));
  return new RegExp(`^${parts.join(".*")}$`, "i");
}

export function matchesGlob(pattern: string | null | undefined, value: string | null | undefined): boolean {
  const expected = (pattern ?? "").trim();
  if (!expected) return true;
  const actual = (value ?? "").trim();
  if (!actual) return false;
  return globToRegExp(expected).test(actual);
}

export function normalizeSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

// ── Secret detection helpers ────────────────────────────────────────

const ENV_REF_PATTERN = /^\$\{env:[A-Z0-9_]+\}$/;
const ENV_REF_TOKEN_PATTERN = /\$\{env:[A-Z0-9_]+\}/;

export function isEnvRef(value: string): boolean {
  return ENV_REF_PATTERN.test(value.trim());
}

export function hasEnvRefToken(value: string): boolean {
  return ENV_REF_TOKEN_PATTERN.test(value);
}

export function looksSensitiveKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|authorization)/i.test(key);
}

export function looksSensitiveValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.length) return false;
  if (/^bearer\s+/i.test(trimmed)) return true;
  if (/^sk-[a-z0-9]{12,}/i.test(trimmed)) return true;
  if (/^gh[pousr]_[a-z0-9]{20,}/i.test(trimmed)) return true;
  if (/^xox[baprs]-[a-z0-9-]{10,}/i.test(trimmed)) return true;
  if (/api[_-]?key|secret|token|password/i.test(trimmed)) return true;
  return false;
}
