import fs from "node:fs/promises";
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

/** A pointer pair before it is bound to the chat session that carried it. */
export type ProviderPointer = { provider: ExternalSessionProvider; externalId: string };

function pushPointer(
  pointers: ProviderPointer[],
  provider: ExternalSessionProvider | null,
  externalId: string | null,
): void {
  if (!provider || !externalId) return;
  pointers.push({ provider, externalId });
}

/**
 * The one place that turns a chat record into provider-native pointers. The
 * live-chat scan and the in-memory session scan in main.ts must agree key for
 * key — an OpenCode chat persisted as `"unified"` keyed as `unified:<id>` on
 * one side and `opencode:<id>` on the other would fail to match, and the chat
 * would resurface in the import list as if ADE did not already own it.
 */
export function providerPointersFromChatRecord(raw: unknown): ProviderPointer[] {
  return pointersFromRecord(raw);
}

function pointersFromRecord(raw: unknown): ProviderPointer[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const provider = asProvider(record.provider);
  const pointers: ProviderPointer[] = [];
  const importedFrom = record.importedFrom && typeof record.importedFrom === "object"
    ? record.importedFrom as Record<string, unknown>
    : null;
  pushPointer(pointers, asProvider(importedFrom?.provider) ?? provider, asId(importedFrom?.sessionId));
  pushPointer(pointers, "claude", asId(record.sdkSessionId));
  pushPointer(pointers, "codex", asId(record.threadId));
  pushPointer(pointers, provider === "opencode" || !provider ? "opencode" : provider, asId(record.providerSessionId));
  pushPointer(pointers, "droid", asId(record.droidSdkSessionId));
  pushPointer(pointers, "pi", asId(record.piSessionId) ?? asId(record.piSessionFile));
  pushPointer(pointers, "cursor", asId(record.cursorSdkAgentId));
  pushPointer(pointers, "cursor", asId(record.cursorCloudAgentId));
  return pointers;
}

/**
 * Every browse scan reads one chat file per live chat, and a chat file holds the
 * whole transcript while only a handful of pointer fields matter here. Cache the
 * extracted pointers per file, keyed by the mtime+size the parse saw, so a
 * repeat scan re-parses only the chats that actually changed.
 */
const POINTER_CACHE_MAX_ENTRIES = 1_024;
const pointerCache = new Map<string, { mtimeMs: number; size: number; pointers: ProviderPointer[] }>();

function cachePointers(
  filePath: string,
  stamp: { mtimeMs: number; size: number },
  pointers: ProviderPointer[],
): void {
  // Plain insertion-order eviction: chat files are re-read in the same order
  // each scan, so the oldest key is the least likely to be asked for again.
  if (pointerCache.size >= POINTER_CACHE_MAX_ENTRIES) {
    const oldest = pointerCache.keys().next();
    if (!oldest.done) pointerCache.delete(oldest.value);
  }
  pointerCache.set(filePath, { mtimeMs: stamp.mtimeMs, size: stamp.size, pointers });
}

/**
 * Read native provider pointers off a persisted ADE chat JSON file.
 * Live chats write these; archived/deleted files are gone, so a deleted chat
 * naturally becomes importable again.
 *
 * Async on purpose: this runs once per live chat during a browse scan on the
 * Electron main process, so a synchronous read would stall the UI for the whole
 * scan.
 */
export async function liveChatProviderRefsFromPersistedState(
  chatSessionsDir: string,
  chatSessionId: string,
): Promise<ImportedChatSessionRef[]> {
  const filePath = path.join(chatSessionsDir, `${chatSessionId}.json`);
  let pointers: ProviderPointer[];
  try {
    const stat = await fs.stat(filePath);
    const cached = pointerCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      pointers = cached.pointers;
    } else {
      pointers = pointersFromRecord(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
      cachePointers(filePath, { mtimeMs: stat.mtimeMs, size: stat.size }, pointers);
    }
  } catch {
    pointerCache.delete(filePath);
    return [];
  }
  return pointers.map((pointer) => ({ ...pointer, chatSessionId }));
}
