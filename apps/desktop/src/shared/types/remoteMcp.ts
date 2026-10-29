/**
 * ADE MCP: one MCP server for the person's ADE account, reached through ADE
 * Relay. Any of the account's computers with ADE MCP on can answer the
 * account address; a call for another computer is forwarded to it. The
 * brain's `remote_mcp` action domain answers with these shapes; Settings and
 * `ade mcp` read them. Implemented in apps/ade-cli/src/services/remoteMcp.
 */

export type RemoteMcpScope = "read" | "write";

export function isRemoteMcpScope(value: unknown): value is RemoteMcpScope {
  return value === "read" || value === "write";
}

export type RemoteMcpConnectionKind = "app" | "token";

/** A connection belongs to the account: its token works on every included computer. */
export type RemoteMcpConnectionSummary = {
  id: string;
  kind: RemoteMcpConnectionKind;
  label: string;
  scope: RemoteMcpScope;
  /** Last four characters of the token, so a person can tell tokens apart. */
  tokenHint: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The redirect host an app signed in from, shown next to its name. */
  redirectHost: string | null;
  /**
   * A connection made for one computer before ADE MCP covered the account
   * keeps reaching only that computer; null reaches every included one.
   */
  onlyMachine: { machineKey: string; name: string } | null;
  /**
   * The app ADE recognised at sign-in (from the redirect address it used, not
   * only the name it registered: Grok signs in with Cursor's client), so
   * Settings can show its logo. Null for tokens and apps ADE does not know.
   */
  app: RemoteMcpKnownApp | null;
};

/** Apps ADE MCP has setup steps and a logo for. */
export const REMOTE_MCP_KNOWN_APPS = [
  "claude",
  "claude-code",
  "chatgpt",
  "codex",
  "grok",
  "grok-bot",
  "cursor",
  "vscode",
  "gemini-cli",
  "perplexity",
  "le-chat",
  "windsurf",
  "zed",
  "goose",
  "opencode",
  "amp",
  "factory",
  "raycast",
] as const;

export type RemoteMcpKnownApp = (typeof REMOTE_MCP_KNOWN_APPS)[number];

export function isRemoteMcpKnownApp(value: unknown): value is RemoteMcpKnownApp {
  return typeof value === "string" && (REMOTE_MCP_KNOWN_APPS as readonly string[]).includes(value);
}

/** The name ADE shows for each known app, on the sign-in pages and in Settings. */
export const REMOTE_MCP_KNOWN_APP_LABELS: Readonly<Record<RemoteMcpKnownApp, string>> = {
  claude: "Claude",
  "claude-code": "Claude Code",
  chatgpt: "ChatGPT",
  codex: "Codex",
  grok: "Grok",
  "grok-bot": "Grok Bot",
  cursor: "Cursor",
  vscode: "VS Code",
  "gemini-cli": "Gemini CLI",
  perplexity: "Perplexity",
  "le-chat": "Le Chat",
  windsurf: "Windsurf",
  zed: "Zed",
  goose: "Goose",
  opencode: "OpenCode",
  amp: "Amp",
  factory: "Factory",
  raycast: "Raycast",
};

/**
 * Why a computer does not answer ADE MCP. Each computer reports its own in its
 * account entry, so every computer's Settings (and `machines_list`) can say
 * the true reason instead of "Online".
 */
export const REMOTE_MCP_NOT_SERVING_REASONS = [
  /** ADE MCP is off for the account. */
  "off_for_account",
  /** The person left this computer out. */
  "left_out",
  /** The computer is signed out of its ADE account. */
  "signed_out",
  /** It has no ADE Relay identity yet, or its relay connection is down. */
  "relay_disconnected",
  /** Its account vault can't sync, so it never received the account secret. */
  "account_vault_unreachable",
  /** On, but the account secret has not reached it yet. */
  "waiting_for_account_secret",
  /** Runs an ADE that can't take account calls. */
  "older_ade",
  /** The account directory shows it offline. */
  "offline",
] as const;

export type RemoteMcpNotServingReason = (typeof REMOTE_MCP_NOT_SERVING_REASONS)[number];

export function isRemoteMcpNotServingReason(value: unknown): value is RemoteMcpNotServingReason {
  return typeof value === "string" && (REMOTE_MCP_NOT_SERVING_REASONS as readonly string[]).includes(value);
}

/** This computer's account vault sync, which ADE MCP (and every synced secret) depends on. */
export type RemoteMcpVaultHealth = {
  state: "ok" | "failing" | "unavailable";
  /** Last time a full sync (upload and pull) finished. */
  lastSyncedAt: string | null;
  /** Local changes still waiting to upload. */
  pendingChanges: number;
  /** One plain sentence for the person when not ok; null when ok. */
  message: string | null;
};

/** One of the account's computers, as ADE MCP sees it. */
export type RemoteMcpMachine = {
  machineKey: string;
  name: string;
  /** False when the person left this computer out of ADE MCP. */
  included: boolean;
  /**
   * The computer runs an ADE that serves the account address. False for a
   * computer on an older ADE, or one that never turned on since the update.
   */
  supported: boolean;
  /** From the account directory; null when it could not be read. */
  online: boolean | null;
  /**
   * It answers calls. For this computer, its live state; for another one, the
   * state it last reported in its account entry (and false when offline).
   */
  serving: boolean;
  /** Why it does not answer; null when it serves. */
  notServingReason: RemoteMcpNotServingReason | null;
  /** When that computer last reported its serving state; null if it never has. */
  reportedAt: string | null;
  isThisMachine: boolean;
};

export type RemoteMcpStatus = {
  /** ADE MCP is on for the account. */
  enabled: boolean;
  /** This computer is signed in to an ADE account; ADE MCP needs one. */
  signedIn: boolean;
  /** The account's one URL to give an AI app; null until it exists. */
  serverUrl: string | null;
  /** This computer's relay connection is up, so it can answer the URL. */
  relayConnected: boolean;
  machineName: string;
  /** This computer is included and answering. */
  thisMachineServing: boolean;
  machines: RemoteMcpMachine[];
  connections: RemoteMcpConnectionSummary[];
  /** This computer's account vault sync. */
  vault: RemoteMcpVaultHealth;
};

export type RemoteMcpCreatedToken = {
  token: string;
  connection: RemoteMcpConnectionSummary;
  serverUrl: string | null;
};

export type RemoteMcpActivityOutcome = "ok" | "failed" | "refused" | "timeout" | "busy";

export type RemoteMcpActivityEntry = {
  at: string;
  connectionId: string;
  label: string;
  scope: RemoteMcpScope;
  /** The command with secret-looking values replaced. */
  command: string;
  outcome: RemoteMcpActivityOutcome;
  exitCode: number | null;
  durationMs: number;
  /** Why a call was refused, when it was. */
  detail?: string;
  /** The project the command ran in, by name; absent when it ran in none. */
  project?: string;
  /** The typed tool that ran the command, when it was not the `ade` tool. */
  tool?: string;
  /** The computer that took the call from the app, when it was another one. */
  via?: string;
  /** The computer the call was sent on to, on the computer that sent it. */
  forwardedTo?: string;
};

export const REMOTE_MCP_ACTIONS = [
  "getStatus",
  "listActivity",
  "setEnabled",
  "setMachineIncluded",
  "createToken",
  "updateConnection",
  "removeConnection",
] as const;

export type RemoteMcpAction = (typeof REMOTE_MCP_ACTIONS)[number];

export function isRemoteMcpAction(value: unknown): value is RemoteMcpAction {
  return typeof value === "string" && (REMOTE_MCP_ACTIONS as readonly string[]).includes(value);
}
