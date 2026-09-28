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
import { listOpenCodeStoreSessions, openUserOpenCodeStore } from "./openCodeStore";

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
  "commit_messages",
  "pr_descriptions",
  "terminal_summaries",
  "initial_context",
  "api_credentials",
  // Names older builds used.
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
  const store = openUserOpenCodeStore(args);
  // No store (OpenCode never ran here) or an unknown schema is an empty list,
  // not an error.
  if (!store) return [];
  try {
    // ADE's own background rows and out-of-scope rows are dropped after the
    // query, so a scoped or plain list reads a wider window than it returns.
    const requestedLimit = lookupId
      ? 1
      : Math.min(MAX_EXTERNAL_SESSION_LIMIT, args.scopeRoots?.length ? Math.max(limit, 1000) : Math.max(limit * 4, 200));
    const rows = listOpenCodeStoreSessions(store, { limit: requestedLimit, sessionId: lookupId });
    const records: ExternalSessionDiscoveryRecord[] = [];
    for (const row of rows) {
      const rowCwd = normalizeProviderCwd(row.directory);
      if (!cwdIsInScope(rowCwd, args.scopeRoots)) continue;
      if (isAdeBackgroundTaskTitle(row.title)) continue;
      records.push(recordWithFile({
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
      }));
    }
    return sortDiscoveryRecords(records, limit);
  } catch (error) {
    throw new Error(`OpenCode session discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    store.close();
  }
}
