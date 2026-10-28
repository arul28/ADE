import type { McpRegistryServer, McpRegistryTransport, McpSecretField } from "../mcpRegistry";
import type { AccountStoreResult } from "./accountStore";

/**
 * The wire shapes of the MCP servers settings page, shared by main, preload
 * and the renderer.
 *
 * The rule for everything here: a secret VALUE crosses from the renderer to
 * main (the user typed it) and never comes back. Lists and status answers
 * carry names only.
 */

/** Where this computer and this project file their "switched off here" lists. */
export type McpRegistryContext = {
  /** The `all`-scope key of this computer's off list, or null before it has a device id. */
  deviceOffKey: string | null;
  /** The `repo:<remote>` scope of this project's off list, or null when it has no usable remote. */
  repoScope: string | null;
  /**
   * The registry as this computer last saved it, read straight off its settings
   * cache: the same copy a chat launch reads. For showing the list when the
   * background service cannot be asked. Null when there is no cache to read.
   */
  cached: { servers: McpRegistryServer[]; off: { machine: string[]; project: string[] } } | null;
};

/** What this computer can and cannot run of a list of registry servers. */
export type McpRegistryCheck = {
  /** Vault keys (`mcpSecretVaultKey`) whose value this computer holds. */
  heldSecretKeys: string[];
  /** Names of `stdio` servers whose command was not found on this computer. */
  missingCommands: string[];
  /** HTTP / SSE servers with a browser sign-in, or that ask for one. Others are not listed. */
  signIns: McpServerSignIn[];
};

/** One server's browser sign-in. Never carries the token. */
export type McpServerSignIn = {
  server: string;
  /** `needed`: the server asks for a sign-in and ADE has none for it. */
  state: "needed" | "valid" | "expired";
  expiresAt: string | null;
};

/** A provider CLI whose own config the scan reads: every chat provider. */
export type McpConfigProvider =
  | "claude" | "codex" | "copilot" | "cursor" | "opencode" | "droid" | "pi"
  | "muse" | "qwen" | "kimi" | "grok" | "devin" | "antigravity";

/** A server found in a provider's own config. Names only: no values. */
export type McpFoundServer = {
  name: string;
  transport: McpRegistryTransport;
  command?: string;
  args?: string[];
  url?: string;
  envNames: string[];
  headerNames: string[];
  /** Every provider that has a server under this name, first one is the definition shown. */
  providers: McpConfigProvider[];
};

export type McpRegistryScan = {
  servers: McpFoundServer[];
  /** Names the scan saw but ADE cannot hold (a name or a shape it does not accept). */
  skipped: string[];
};

export type McpRegistrySecretRef = { server: string; field: McpSecretField; name: string };

export type McpRegistryResult<T> = AccountStoreResult<T>;

export type McpRegistryImportResult = McpRegistryResult<McpRegistryServer>;

/** A sign-in's answer. `cancelled` marks one stopped by Cancel or a newer sign-in. */
export type McpRegistrySignInResult =
  | McpRegistryResult<McpServerSignIn>
  | { ok: false; rejected: true; cancelled: true; message: string };
