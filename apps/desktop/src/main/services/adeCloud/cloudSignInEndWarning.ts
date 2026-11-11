/**
 * The end warning's one fact (`cloudAccess.read().signInEnd`), computed here in
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
 *   a sign-in that renews itself is not a key. Only the key ADE Cloud uses for
 *   its place counts: on for ADE Cloud (the account setting, read only when
 *   one is due), and the place's pick by the apply pass's own rule
 *   (`cloudPlacePicks`), so an older copy or a key the saved key beats
 *   is never named.
 *
 * The soonest wins; an ended one first.
 */
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { SIGN_IN_END_NOTICE_MS, type CloudSignInEnd } from "../../../shared/cloudSignIns";
import { readCloudSetting, type ProviderLoginsCloudSetting } from "../../../shared/providerLoginsCloudSetting";
import type { AccountVaultItem, AccountVaultResult } from "../../../shared/types/accountVault";
import { isClaudePassKey } from "../../../shared/types/providerLogins";
import { getErrorMessage } from "../shared/utils";
import { CLAUDE_PASS_VAULT_KIND, parseClaudePass, summarizeClaudePass } from "./claudePassStore";
import { PROVIDER_LOGIN_VAULT_KIND, parseProviderLoginKey, readProviderLoginMeta } from "../providerLogins/providerLoginPayload";
import { cloudPlacePicks, savedKeyTokenOf, savedKeyVaultKey } from "../providerLogins/providerLoginSyncShared";

export type CloudSignInEndList = (scope: string) => Promise<AccountVaultResult<AccountVaultItem[]>>;
/** The account setting `providerLogins.cloud`, raw; throws when it can't be read. */
export type CloudSignInSettingRead = () => Promise<unknown>;

const DAY_MS = 24 * 60 * 60_000;

function keyEnd(row: AccountVaultItem, now: number): CloudSignInEnd | null {
  if (!parseProviderLoginKey(row.key)) return null;
  const meta = readProviderLoginMeta(row.value);
  if (!meta || meta.class !== "fixed" || meta.expiresAt == null || !Number.isFinite(meta.expiresAt)) return null;
  const left = meta.expiresAt - now;
  const state: CloudSignInEnd["state"] | null = left <= 0 ? "ended" : left <= SIGN_IN_END_NOTICE_MS ? "ending" : null;
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

/** The vault keys of the sign-ins ADE Cloud uses, one per place, by the apply pass's own rule. */
function signInsInUse(rows: readonly AccountVaultItem[], setting: ProviderLoginsCloudSetting): Set<string> {
  const picks = cloudPlacePicks(rows, setting, {
    usable: (row) => Boolean(row.value),
    meta: (row) => readProviderLoginMeta(row.value),
    savedKeyToken: (id) => savedKeyTokenOf(
      rows.find((row) => row.kind === "integration" && row.key === savedKeyVaultKey(id) && !row.deleted)?.value,
    ),
  });
  const inUse = new Set<string>();
  for (const picked of picks.values()) {
    if ("signIn" in picked) inUse.add(picked.signIn.row.key);
  }
  return inUse;
}

export async function readCloudSignInEnd(
  list: CloudSignInEndList,
  options: {
    now?: number;
    readSetting?: CloudSignInSettingRead;
    logger?: { warn(event: string, data?: Record<string, unknown>): void };
  } = {},
): Promise<CloudSignInEnd | null> {
  const now = options.now ?? Date.now();
  const result = await list(ACCOUNT_SCOPE_ALL);
  if (!result.ok) return null;
  const due: CloudSignInEnd[] = [];
  const keys: CloudSignInEnd[] = [];
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
    const state: CloudSignInEnd["state"] | null = summary.state === "ended"
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
    // A setting that can't be read counts as absent (on, as the sync reads it),
    // and says so in the log: the warning may then name a key switched off.
    const raw = options.readSetting
      ? await options.readSetting().catch((error: unknown) => {
        options.logger?.warn("cloud.pass_end_setting_read_failed", { error: getErrorMessage(error) });
        return null;
      })
      : null;
    const setting = readCloudSetting(raw);
    if (setting.enabled) {
      const inUse = signInsInUse(result.value, setting);
      due.push(...keys.filter((end) => inUse.has(end.key)));
    }
  }
  if (due.length === 0) return null;
  due.sort((a, b) => ((a.state === "ended") === (b.state === "ended") ? a.expiresAt - b.expiresAt : a.state === "ended" ? -1 : 1));
  const fingerprint = due.map((entry) => `${entry.key}:${entry.state}`).sort().join("|");
  return { ...due[0]!, more: due.length - 1, fingerprint };
}
