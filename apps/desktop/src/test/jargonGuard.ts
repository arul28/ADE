import { expect } from "vitest";

// Bare "SQL" intentionally subsumes "SQLite" so user-facing copy cannot
// mention either; keep this the single owner of the banned-term list.
export const JARGON_PATTERN = /socket|SQL|launchd|CRR|JSONL|WAL|ENOSPC/i;

export function expectNoJargon(text: string): void {
  expect(text).not.toMatch(JARGON_PATTERN);
}
