import { randomUUID } from "node:crypto";
import type {
  AdeUsageActivitySummary,
  AdeUsageAgentModelSummary,
  AdeUsageAgentProviderSummary,
  AdeUsageClientSummary,
  AdeUsageClientSurface,
  AdeUsageDailyPoint,
  AdeUsageFeatureSummary,
  AdeUsageLaneSummary,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
} from "../../../shared/types";
import type { AdeDb, SqlValue } from "../state/kvDb";

export type AdeUsageStatsRange = {
  since: string | null;
  until: string;
};

export type AdeDatabaseUsageStats = {
  summary: {
    trackedAdeTokens: number;
    trackedAdeInputTokens: number;
    trackedAdeOutputTokens: number;
    trackedAdeCalls: number;
    trackedAdeDurationMs: number;
    chatSessions: number;
    terminalSessions: number;
    activeLanes: number;
    lanesCreated: number;
    lanesArchived: number;
    commitsCreated: number;
    pushOperations: number;
    prLandings: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
    artifactsCaptured: number;
    automationRuns: number;
    workerRuns: number;
    totalInteractions: number;
    activeDays: number;
    currentStreakDays: number;
    longestStreakDays: number;
    longestSessionMs: number;
  };
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
  agentProviders: AdeUsageAgentProviderSummary[];
  agentModels: AdeUsageAgentModelSummary[];
  features: AdeUsageFeatureSummary[];
  lanes: AdeUsageLaneSummary[];
  activities: AdeUsageActivitySummary[];
  clients: AdeUsageClientSummary[];
  daily: Array<Partial<AdeUsageDailyPoint> & Pick<AdeUsageDailyPoint, "date">>;
};

const MEANINGFUL_ACTIONS = new Set([
  "chat.create",
  "chat.launch",
  "chat.send",
  "chat.steer",
  "chat.approve",
  "chat.respondToInput",
  "chat.restart",
  "chat.handoff",
  "chat.rewindFiles",
  "chat.delete",
  "chat.archive",
  "chat.unarchive",
  "work.startCliSession",
  "work.resumeCliSession",
  "work.importExternalSession",
  "work.runQuickCommand",
  "work.sendToSession",
  "work.stopRuntime",
  "lanes.create",
  "lanes.createChild",
  "lanes.createFromUnstaged",
  "lanes.importBranch",
  "lanes.attach",
  "lanes.rename",
  "lanes.reparent",
  "lanes.archive",
  "lanes.unarchive",
  "lanes.delete",
  "lanes.rebaseStart",
  "lanes.rebasePush",
  "files.writeTextAtomic",
  "files.writeText",
  "files.createFile",
  "files.createDirectory",
  "files.rename",
  "files.delete",
  "git.stageFile",
  "git.stageAll",
  "git.unstageFile",
  "git.unstageAll",
  "git.discardFile",
  "git.restoreStagedFile",
  "git.commit",
  "git.push",
  "git.pull",
  "git.sync",
  "git.checkoutBranch",
  "git.cherryPick",
  "git.revert",
  "git.stashPush",
  "git.stashApply",
  "git.stashPop",
  "processes.start",
  "processes.stop",
  "processes.kill",
  "orchestration.runCreate",
  "prs.createFromLane",
  "prs.createQueue",
  "prs.land",
  "prs.updateDescription",
  "prs.updateBranch",
  "prs.retargetBase",
  "prs.delete",
  "prs.reorderQueue",
  "prs.close",
  "prs.reopen",
  "prs.addComment",
  "prs.submitReview",
  "prs.rerunChecks",
  "prs.startQueueAutomation",
  "automations.triggerManually",
]);

export function usageActionFromIpcChannel(channel: string): string {
  const action = channel.replace(/^ade\./, "");
  if (action.startsWith("agentChat.")) return `chat.${action.slice("agentChat.".length)}`;
  if (action === "pty.create") return "work.startCliSession";
  if (action === "pty.resumeSession") return "work.resumeCliSession";
  if (action === "pty.sendToSession") return "work.sendToSession";
  if (action === "externalSessions.import") return "work.importExternalSession";
  return action;
}

export function usageActionFromRpcDomain(domain: string, action: string): string {
  if (domain === "lane") return `lanes.${action}`;
  if (domain === "pr") {
    const aliases: Record<string, string> = {
      createQueuePrs: "createQueue",
      reorderQueuePrs: "reorderQueue",
      closePr: "close",
      reopenPr: "reopen",
      postReviewComment: "addComment",
    };
    return `prs.${aliases[action] ?? action}`;
  }
  if (domain === "file") {
    const aliases: Record<string, string> = {
      deletePath: "delete",
      writeWorkspaceText: "writeText",
    };
    return `files.${aliases[action] ?? action}`;
  }
  if (domain === "process") {
    if (action === "kill") return "processes.kill";
    if (action.startsWith("stop")) return "processes.stop";
    if (action.startsWith("start") || action.startsWith("restart")) return "processes.start";
  }
  if (domain === "pty") {
    if (action === "create") return "work.startCliSession";
    if (action === "resumeSession") return "work.resumeCliSession";
    if (action === "sendToSession") return "work.sendToSession";
    if (action === "dispose") return "work.stopRuntime";
  }
  if (domain === "terminal") {
    if (action === "reattachChatCli") return "work.resumeCliSession";
    if (action === "signal") return "work.stopRuntime";
  }
  if (domain === "external-sessions" && action === "import") return "work.importExternalSession";
  if (domain === "chat") {
    const aliases: Record<string, string> = {
      createSession: "create",
      launchCli: "launch",
      launchHeadless: "launch",
      sendMessage: "send",
      messageSession: "send",
      approveToolUse: "approve",
      archiveSession: "archive",
      unarchiveSession: "unarchive",
      deleteSession: "delete",
      handoffSession: "handoff",
    };
    return `chat.${aliases[action] ?? action}`;
  }
  if (domain === "git") {
    const aliases: Record<string, string> = {
      cherryPickCommit: "cherryPick",
      revertCommit: "revert",
    };
    return `git.${aliases[action] ?? action}`;
  }
  return `${domain}.${action}`;
}

export function isMeaningfulUsageAction(action: string): boolean {
  return MEANINGFUL_ACTIONS.has(action);
}

export function usageClientSurfaceFromRpcName(clientName: string | null | undefined): AdeUsageClientSurface {
  const normalized = clientName?.trim().toLowerCase() ?? "";
  if (normalized.includes("ade-desktop")) return "desktop";
  if (normalized.includes("ade-code") || normalized === "ade-cli") return "tui";
  if (normalized.includes("web")) return "web";
  return "api";
}

export function usageClientSurfaceFromPeer(deviceType: string | null | undefined, platform?: string | null): AdeUsageClientSurface {
  const normalized = `${deviceType ?? ""} ${platform ?? ""}`.toLowerCase();
  if (normalized.includes("browser") || normalized.includes("web")) return "web";
  if (normalized.includes("phone") || normalized.includes("ios") || normalized.includes("mobile")) return "mobile";
  if (normalized.includes("desktop") || normalized.includes("mac")) return "desktop";
  return "api";
}

export function recordUsageInteraction(
  db: AdeDb | null | undefined,
  args: {
    projectId?: string | null;
    client: AdeUsageClientSurface;
    action: string;
    feature?: string | null;
    sessionId?: string | null;
    occurredAt?: string;
  },
): void {
  if (!db || !isMeaningfulUsageAction(args.action)) return;
  try {
    db.run(
      `insert into usage_events(
        id, project_id, client_surface, action, feature, session_id, occurred_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        args.projectId?.trim() || "local",
        args.client,
        args.action,
        args.feature?.trim() || args.action.split(".", 1)[0] || "other",
        args.sessionId?.trim() || null,
        args.occurredAt ?? new Date().toISOString(),
      ],
    );
  } catch {
    // Usage accounting must never break the action it observes. Older runtimes
    // may receive a call before their schema migration has completed.
  }
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function int(value: unknown): number {
  return Math.max(0, Math.floor(finite(value)));
}

function safeAll<T extends Record<string, unknown>>(db: AdeDb, sql: string, params: SqlValue[] = []): T[] {
  try {
    return db.all<T>(sql, params);
  } catch {
    return [];
  }
}

function safeGet<T extends Record<string, unknown>>(db: AdeDb, sql: string, params: SqlValue[] = []): T | null {
  try {
    return db.get<T>(sql, params);
  } catch {
    return null;
  }
}

function rangeClause(column: string, range: AdeUsageStatsRange): { sql: string; params: SqlValue[] } {
  if (range.since) {
    return { sql: `${column} >= ? and ${column} <= ?`, params: [range.since, range.until] };
  }
  return { sql: `${column} <= ?`, params: [range.until] };
}

function providerFromToolType(toolType: unknown): string {
  const value = typeof toolType === "string" ? toolType.toLowerCase() : "";
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("droid")) return "droid";
  return value.includes("shell") ? "shell" : "other";
}

function sessionRuntime(row: { tool_type: string | null; resume_metadata_json: string | null }): { provider: string; model: string } {
  let metadata: Record<string, unknown> | null = null;
  try {
    const decoded = row.resume_metadata_json ? JSON.parse(row.resume_metadata_json) : null;
    metadata = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null;
  } catch {
    metadata = null;
  }
  const launch = metadata?.launch && typeof metadata.launch === "object" && !Array.isArray(metadata.launch)
    ? metadata.launch as Record<string, unknown>
    : null;
  const provider = typeof metadata?.provider === "string" && metadata.provider.trim()
    ? metadata.provider.trim()
    : providerFromToolType(row.tool_type);
  const model = typeof launch?.model === "string" && launch.model.trim() ? launch.model.trim() : provider;
  return { provider, model };
}

function isChatSession(row: { tool_type: string | null; chat_session_id: string | null }): boolean {
  const toolType = row.tool_type?.toLowerCase() ?? "";
  return Boolean(row.chat_session_id) || toolType.endsWith("-chat");
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

function calculateStreaks(activeDateValues: Iterable<string>, until: string): { activeDays: number; current: number; longest: number } {
  const activeDates = new Set(activeDateValues);
  const ordered = [...activeDates].sort();
  let longest = 0;
  let run = 0;
  let previousMs: number | null = null;
  for (const date of ordered) {
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp)) continue;
    run = previousMs != null && timestamp - previousMs === 86_400_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previousMs = timestamp;
  }

  let current = 0;
  const cursor = new Date(until);
  if (!Number.isFinite(cursor.getTime())) return { activeDays: activeDates.size, current, longest };
  cursor.setUTCHours(0, 0, 0, 0);
  if (!activeDates.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (activeDates.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return { activeDays: activeDates.size, current, longest };
}

export function collectAdeDatabaseUsageStats(
  db: AdeDb | null | undefined,
  range: AdeUsageStatsRange,
): AdeDatabaseUsageStats | null {
  if (!db) return null;

  const aiRange = rangeClause("timestamp", range);
  const sessionRange = rangeClause("started_at", range);
  const eventRange = rangeClause("occurred_at", range);
  const operationRange = rangeClause("started_at", range);
  const artifactRange = rangeClause("created_at", range);

  const aiRows = safeAll<{
    feature: string;
    provider: string;
    model: string | null;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    successes: number;
  }>(db, `
    select feature, provider, model, count(*) calls,
           sum(coalesce(input_tokens, 0)) input_tokens,
           sum(coalesce(output_tokens, 0)) output_tokens,
           sum(coalesce(duration_ms, 0)) duration_ms,
           sum(case when success = 1 then 1 else 0 end) successes
      from ai_usage_log
     where ${aiRange.sql}
     group by feature, provider, model
  `, aiRange.params);

  const sessionRows = safeAll<{
    id: string;
    lane_id: string;
    tool_type: string | null;
    resume_metadata_json: string | null;
    chat_session_id: string | null;
    started_at: string;
    ended_at: string | null;
  }>(db, `
    select id, lane_id, tool_type, resume_metadata_json, chat_session_id, started_at, ended_at
      from terminal_sessions
     where ${sessionRange.sql}
  `, sessionRange.params);

  const deltaRows = safeAll<{
    lane_id: string;
    lane_name: string | null;
    started_at: string;
    files_changed: number;
    insertions: number;
    deletions: number;
  }>(db, `
    select d.lane_id, l.name lane_name, d.started_at,
           d.files_changed, d.insertions, d.deletions
      from session_deltas d
      left join lanes l on l.id = d.lane_id
     where ${rangeClause("d.started_at", range).sql}
  `, rangeClause("d.started_at", range).params);

  const clientRows = safeAll<{
    client_surface: AdeUsageClientSurface;
    interactions: number;
    sessions: number;
    active_days: number;
    last_active_at: string | null;
  }>(db, `
    select client_surface, count(*) interactions,
           count(distinct session_id) sessions,
           count(distinct substr(occurred_at, 1, 10)) active_days,
           max(occurred_at) last_active_at
      from usage_events
     where ${eventRange.sql}
     group by client_surface
  `, eventRange.params);

  const clientDailyRows = safeAll<{
    date: string;
    client_surface: AdeUsageClientSurface;
    interactions: number;
  }>(db, `
    select substr(occurred_at, 1, 10) date, client_surface, count(*) interactions
      from usage_events
     where ${eventRange.sql}
     group by date, client_surface
  `, eventRange.params);

  const interactionRows = safeAll<{ action: string; count: number }>(db, `
    select action, count(*) count
      from usage_events
     where ${eventRange.sql}
     group by action
  `, eventRange.params);

  const operationRows = safeAll<{ kind: string; count: number }>(db, `
    select kind, count(*) count
      from operations
     where ${operationRange.sql}
       and status = 'succeeded'
       and kind in ('git_commit', 'git_push', 'pr_land', 'git_pull', 'git_sync_merge', 'git_sync_rebase')
     group by kind
  `, operationRange.params);
  const operationDailyRows = safeAll<{ date: string; kind: string; count: number }>(db, `
    select substr(started_at, 1, 10) date, kind, count(*) count
      from operations
     where ${operationRange.sql}
       and status = 'succeeded'
       and kind in ('git_commit', 'pr_land')
     group by date, kind
  `, operationRange.params);
  const operationCounts = new Map(operationRows.map((row) => [row.kind, int(row.count)]));
  const activityCounts = new Map(interactionRows.map((row) => [row.action, int(row.count)]));
  const operationActivityNames: Record<string, string> = {
    git_commit: "git.commit",
    git_push: "git.push",
    pr_land: "prs.land",
    git_pull: "git.pull",
    git_sync_merge: "git.sync",
    git_sync_rebase: "git.sync",
  };
  for (const row of operationRows) {
    const kind = operationActivityNames[row.kind] ?? row.kind;
    activityCounts.set(kind, Math.max(activityCounts.get(kind) ?? 0, int(row.count)));
  }

  const activeLaneRow = safeGet<{ count: number }>(db, "select count(*) count from lanes where archived_at is null");
  const laneCreatedRow = safeGet<{ count: number }>(db, `select count(*) count from lanes where ${rangeClause("created_at", range).sql}`, rangeClause("created_at", range).params);
  const laneArchivedRow = safeGet<{ count: number }>(db, `select count(*) count from lanes where archived_at is not null and ${rangeClause("archived_at", range).sql}`, rangeClause("archived_at", range).params);
  const artifactRow = safeGet<{ count: number }>(db, `select count(*) count from computer_use_artifacts where ${artifactRange.sql}`, artifactRange.params);
  const automationRow = safeGet<{ count: number }>(db, `select count(*) count from automation_runs where ${rangeClause("started_at", range).sql}`, rangeClause("started_at", range).params);
  const workerRow = safeGet<{ count: number }>(db, `select count(*) count from worker_agent_runs where ${rangeClause("created_at", range).sql}`, rangeClause("created_at", range).params);

  const providersByName = new Map<string, AdeUsageProviderSummary>();
  const modelsByKey = new Map<string, AdeUsageModelSummary>();
  const featureRows = new Map<string, AdeUsageFeatureSummary>();
  const featureSuccesses = new Map<string, number>();
  for (const row of aiRows) {
    const provider = row.provider?.trim() || "unknown";
    const inputTokens = int(row.input_tokens);
    const outputTokens = int(row.output_tokens);
    const totalTokens = inputTokens + outputTokens;
    const providerRow = providersByName.get(provider) ?? {
      provider,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      rangeCostUsd: 0,
      todayCostUsd: 0,
      last30dCostUsd: 0,
    };
    providerRow.inputTokens += inputTokens;
    providerRow.outputTokens += outputTokens;
    providerRow.totalTokens += totalTokens;
    providersByName.set(provider, providerRow);

    const model = row.model?.trim() || "unknown";
    const modelKey = `${provider}\u0000${model}`;
    const modelRow = modelsByKey.get(modelKey) ?? {
      provider,
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    modelRow.calls += int(row.calls);
    modelRow.inputTokens += inputTokens;
    modelRow.outputTokens += outputTokens;
    modelRow.totalTokens += totalTokens;
    modelsByKey.set(modelKey, modelRow);

    const featureKey = `${row.feature}\u0000${provider}`;
    const feature = featureRows.get(featureKey) ?? {
      feature: row.feature,
      provider,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      successRate: 0,
    };
    feature.calls += int(row.calls);
    feature.inputTokens += inputTokens;
    feature.outputTokens += outputTokens;
    feature.totalTokens += totalTokens;
    const successes = (featureSuccesses.get(featureKey) ?? 0) + int(row.successes);
    featureSuccesses.set(featureKey, successes);
    feature.successRate = feature.calls > 0 ? Math.round((successes / feature.calls) * 100) : 0;
    featureRows.set(featureKey, feature);
  }

  const sessionProviderMap = new Map<string, { sessions: number; models: Set<string>; latestAt: string | null }>();
  const sessionModelMap = new Map<string, AdeUsageAgentModelSummary>();
  for (const row of sessionRows) {
    const { provider, model: modelName } = sessionRuntime(row);
    const current = sessionProviderMap.get(provider) ?? { sessions: 0, models: new Set<string>(), latestAt: null };
    current.sessions += 1;
    current.models.add(modelName);
    if (!current.latestAt || row.started_at > current.latestAt) current.latestAt = row.started_at;
    sessionProviderMap.set(provider, current);
    const modelKey = `${provider}\u0000${modelName}`;
    const model = sessionModelMap.get(modelKey) ?? { provider, model: modelName, sessions: 0, latestAt: null };
    model.sessions += 1;
    if (!model.latestAt || row.started_at > model.latestAt) model.latestAt = row.started_at;
    sessionModelMap.set(modelKey, model);
  }

  const laneMap = new Map<string, AdeUsageLaneSummary>();
  for (const session of sessionRows) {
    const lane = laneMap.get(session.lane_id) ?? {
      laneId: session.lane_id,
      laneName: session.lane_id,
      sessions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
    lane.sessions += 1;
    laneMap.set(session.lane_id, lane);
  }
  for (const delta of deltaRows) {
    const lane = laneMap.get(delta.lane_id) ?? {
      laneId: delta.lane_id,
      laneName: delta.lane_name || delta.lane_id,
      sessions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
    lane.laneName = delta.lane_name || lane.laneName;
    lane.filesChanged += int(delta.files_changed);
    lane.insertions += int(delta.insertions);
    lane.deletions += int(delta.deletions);
    laneMap.set(delta.lane_id, lane);
  }

  const daily = new Map<string, Partial<AdeUsageDailyPoint> & Pick<AdeUsageDailyPoint, "date">>();
  const ensureDay = (date: string) => {
    const existing = daily.get(date) ?? { date, clients: {} };
    daily.set(date, existing);
    return existing;
  };
  const aiDailyRows = safeAll<{
    date: string;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
  }>(db, `
    select substr(timestamp, 1, 10) date,
           sum(coalesce(input_tokens, 0)) input_tokens,
           sum(coalesce(output_tokens, 0)) output_tokens,
           sum(coalesce(duration_ms, 0)) duration_ms
      from ai_usage_log
     where ${aiRange.sql}
     group by date
  `, aiRange.params);
  for (const row of aiDailyRows) {
    const day = ensureDay(row.date);
    day.inputTokens = int(row.input_tokens);
    day.outputTokens = int(row.output_tokens);
    day.totalTokens = int(row.input_tokens) + int(row.output_tokens);
    day.durationMs = int(row.duration_ms);
  }
  for (const row of sessionRows) {
    const date = isoDate(row.started_at);
    if (!date) continue;
    const day = ensureDay(date);
    day.sessions = int(day.sessions) + 1;
  }
  for (const row of deltaRows) {
    const date = isoDate(row.started_at);
    if (!date) continue;
    const day = ensureDay(date);
    day.filesChanged = int(day.filesChanged) + int(row.files_changed);
    day.insertions = int(day.insertions) + int(row.insertions);
    day.deletions = int(day.deletions) + int(row.deletions);
  }
  for (const row of clientDailyRows) {
    const day = ensureDay(row.date);
    day.interactions = int(day.interactions) + int(row.interactions);
    day.clients = { ...(day.clients ?? {}), [row.client_surface]: int(row.interactions) };
  }
  for (const row of operationDailyRows) {
    const day = ensureDay(row.date);
    if (row.kind === "git_commit") day.commits = int(day.commits) + int(row.count);
    if (row.kind === "pr_land") day.prs = int(day.prs) + int(row.count);
  }

  const activeDates = new Set<string>();
  for (const [date, point] of daily) {
    if (int(point.totalTokens) + int(point.sessions) + int(point.interactions) + int(point.insertions) + int(point.deletions) + int(point.commits) + int(point.prs) > 0) {
      activeDates.add(date);
    }
  }
  const streaks = calculateStreaks(activeDates, range.until);
  const longestSessionMs = sessionRows.reduce((max, row) => {
    const start = Date.parse(row.started_at);
    const end = Date.parse(row.ended_at ?? range.until);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return max;
    return Math.max(max, Math.max(0, end - start));
  }, 0);

  const trackedInput = aiRows.reduce((sum, row) => sum + int(row.input_tokens), 0);
  const trackedOutput = aiRows.reduce((sum, row) => sum + int(row.output_tokens), 0);
  const trackedCalls = aiRows.reduce((sum, row) => sum + int(row.calls), 0);
  const trackedDuration = aiRows.reduce((sum, row) => sum + int(row.duration_ms), 0);
  const filesChanged = deltaRows.reduce((sum, row) => sum + int(row.files_changed), 0);
  const insertions = deltaRows.reduce((sum, row) => sum + int(row.insertions), 0);
  const deletions = deltaRows.reduce((sum, row) => sum + int(row.deletions), 0);
  const clients: AdeUsageClientSummary[] = clientRows
    .map((row) => ({
      client: row.client_surface,
      interactions: int(row.interactions),
      activeDays: int(row.active_days),
      sessions: int(row.sessions),
      lastActiveAt: row.last_active_at,
    }))
    .sort((a, b) => b.interactions - a.interactions);

  return {
    summary: {
      trackedAdeTokens: trackedInput + trackedOutput,
      trackedAdeInputTokens: trackedInput,
      trackedAdeOutputTokens: trackedOutput,
      trackedAdeCalls: trackedCalls,
      trackedAdeDurationMs: trackedDuration,
      chatSessions: sessionRows.filter(isChatSession).length,
      terminalSessions: sessionRows.filter((row) => !isChatSession(row)).length,
      activeLanes: int(activeLaneRow?.count),
      lanesCreated: int(laneCreatedRow?.count),
      lanesArchived: int(laneArchivedRow?.count),
      commitsCreated: operationCounts.get("git_commit") ?? 0,
      pushOperations: operationCounts.get("git_push") ?? 0,
      prLandings: operationCounts.get("pr_land") ?? 0,
      filesChanged,
      insertions,
      deletions,
      artifactsCaptured: int(artifactRow?.count),
      automationRuns: int(automationRow?.count),
      workerRuns: int(workerRow?.count),
      totalInteractions: clients.reduce((sum, row) => sum + row.interactions, 0),
      activeDays: streaks.activeDays,
      currentStreakDays: streaks.current,
      longestStreakDays: streaks.longest,
      longestSessionMs,
    },
    providers: [...providersByName.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    models: [...modelsByKey.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    agentProviders: [...sessionProviderMap.entries()].map(([provider, value]) => ({
      provider,
      sessions: value.sessions,
      models: value.models.size,
      latestAt: value.latestAt,
    })).sort((a, b) => b.sessions - a.sessions),
    agentModels: [...sessionModelMap.values()].sort((a, b) => b.sessions - a.sessions),
    features: [...featureRows.values()].sort((a, b) => b.calls - a.calls),
    lanes: [...laneMap.values()].sort((a, b) => b.sessions - a.sessions || (b.insertions + b.deletions) - (a.insertions + a.deletions)),
    activities: [...activityCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    clients,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
