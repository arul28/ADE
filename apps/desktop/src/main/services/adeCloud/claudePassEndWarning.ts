/**
 * The end warning's one fact (`cloudAccess.read().passEnd`), computed here in
 * desktop main from the account's local pass store: one `list` of the account
 * vault over the brain bridge, then the same parse and state as the pass card
 * (`summarizeClaudePass`). No network, no new IPC, no token leaves this file.
 *
 * Due: Claude ended the pass, its expected end has passed, or its notice is due
 * (`noticeDueAt`, 7 days before the expected end). The soonest wins; an ended
 * pass first.
 */
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type { CloudPassEnd } from "../../../shared/cloudSignIns";
import type { AccountVaultItem, AccountVaultResult } from "../../../shared/types/accountVault";
import { CLAUDE_PASS_VAULT_KIND, parseClaudePass, summarizeClaudePass } from "./claudePassStore";
import { isClaudePassKey } from "../../../shared/types/providerLogins";

export type ClaudePassEndList = (scope: string) => Promise<AccountVaultResult<AccountVaultItem[]>>;

export async function readClaudePassEnd(list: ClaudePassEndList, now: number = Date.now()): Promise<CloudPassEnd | null> {
  const result = await list(ACCOUNT_SCOPE_ALL);
  if (!result.ok) return null;
  const due: CloudPassEnd[] = [];
  for (const row of result.value) {
    if (row.kind !== CLAUDE_PASS_VAULT_KIND || !isClaudePassKey(row.key) || row.deleted || !row.value) continue;
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
  if (due.length === 0) return null;
  due.sort((a, b) => ((a.state === "ended") === (b.state === "ended") ? a.expiresAt - b.expiresAt : a.state === "ended" ? -1 : 1));
  const fingerprint = due.map((entry) => `${entry.key}:${entry.state}`).sort().join("|");
  return { ...due[0]!, more: due.length - 1, fingerprint };
}
