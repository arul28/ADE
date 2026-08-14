import fs from "node:fs";
import path from "node:path";
import type { ExternalSessionProvider } from "../../../shared/types/externalSessions";

export type ImportedChatSessionRef = {
  provider: string;
  externalId: string;
  chatSessionId: string;
};

const PROVIDERS = new Set<ExternalSessionProvider>([
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "pi",
]);

function asProvider(value: unknown): ExternalSessionProvider | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "unified") return "opencode";
  return PROVIDERS.has(raw as ExternalSessionProvider) ? raw as ExternalSessionProvider : null;
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pushRef(
  refs: ImportedChatSessionRef[],
  chatSessionId: string,
  provider: ExternalSessionProvider | null,
  externalId: string | null,
): void {
  if (!provider || !externalId) return;
  refs.push({ provider, externalId, chatSessionId });
}

/**
 * Read native provider pointers off a persisted ADE chat JSON file.
 * Live chats write these; archived/deleted files are gone, so a deleted chat
 * naturally becomes importable again.
 */
export function liveChatProviderRefsFromPersistedState(
  chatSessionsDir: string,
  chatSessionId: string,
): ImportedChatSessionRef[] {
  const filePath = path.join(chatSessionsDir, `${chatSessionId}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const provider = asProvider(record.provider);
  const refs: ImportedChatSessionRef[] = [];
  const importedFrom = record.importedFrom && typeof record.importedFrom === "object"
    ? record.importedFrom as Record<string, unknown>
    : null;
  pushRef(refs, chatSessionId, asProvider(importedFrom?.provider) ?? provider, asId(importedFrom?.sessionId));
  pushRef(refs, chatSessionId, "claude", asId(record.sdkSessionId));
  pushRef(refs, chatSessionId, "codex", asId(record.threadId));
  pushRef(refs, chatSessionId, provider === "opencode" || !provider ? "opencode" : provider, asId(record.providerSessionId));
  pushRef(refs, chatSessionId, "droid", asId(record.droidSdkSessionId));
  pushRef(refs, chatSessionId, "pi", asId(record.piSessionId) ?? asId(record.piSessionFile));
  pushRef(refs, chatSessionId, "cursor", asId(record.cursorSdkAgentId));
  pushRef(refs, chatSessionId, "cursor", asId(record.cursorCloudAgentId));
  return refs;
}
