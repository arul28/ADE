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
  /** On, included, joined and not known to be offline: it can answer calls. */
  serving: boolean;
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
  /** The owner turned ADE Relay off on this computer (Settings › Account). Absent from older brains. */
  relayTurnedOff?: boolean;
  machineName: string;
  /** This computer is included and answering. */
  thisMachineServing: boolean;
  machines: RemoteMcpMachine[];
  connections: RemoteMcpConnectionSummary[];
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
