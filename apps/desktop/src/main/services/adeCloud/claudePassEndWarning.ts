/**
 * The end warning's one fact (`cloudAccess.read().passEnd`), computed here in
 * desktop main from the account's vault: one `list` of the account vault over
 * the brain bridge, then the same parse and state as the pass card
 * (`summarizeClaudePass`). No network, no token leaves this file.
 *
 * Two kinds of sign-in can be named:
 * - A Claude pass. Due: Claude ended the pass, its expected end has passed, or
 *   its notice is due (`noticeDueAt`, 7 days before the expected end).
 * - A key ADE Cloud carries whose end date the provider itself wrote (a
 *   `fixed` sign-in with `expiresAt`: today Cursor's key from the Cursor
 *   sign-in, `apiKeyExpiresAtMs`). Due 7 days before that date, and ended once
 *   it is past. A key with no end date from its provider is never named, and
 *   a sign-in that renews itself is not a key. Only keys that are on for ADE
 *   Cloud count (the account setting, read only when one is due).
 *
 * The soonest wins; an ended one first.
 */
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type { CloudPassEnd } from "../../../shared/cloudSignIns";
import { readCloudSetting } from "../../../shared/providerLoginsCloudSetting";
import type { AccountVaultItem, AccountVaultResult } from "../../../shared/types/accountVault";
import { CLAUDE_PASS_NOTICE_MS, CLAUDE_PASS_VAULT_KIND, parseClaudePass, summarizeClaudePass } from "./claudePassStore";
import { isClaudePassKey } from "../../../shared/types/providerLogins";
import { PROVIDER_LOGIN_VAULT_KIND, parseProviderLoginKey, readProviderLoginMeta } from "../providerLogins/providerLoginPayload";

export type ClaudePassEndList = (scope: string) => Promise<AccountVaultResult<AccountVaultItem[]>>;
/** The account setting `providerLogins.cloud`, raw; null when it can't be read. */
export type CloudSignInSettingRead = () => Promise<unknown>;

const DAY_MS = 24 * 60 * 60_000;

function keyEnd(row: AccountVaultItem, now: number): CloudPassEnd | null {
  if (!parseProviderLoginKey(row.key)) return null;
  const meta = readProviderLoginMeta(row.value);
  if (!meta || meta.class !== "fixed" || meta.expiresAt == null || !Number.isFinite(meta.expiresAt)) return null;
  const left = meta.expiresAt - now;
  const state: CloudPassEnd["state"] | null = left <= 0 ? "ended" : left <= CLAUDE_PASS_NOTICE_MS ? "ending" : null;
  if (!state) return null;
  return {
    kind: "key",
    provider: meta.provider,
    madeOnLabel: meta.origin.label || null,
    key: row.key,
    state,
    email: meta.account?.email ?? null,
    expiresAt: meta.expiresAt,
    endedAt: state === "ended" ? meta.expiresAt : null,
    endsInDays: Math.max(0, Math.floor(left / DAY_MS)),
    more: 0,
    fingerprint: "",
  };
}

export async function readClaudePassEnd(
  list: ClaudePassEndList,
  now: number = Date.now(),
  readSetting?: CloudSignInSettingRead,
): Promise<CloudPassEnd | null> {
  const result = await list(ACCOUNT_SCOPE_ALL);
  if (!result.ok) return null;
  const due: CloudPassEnd[] = [];
  const keys: CloudPassEnd[] = [];
  for (const row of result.value) {
    if (row.deleted || !row.value) continue;
    if (row.kind === PROVIDER_LOGIN_VAULT_KIND && !isClaudePassKey(row.key)) {
      const end = keyEnd(row, now);
      if (end) keys.push(end);
      continue;
    }
    if (row.kind !== CLAUDE_PASS_VAULT_KIND || !isClaudePassKey(row.key)) continue;
    const pass = parseClaudePass(row.value);
    if (!pass) continue;
    const summary = summarizeClaudePass(row.key, pass, now);
    const state: CloudPassEnd["state"] | null = summary.state === "ended"
      ? "ended"
      : summary.state === "estimate_passed"
        ? "estimate_passed"
        : summary.noticeDueAt <= now ? "ending" : null;
    if (!state) continue;
    due.push({
      kind: "claude_pass",
      key: row.key,
      state,
      email: summary.email,
      expiresAt: summary.expiresAt,
      endedAt: summary.endedAt,
      endsInDays: summary.endsInDays,
      more: 0,
      fingerprint: "",
    });
  }
  if (keys.length > 0) {
    // A key switched off for ADE Cloud (or all of them off) is not ADE Cloud's to warn about.
    // A setting that can't be read counts as absent: on, as the sync reads it.
    const setting = readCloudSetting(readSetting ? await readSetting().catch(() => null) : null);
    if (setting.enabled) due.push(...keys.filter((end) => !setting.off.includes(end.key)));
  }
  if (due.length === 0) return null;
  due.sort((a, b) => ((a.state === "ended") === (b.state === "ended") ? a.expiresAt - b.expiresAt : a.state === "ended" ? -1 : 1));
  const fingerprint = due.map((entry) => `${entry.key}:${entry.state}`).sort().join("|");
  return { ...due[0]!, more: due.length - 1, fingerprint };
}
