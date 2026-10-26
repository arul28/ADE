/**
 * Which settings an agent may change, and which only the person may.
 *
 * Two lists, one rule:
 *  - **Agents can** change the setup of the work itself: how lanes start and
 *    stay current, lane templates, the notes agents keep, and (outside the
 *    Settings pages) the project config's test suites, automations, overlays
 *    and environments.
 *  - **Only you** change everything else: who can see your work, sign-ins and
 *    keys, money, what agents may do on your computer, the computer itself,
 *    anything that deletes your data, and how ADE works for you.
 *
 * A new setting is "only you" until someone puts it on the agent list. Every
 * manifest entry must appear in exactly one list (`settingsManifest.test.ts`).
 *
 * This file is the WORDING and the chip's lock. The refusals themselves live
 * in the brain: `ADE_ACTION_CTO_ONLY` / `ADE_ACTION_USER_ONLY` / the person-only
 * config writes in `main/services/adeActions/actionPolicy.ts`. An agent's
 * instructions are never the boundary.
 */

export type SettingOwnerOnlyReason =
  | "publishing"
  | "sign-in"
  | "money"
  | "agent-reach"
  | "computer"
  | "data"
  | "preference";

export type SettingAgentAccess =
  | { agent: "can" }
  | { agent: "owner-only"; reason: SettingOwnerOnlyReason; explanation: string };

/** One plain line per reason: what the chip's card and `ade settings find` say. */
export const SETTING_OWNER_ONLY_EXPLANATION: Record<SettingOwnerOnlyReason, string> = {
  publishing: "It decides who can see your chats.",
  "sign-in": "It holds your sign-ins and keys.",
  money: "It spends or tracks your money.",
  "agent-reach": "It decides what agents may do on your computer.",
  computer: "It changes this computer itself.",
  data: "It can delete your work.",
  preference: "It is your preference.",
};

/** Settings an agent may change. Everything else is only the person's. */
const AGENT_CAN_CHANGE: readonly string[] = [
  "lanes-git.lanes",
  "lanes-git.new-lane-base",
  "lanes-git.auto-rebase",
  "lanes-git.rebase-suggestions",
  "lanes-git.rebase-min-behind",
  "lanes-git.lane-templates",
  "project-agents.agent-notes",
  // `ade secrets set` is how an agent stores a key it was handed for the
  // work; reading a value back is still refused (`isSecretBearingAdeAction`).
  "secrets.secrets",
];

const OWNER_ONLY: Record<Exclude<SettingOwnerOnlyReason, "preference">, readonly string[]> = {
  publishing: [
    "lanes-git.pr-chat-transcripts",
  ],
  "sign-in": [
    "account.profile",
    "account.computers",
    "mcp.servers",
    "mcp.found",
    "agents.providers",
    "agents.accounts",
    "agents.provider.claude",
    "agents.provider.codex",
    "agents.provider.cursor",
    "agents.provider.droid",
    "agents.provider.muse",
    "agents.provider.pi",
    "agents.provider.opencode",
    "agents.provider.qwen",
    "agents.provider.kimi",
    "agents.provider.grok",
    "agents.provider.copilot",
    "agents.harnesses",
    "integrations.github",
    "integrations.linear",
    "integrations.jira",
  ],
  money: [
    "agents.budget",
    "stats.usage",
    "chat.fast-mode",
    "chat.jev-zen-credit",
  ],
  "agent-reach": [
    "ade-mcp.server",
    "general.browser-agent-access",
    "general.browser-auto-grant",
    "agents.scheduled-work",
  ],
  computer: [
    "general.background-service",
    "general.quit-confirmation",
    "storage.diagnostics",
    "general.about",
    "general.auto-updates",
    "general.update-other-machines",
    "general.ade-cli",
    "general.diagnostics-sharing",
    "general.reset",
    "general.keep-awake",
    "general.capture-gesture",
    "general.project-location",
    "storage.project-health",
  ],
  data: [
    "storage.usage",
    "storage.chat-history",
    "storage.deleted-lane-chats",
    "storage.provider-history",
    "archive.items",
    "storage.cleanups",
    "storage.lane-rules",
    "storage.session-lifecycle",
    "storage.project-files",
  ],
};

const ACCESS_BY_ID: ReadonlyMap<string, SettingAgentAccess> = (() => {
  const map = new Map<string, SettingAgentAccess>();
  for (const id of AGENT_CAN_CHANGE) map.set(id, { agent: "can" });
  for (const [reason, ids] of Object.entries(OWNER_ONLY) as Array<[SettingOwnerOnlyReason, readonly string[]]>) {
    for (const id of ids) map.set(id, { agent: "owner-only", reason, explanation: SETTING_OWNER_ONLY_EXPLANATION[reason] });
  }
  return map;
})();

const PREFERENCE: SettingAgentAccess = {
  agent: "owner-only",
  reason: "preference",
  explanation: SETTING_OWNER_ONLY_EXPLANATION.preference,
};

/**
 * Whether an agent may change a setting. Anything not named above is a
 * preference: the person's to choose, and never an agent's by default.
 */
export function settingAgentAccess(entryId: string): SettingAgentAccess {
  return ACCESS_BY_ID.get(entryId) ?? PREFERENCE;
}

/** Every entry id the lists name, for the manifest test that keeps them honest. */
export function listedSettingAgentAccessIds(): string[] {
  return [...ACCESS_BY_ID.keys()];
}

/**
 * The parts of the project config (`.ade/ade.yaml`, `.ade/local.yaml`) an agent
 * may change through `project_config.save`: the setup of the work. Any other
 * top-level key is the person's — PR chat transcripts (publishing), AI and
 * provider config, cleanup rules, link handling, issue trackers — and a new key
 * is the person's until it is added here.
 */
export const AGENT_EDITABLE_PROJECT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "version",
  "project",
  "testSuites",
  "laneOverlayPolicies",
  "automations",
  "environments",
  "git",
  "laneEnvInit",
  "laneTemplates",
  "defaultLaneTemplate",
]);

/** Which Settings card an owner-only config key is changed from, for the refusal's link. */
const PROJECT_CONFIG_KEY_SETTING: Readonly<Record<string, string>> = {
  github: "lanes-git.pr-chat-transcripts",
  ai: "agents.providers",
  providers: "agents.providers",
  laneCleanup: "storage.lane-rules",
  browser: "general.link-open-mode",
  issueTrackers: "integrations.jira-projects",
  linearSync: "integrations.linear",
};

type ConfigLayer = Record<string, unknown> | null | undefined;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The first owner-only key an agent's config save would change, or null when
 * every change is to the work setup. Compared per layer (shared and local), so
 * moving a value between files counts as a change. A key that is absent on
 * both sides is unchanged.
 */
export function ownerOnlyProjectConfigChange(
  current: { shared?: ConfigLayer; local?: ConfigLayer },
  candidate: { shared?: ConfigLayer; local?: ConfigLayer },
): { key: string; entryId: string | null } | null {
  for (const layer of ["shared", "local"] as const) {
    const before = current[layer] ?? {};
    const after = candidate[layer] ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (AGENT_EDITABLE_PROJECT_CONFIG_KEYS.has(key)) continue;
      if (stableJson(before[key]) === stableJson(after[key])) continue;
      return { key, entryId: PROJECT_CONFIG_KEY_SETTING[key] ?? null };
    }
  }
  return null;
}
