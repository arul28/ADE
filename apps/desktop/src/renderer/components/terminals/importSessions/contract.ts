/**
 * Renderer-side contract helpers for the "Import external CLI session" feature.
 *
 * The canonical types now live in the backend-owned shared module; we re-export
 * them here so the rest of the renderer imports the feature's surface from one
 * place. This file only adds renderer glue (bridge accessor, provenance
 * reader, display helpers).
 */
import type { TerminalToolType } from "../../../../shared/types";

export type {
  ExternalSessionProvider,
  ExternalSessionCapabilities,
  ExternalSessionMessage,
  ExternalSessionSummary,
  ExternalSessionListArgs,
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
} from "../../../../shared/types/externalSessions";

import type {
  ExternalSessionProvider,
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
  ExternalSessionListArgs,
  ExternalSessionSummary,
} from "../../../../shared/types/externalSessions";

/**
 * Provenance marker stamped by the backend onto imported terminal/chat
 * sessions. Read via {@link readImportedFrom} with type-safe optional access —
 * the field may not be declared on `TerminalSessionSummary` /
 * `AgentChatSessionSummary` yet.
 */
export type ImportedFrom = {
  provider: ExternalSessionProvider;
  sessionId?: string;
};

export type ExternalSessionsApi = {
  list: (args?: ExternalSessionListArgs) => Promise<ExternalSessionSummary[]>;
  import: (args: ExternalSessionImportArgs) => Promise<ExternalSessionImportResult>;
};

/** Typed accessor for the runtime-routed bridge; null when unavailable. */
export function getExternalSessionsApi(): ExternalSessionsApi | null {
  const api = (window as unknown as { ade?: { externalSessions?: ExternalSessionsApi } })
    .ade?.externalSessions;
  return api ?? null;
}

/** Normalizes the `list` response, tolerating both an array and `{ sessions }`. */
export function normalizeListResult(
  result: ExternalSessionSummary[] | { sessions: ExternalSessionSummary[] } | null | undefined,
): ExternalSessionSummary[] {
  if (Array.isArray(result)) return result;
  return result?.sessions ?? [];
}

/**
 * Reads the optional `importedFrom` provenance marker from a session summary
 * without depending on the field being declared on the summary type yet.
 */
export function readImportedFrom(session: unknown): ImportedFrom | null {
  if (!session || typeof session !== "object") return null;
  const raw = (session as { importedFrom?: unknown }).importedFrom;
  if (!raw || typeof raw !== "object") return null;
  const provider = (raw as { provider?: unknown }).provider;
  if (typeof provider !== "string") return null;
  const sessionId = (raw as { sessionId?: unknown }).sessionId;
  return {
    provider: provider as ExternalSessionProvider,
    ...(typeof sessionId === "string" ? { sessionId } : {}),
  };
}

const PROVIDER_LABELS: Record<ExternalSessionProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
};

export function providerDisplayName(provider: ExternalSessionProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Maps an external provider to the terminal toolType used for its CLI runtime. */
export const PROVIDER_TOOL_TYPE: Record<ExternalSessionProvider, TerminalToolType> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-cli",
  droid: "droid",
  opencode: "opencode",
};
