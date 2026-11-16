import {
  cleanSessionTitle,
  cwdIsInScope,
  MAX_EXTERNAL_SESSION_LIMIT,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  recordWithFile,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import {
  listOpenCodeStoreSessions,
  openAdeOpenCodeStore,
  openUserOpenCodeStore,
  type OpenCodeStoreSessionRow,
} from "./openCodeStore";

/**
 * ADE runs its own background prompts (terminal summaries, commit messages,
 * chat titles…) through OpenCode, titled `ADE <task>` by
 * the 1.x `providerTaskRunner.runOpenCodeTask`. They landed in the user's
 * OpenCode store and are never the user's work: on 2026-09-23 they were 155 of
 * 271 listed rows. Matched by the exact task names, so a user session titled
 * "ADE router …" still lists.
 */
const ADE_BACKGROUND_TASK_TITLES = new Set([
  // Current `AiFeatureKey` values.
  "narratives",
  "conflict_proposals",
  "terminal_summaries",
  "initial_context",
  "api_credentials",
  // Names older builds used.
  "commit_messages",
  "pr_descriptions",
  "session summary",
  "initial chat title",
]);

export function isAdeBackgroundTaskTitle(title: string | null | undefined): boolean {
  const match = /^ADE (.+)$/u.exec(title?.trim() ?? "");
  return Boolean(match && ADE_BACKGROUND_TASK_TITLES.has(match[1]!.trim().toLowerCase()));
}

export async function discoverOpenCodeSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const lookupId = args.sessionId?.trim() || null;
  const userStore = openUserOpenCodeStore(args);
  // ADE-launched terminals and chats run on ADE's managed server, so their
  // sessions never land in the user's own store. Only the import path opts in
  // to that store; every other caller keeps reading the user's sessions.
  const adeStore = args.includeAdeOwned ? openAdeOpenCodeStore(args) : null;
  // No store (OpenCode never ran here) or an unknown schema is an empty list,
  // not an error.
  if (!userStore && !adeStore) return [];
  try {
    // ADE's own background rows and out-of-scope rows are dropped after the
    // query, so a scoped or plain list reads a wider window than it returns.
    const requestedLimit = lookupId
      ? 1
      : Math.min(MAX_EXTERNAL_SESSION_LIMIT, args.scopeRoots?.length ? Math.max(limit, 1000) : Math.max(limit * 4, 200));
    const readStore = (
      store: typeof userStore,
      adeOwned: boolean,
    ): Array<{ row: OpenCodeStoreSessionRow; adeOwned: boolean }> => {
      if (!store) return [];
      try {
        return listOpenCodeStoreSessions(store, { limit: requestedLimit, sessionId: lookupId })
          .map((row) => ({ row, adeOwned }));
      } catch (error) {
        // One malformed or mid-migration store must not take the healthy
        // store's rows with it (the service would show a false empty list).
        args.logger?.warn?.("external_sessions.opencode_store_query_failed", {
          adeOwned,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    };
    const rows = [...readStore(userStore, false), ...readStore(adeStore, true)];
    // The same id can exist in both stores after an older build copied a
    // session across. The newer row is the one the person last used; on a tie
    // ADE's own store wins.
    const byId = new Map<string, { row: OpenCodeStoreSessionRow; adeOwned: boolean }>();
    for (const entry of rows) {
      const existing = byId.get(entry.row.id);
      if (
        !existing
        || (entry.row.updatedAt ?? 0) > (existing.row.updatedAt ?? 0)
        || ((entry.row.updatedAt ?? 0) === (existing.row.updatedAt ?? 0) && entry.adeOwned)
      ) {
        byId.set(entry.row.id, entry);
      }
    }
    const records: ExternalSessionDiscoveryRecord[] = [];
    for (const entry of byId.values()) {
      const { row } = entry;
      const rowCwd = normalizeProviderCwd(row.directory);
      if (!cwdIsInScope(rowCwd, args.scopeRoots)) continue;
      if (isAdeBackgroundTaskTitle(row.title)) continue;
      records.push({
        ...recordWithFile({
          provider: "opencode",
          id: row.id,
          cwd: rowCwd,
          title: cleanSessionTitle(row.title),
          preview: null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          messageCount: row.userMessageCount,
          filePath: null,
          sourceMtimeMs: row.updatedAt,
        }),
        adeOwned: entry.adeOwned,
      });
    }
    return sortDiscoveryRecords(records, limit);
  } catch (error) {
    throw new Error(`OpenCode session discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    userStore?.close();
    adeStore?.close();
  }
}
