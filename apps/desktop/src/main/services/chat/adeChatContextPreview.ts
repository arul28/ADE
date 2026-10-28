import type { ProviderContextItemKind, ProviderContextTiming } from "../../../shared/types/providerContext";

/**
 * The text ADE itself sends a new lane chat of one provider, built by the same
 * builders the launch uses (`agentChatService.previewNewChatAdeContext`). The
 * Settings "Context" list (`ai/providerContextInventory.ts`) turns it into
 * items with sizes. Nothing here is sent anywhere; it is a dry render.
 */
export type AdeChatContextPart = {
  /** Stable id: `ade-prompt`, `ade-cli-guidance`, `ade-project-notes`, ... */
  id: string;
  label: string;
  kind: ProviderContextItemKind;
  timing: ProviderContextTiming;
  /** The exact text. */
  text: string;
  source?: string | null;
  detail?: string | null;
  /**
   * Ids of other parts whose text is inside this one's (the CLI guidance is
   * inside the system prompt). The list shows them as their own items, so
   * this part's own size is its text minus theirs.
   */
  includes?: string[];
  /** For a listing: one entry per listed skill or command, with its line. */
  entries?: Array<{ name: string; text: string; source?: string | null }>;
};

export type AdeChatContextPreview = {
  provider: string;
  laneId: string | null;
  /** The folder a new chat in that lane runs in. */
  laneWorktreePath: string;
  parts: AdeChatContextPart[];
  /** ADE's skill roots for that folder, as the launch names them. */
  adeSkillRoots: string[];
  /** The ADE MCP registry servers this provider would be handed: names and transport only. */
  mcpServers: Array<{ name: string; type: string }>;
  /**
   * The provider config-home variables a new chat launches with
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...). Paths only, never a credential.
   * Empty when the chat inherits the machine's own config home.
   */
  providerHomeEnv: Record<string, string>;
};
