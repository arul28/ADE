/**
 * The local marks of the sign-in sync: what each login file looked like on
 * the last pass, and what this computer last put into the account. Marks and
 * short hashes only; never a token, a key or a file's content.
 *
 * `<adeDir>/provider-logins/state.json`, mode 600. A different account at
 * load starts it over, so marks never cross accounts.
 */

import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../state/durableFile";
import { isRecord } from "../shared/utils";

export type FileMark = { rel: string; mtimeMs: number; size: number; ino: number } | { rel: string; missing: true };

export type BundleMarks = {
  files: FileMark[];
};

export type PushedLogin = {
  /** `contentHash` of the copy this computer last wrote to the account. */
  pushedHash: string;
  /** Short hash of the token family, so a sign-in the person removed stays removed until a new sign-in. */
  familyHash: string;
  pushedAt: number;
  /** The file was gone at this time; two passes 60 s apart remove the sign-in. */
  absentSince: number | null;
  absentPasses: number;
};

export type ProviderLoginStateFile = {
  v: 1;
  accountUserId: string | null;
  bundles: Record<string, BundleMarks>;
  pushed: Record<string, PushedLogin>;
};

export function emptyState(accountUserId: string | null): ProviderLoginStateFile {
  return { v: 1, accountUserId, bundles: {}, pushed: {} };
}

export function providerLoginStatePath(adeDir: string): string {
  return path.join(adeDir, "provider-logins", "state.json");
}

export function readProviderLoginState(adeDir: string, accountUserId: string | null): ProviderLoginStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(providerLoginStatePath(adeDir), "utf8"));
  } catch {
    return emptyState(accountUserId);
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.accountUserId !== accountUserId) return emptyState(accountUserId);
  return {
    v: 1,
    accountUserId,
    bundles: isRecord(parsed.bundles) ? parsed.bundles as Record<string, BundleMarks> : {},
    pushed: isRecord(parsed.pushed) ? parsed.pushed as Record<string, PushedLogin> : {},
  };
}

export function writeProviderLoginState(adeDir: string, state: ProviderLoginStateFile): void {
  const filePath = providerLoginStatePath(adeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export function removeProviderLoginState(adeDir: string): void {
  fs.rmSync(providerLoginStatePath(adeDir), { force: true });
}

export function sameMarks(left: readonly FileMark[] | undefined, right: readonly FileMark[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((mark, index) => JSON.stringify(mark) === JSON.stringify(right[index]));
}
