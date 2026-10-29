/**
 * What a provider's agent receives when a chat starts, as one machine sees it.
 * Read-only: ADE lists the items so a person can see them and change their own
 * setup; it does not switch them off.
 */

/** Who put the item there. */
export type ProviderContextOwner = "harness" | "ade" | "user" | "project";

/**
 * How the size was found. Every count but `measured` is an estimate of tokens
 * (about 4 characters each); the kinds say which text it was counted from.
 * - `exact`: the exact text ADE sends.
 * - `estimated`: the text of a file or config entry; the provider may wrap,
 *   cut or render it differently.
 * - `measured`: from real chats (the turn ledger).
 * - `unknown`: no size is available before a chat starts.
 */
export type ProviderContextSizeKind = "exact" | "estimated" | "measured" | "unknown";

export type ProviderContextItemKind =
  | "system-prompt"
  | "instructions"
  | "memory"
  | "skills"
  | "skill"
  | "mcp-server"
  | "plugin"
  | "rule"
  | "agent"
  | "notes"
  | "other";

/** When the item reaches the model. */
export type ProviderContextTiming = "every-request" | "chat-start" | "on-demand";

export type ProviderContextItem = {
  /** Stable within one inventory. */
  id: string;
  owner: ProviderContextOwner;
  kind: ProviderContextItemKind;
  /** Short name, e.g. "Project AGENTS.md", "MCP server: rea". */
  label: string;
  /** A path (home shortened to `~`) or a config key. Display only; never a secret. */
  source?: string | null;
  /**
   * The full path of the file or folder on the machine that built the list,
   * for "Show in Finder". Only meaningful on that machine.
   */
  path?: string | null;
  /** Where the user turns it on or off, e.g. `~/.codex/config.toml`. Display only. */
  setIn?: string | null;
  /** An ADE settings entry that manages it (e.g. `mcp.servers`). */
  settingsEntry?: string | null;
  tokens: number | null;
  sizeKind: ProviderContextSizeKind;
  timing: ProviderContextTiming;
  /** One short plain sentence, when the label is not enough. */
  detail?: string | null;
  /** Items inside this one, e.g. the skills in a skill list. */
  children?: ProviderContextItem[];
};

/**
 * How complete the list is for this provider.
 * - `good`: ADE's items are exact; the user's items come from the provider's
 *   documented discovery rules, with estimated sizes.
 * - `basic`: ADE's items only; the provider's own discovery is not documented
 *   well enough to list.
 */
export type ProviderContextCoverage = "good" | "basic";

export type ProviderContextMeasurement = {
  /** Median size of the first request of recent chats (first turns with one request). */
  firstTurnTokens: number;
  /** How many chats the median comes from. */
  sampleCount: number;
  /** Oldest turn counted (ISO). */
  since: string;
  /** Whether the chats are this project's or the whole machine's. */
  scope: "project" | "machine";
};

export type ProviderContextInventory = {
  provider: string;
  generatedAt: string;
  /** The project folder the list was built for (home shortened to `~`). */
  cwd: string;
  laneId: string | null;
  coverage: ProviderContextCoverage;
  /** One plain sentence on what the list can and cannot show. */
  coverageNote: string;
  items: ProviderContextItem[];
  /** The listed items' known tokens, on-demand items left out (the harness row's measured rest is not in it). */
  listedTokens: number;
  /** From real chats on this machine; null when there are none yet. */
  measured: ProviderContextMeasurement | null;
};

/** The providers the list knows, in the order Settings shows them. */
export const PROVIDER_CONTEXT_PROVIDER_IDS = [
  "claude", "codex", "cursor", "droid", "opencode", "pi", "muse",
  "qwen", "kimi", "grok", "copilot", "devin", "antigravity",
] as const;

export type ProviderContextProvider = (typeof PROVIDER_CONTEXT_PROVIDER_IDS)[number];

export type GetProviderContextInventoryArgs = {
  provider: string;
  /** Lane whose worktree to list project files for. Defaults to the primary lane. */
  laneId?: string | null;
};
