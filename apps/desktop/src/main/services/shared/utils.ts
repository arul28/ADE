/**
 * Shared backend utility functions.
 *
 * These were previously duplicated across 10+ service files.
 * Import from here instead of re-declaring locally.
 */

import path from "node:path";

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
