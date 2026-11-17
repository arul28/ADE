import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type { AgentChatLaunchDefaults } from "../../../shared/types";

/**
 * The model and settings a person last launched a chat with, as an account
 * setting, so a new chat on any computer, on ADE Cloud, on the web or on the
 * phone starts from the same pick. Each machine's own file
 * (`chat-launch-defaults.json`, `chatLaunchDefaults.ts`) stays its local
 * copy; the newer of the two wins, by `updatedAt`.
 */
export const ACCOUNT_LAUNCH_DEFAULTS_KEY = "chat.launchDefaults.v1";

/** The account settings store takes rows under this size. */
const MAX_ROW_BYTES = 16_000;

/** A row this build can read, else null (a newer ADE's shape, or garbage). */
export function accountLaunchDefaultsOf(value: unknown): AgentChatLaunchDefaults | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<AgentChatLaunchDefaults>;
  if (row.version !== 1 || typeof row.modelId !== "string" || !row.modelId.trim()) return null;
  if (typeof row.provider !== "string" || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) return null;
  // Fast is picked per chat, never carried into the next one.
  return { ...row, fastMode: false } as AgentChatLaunchDefaults;
}

/** The newer of two defaults by `updatedAt`; the machine's copy on a tie. */
export function newerLaunchDefaults(
  machine: AgentChatLaunchDefaults | null,
  account: AgentChatLaunchDefaults | null,
): AgentChatLaunchDefaults | null {
  if (!machine) return account;
  if (!account) return machine;
  return Date.parse(account.updatedAt) > Date.parse(machine.updatedAt) ? account : machine;
}

/** The account's row, or null (signed out, no bridge, nothing saved, unreadable). Account level: no pin. */
export async function readAccountLaunchDefaults(): Promise<AgentChatLaunchDefaults | null> {
  const api = window.ade?.accountSettings;
  if (!api) return null;
  try {
    const result = await api.get({ scope: ACCOUNT_SCOPE_ALL, key: ACCOUNT_LAUNCH_DEFAULTS_KEY });
    return result.ok ? accountLaunchDefaultsOf(result.value) : null;
  } catch {
    return null;
  }
}

/**
 * Sends a machine's defaults to the account when they are newer than its
 * row. Best effort: offline or signed out, the machine keeps its copy and the
 * next launch tries again.
 */
export async function publishLaunchDefaults(
  machine: AgentChatLaunchDefaults,
  account: AgentChatLaunchDefaults | null,
): Promise<void> {
  const api = window.ade?.accountSettings;
  if (!api || (account && Date.parse(account.updatedAt) >= Date.parse(machine.updatedAt))) return;
  // Only the fields the defaults hold: a host may add its own (Fast policy).
  const { fastModeAllowed: _policy, ...value } = machine as AgentChatLaunchDefaults & { fastModeAllowed?: unknown };
  try {
    if (JSON.stringify(value).length >= MAX_ROW_BYTES) return;
    await api.set({ scope: ACCOUNT_SCOPE_ALL, key: ACCOUNT_LAUNCH_DEFAULTS_KEY, value: { ...value, fastMode: false } });
  } catch {
    // As above: the machine's copy stays.
  }
}
