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
  /** The person's last Allow of an OS keyring read, by provider (a desktop only): when, the slot, and the key it wrote. */
  keychain?: Record<string, { allowedAt: number; slot: string; key: string }>;
  /**
   * The write-back (step 3b), by vault key: the newer copy a cloud computer
   * renewed, which ADE wrote into this computer's login file. `contentHash`
   * is what capture reads back from it, so capture never pushes it again.
   */
  writtenBack?: Record<string, WrittenBack>;
  /**
   * This computer's sign-ins it removed from the account because the person
   * signed out here, by vault key, with the time. A copy that comes back into
   * the account while the person is still signed out here is removed again.
   */
  signedOut?: Record<string, number>;
  /**
   * The person turned on the copy of this computer's GitHub CLI login for
   * Copilot (P5 G1): when, and the last `gh` read (the marker file's stat, the
   * result, the gh user), so a failed read waits for the file to change and a
   * restart of the brain reads nothing. Never the token. Per account: a sign-out
   * of ADE removes this file, and another account starts with it off.
   */
  ghCli?: GhCliChoice;
};

export type GhCliChoice = {
  allowedAt: number;
  read?: { mark: string; at: number; result: "ok" | "classic_token" | "no_token" | "not_installed" | "timeout" | "failed"; user: string | null };
};

/**
 * One write-back: `contentHash` is the file here as read back, `accountHash`
 * the account copy it came from (they can differ: Kimi's config part).
 */
export type WrittenBack = { contentHash: string; familyHash: string; at: number; renewedBy: string; accountHash?: string };

export function emptyState(accountUserId: string | null): ProviderLoginStateFile {
  return { v: 1, accountUserId, bundles: {}, pushed: {} };
}

function providerLoginStatePath(adeDir: string): string {
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
    ...(isRecord(parsed.keychain) ? { keychain: parsed.keychain as NonNullable<ProviderLoginStateFile["keychain"]> } : {}),
    ...(isRecord(parsed.writtenBack) ? { writtenBack: parsed.writtenBack as Record<string, WrittenBack> } : {}),
    ...(isRecord(parsed.signedOut) ? { signedOut: parsed.signedOut as Record<string, number> } : {}),
    ...(isRecord(parsed.ghCli) && typeof parsed.ghCli.allowedAt === "number" ? { ghCli: parsed.ghCli as GhCliChoice } : {}),
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
