/**
 * ADE MCP: this computer as an MCP server, reached through ADE Relay.
 * The brain's `remote_mcp` action domain answers with these shapes; Settings
 * and `ade mcp` read them. Implemented in apps/ade-cli/src/services/remoteMcp.
 */

export type RemoteMcpScope = "read" | "write";

export type RemoteMcpConnectionKind = "app" | "token";

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
};

export type RemoteMcpStatus = {
  enabled: boolean;
  /** The URL to give an AI app; null until this computer has a relay identity. */
  serverUrl: string | null;
  relayConnected: boolean;
  machineName: string;
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
};

export const REMOTE_MCP_ACTIONS = [
  "getStatus",
  "listActivity",
  "setEnabled",
  "createToken",
  "updateConnection",
  "removeConnection",
] as const;

export type RemoteMcpAction = (typeof REMOTE_MCP_ACTIONS)[number];

export function isRemoteMcpAction(value: unknown): value is RemoteMcpAction {
  return typeof value === "string" && (REMOTE_MCP_ACTIONS as readonly string[]).includes(value);
}
