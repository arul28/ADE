/**
 * chatMessageService.ts
 *
 * Messaging: sendChat, getChat, listChatThreads, getThreadMessages,
 * sendThreadMessage, sendAgentMessage, deliverMessageToAgent,
 * getGlobalChat, parseMentions, getActiveAgents, replayQueuedWorkerMessages,
 * chat session management, message persistence, enqueueChatResponse.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import { randomUUID } from "node:crypto";
import type {
  OrchestratorContext,
  OrchestratorChatSessionState,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorChatTarget,
  OrchestratorChatVisibilityMode,
  OrchestratorChatDeliveryState,
  OrchestratorChatThreadType,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  parseChatMessage,
  parseChatSessionState,
  parseChatTarget,
  sanitizeChatTarget,
  teammateThreadIdentity,
  workerThreadIdentity,
  deriveThreadTitle,
  toOptionalString,
  clipTextForContext,
  normalizeChatVisibility,
  normalizeChatDeliveryState,
  normalizeThreadType,
  clampLimit,
  missionThreadId,
  parseJsonRecord,
  ORCHESTRATOR_CHAT_METADATA_KEY,
  ORCHESTRATOR_CHAT_SESSION_METADATA_KEY,
  MAX_PERSISTED_CHAT_MESSAGES,
  MAX_CHAT_CONTEXT_CHARS,
  MAX_CHAT_CONTEXT_MESSAGES,
  MAX_CHAT_LINE_CHARS,
  DEFAULT_CHAT_VISIBILITY,
  DEFAULT_CHAT_DELIVERY,
  DEFAULT_WORKER_CHAT_VISIBILITY,
  DEFAULT_THREAD_STATUS,
  DEFAULT_CHAT_THREAD_TITLE,
  CONTEXT_CHECKPOINT_CHAT_THRESHOLD,
  WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS,
  WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS,
  STEERING_DIRECTIVES_METADATA_KEY,
  MAX_PERSISTED_STEERING_DIRECTIVES,
  parseSteeringDirective,
} from "./orchestratorContext";
import type {
  SendOrchestratorChatArgs,
  GetOrchestratorChatArgs,
  ListOrchestratorChatThreadsArgs,
  GetOrchestratorThreadMessagesArgs,
  SendOrchestratorThreadMessageArgs,
  SendAgentMessageArgs,
  GetGlobalChatArgs,
  GetActiveAgentsArgs,
  ActiveAgentInfo,
  OrchestratorRunGraph,
  OrchestratorThreadEvent,
} from "../../../shared/types";

// ── Thread Event Emission ────────────────────────────────────────

export function emitThreadEvent(
  ctx: OrchestratorContext,
  event: Omit<OrchestratorThreadEvent, "at">
): void {
  if (ctx.disposed.current) return;
  try {
    ctx.onThreadEvent?.({
      ...event,
      at: nowIso()
    });
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.thread_event_emit_failed", {
      type: event.type,
      missionId: event.missionId,
      threadId: event.threadId ?? null,
      messageId: event.messageId ?? null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// ── Mission Metadata Helpers ─────────────────────────────────────

export function getMissionMetadata(ctx: OrchestratorContext, missionId: string): Record<string, unknown> {
  const row = ctx.db.get<{ metadata_json: string | null }>(
    `select metadata_json from missions where id = ? limit 1`,
    [missionId]
  );
  if (!row?.metadata_json) return {};
  try {
    return JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function updateMissionMetadata(
  ctx: OrchestratorContext,
  missionId: string,
  mutate: (metadata: Record<string, unknown>) => void
): void {
  const metadata = getMissionMetadata(ctx, missionId);
  mutate(metadata);
  ctx.db.run(
    `update missions set metadata_json = ?, updated_at = ? where id = ?`,
    [JSON.stringify(metadata), nowIso(), missionId]
  );
}

export function getMissionIdentity(
  ctx: OrchestratorContext,
  missionId: string
): { projectId: string; laneId: string | null } | null {
  const row = ctx.db.get<{ project_id: string; lane_id: string | null }>(
    `select project_id, lane_id from missions where id = ? limit 1`,
    [missionId]
  );
  if (!row?.project_id) return null;
  return {
    projectId: row.project_id,
    laneId: row.lane_id ?? null
  };
}

export function getMissionIdForRun(ctx: OrchestratorContext, runId: string): string | null {
  const row = ctx.db.get<{ mission_id: string | null }>(
    `select mission_id from orchestrator_runs where id = ? limit 1`,
    [runId]
  );
  return toOptionalString(row?.mission_id);
}

export function getRunMetadata(ctx: OrchestratorContext, runId: string): Record<string, unknown> {
  const row = ctx.db.get<{ metadata_json: string | null }>(
    `select metadata_json from orchestrator_runs where id = ? limit 1`,
    [runId]
  );
  if (!row?.metadata_json) return {};
  try {
    const parsed = JSON.parse(row.metadata_json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function updateRunMetadata(
  ctx: OrchestratorContext,
  runId: string,
  mutate: (metadata: Record<string, unknown>) => void
): boolean {
  const row = ctx.db.get<{ id: string; metadata_json: string | null }>(
    `select id, metadata_json from orchestrator_runs where id = ? limit 1`,
    [runId]
  );
  if (!row?.id) return false;
  const metadata = (() => {
    if (!row.metadata_json) return {} as Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata_json);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  mutate(metadata);
  ctx.db.run(
    `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
    [JSON.stringify(metadata), nowIso(), runId]
  );
  return true;
}

// ── Steering Directive Helpers ───────────────────────────────────

export function loadSteeringDirectivesFromMetadata(
  ctx: OrchestratorContext,
  missionId: string
): import("./orchestratorContext").UserSteeringDirective[] {
  if (ctx.activeSteeringDirectives.has(missionId)) {
    return ctx.activeSteeringDirectives.get(missionId) ?? [];
  }
  const metadata = getMissionMetadata(ctx, missionId);
  const stored = Array.isArray(metadata[STEERING_DIRECTIVES_METADATA_KEY])
    ? metadata[STEERING_DIRECTIVES_METADATA_KEY] as unknown[]
    : [];
  const parsed = stored
    .map((entry) => parseSteeringDirective(entry, missionId))
    .filter((d): d is import("./orchestratorContext").UserSteeringDirective => d !== null)
    .slice(-MAX_PERSISTED_STEERING_DIRECTIVES);
  if (parsed.length > 0) {
    ctx.activeSteeringDirectives.set(missionId, parsed);
  }
  return parsed;
}

export function loadChatMessagesFromMetadata(
  ctx: OrchestratorContext,
  missionId: string
): OrchestratorChatMessage[] {
  if (ctx.chatMessages.has(missionId)) {
    return ctx.chatMessages.get(missionId) ?? [];
  }
  const metadata = getMissionMetadata(ctx, missionId);
  const stored = Array.isArray(metadata[ORCHESTRATOR_CHAT_METADATA_KEY])
    ? metadata[ORCHESTRATOR_CHAT_METADATA_KEY] as unknown[]
    : [];
  const parsed = stored
    .map((entry) => parseChatMessage(entry, missionId))
    .filter((msg): msg is OrchestratorChatMessage => msg !== null)
    .slice(-MAX_PERSISTED_CHAT_MESSAGES);
  if (parsed.length > 0) {
    ctx.chatMessages.set(missionId, parsed);
  }
  return parsed;
}

export function loadChatSessionStateFromMetadata(
  ctx: OrchestratorContext,
  missionId: string
): OrchestratorChatSessionState | null {
  if (ctx.activeChatSessions.has(missionId)) {
    return ctx.activeChatSessions.get(missionId) ?? null;
  }
  const metadata = getMissionMetadata(ctx, missionId);
  const parsed = parseChatSessionState(metadata[ORCHESTRATOR_CHAT_SESSION_METADATA_KEY]);
  if (parsed) {
    ctx.activeChatSessions.set(missionId, parsed);
    return parsed;
  }
  return null;
}

export function persistChatSessionState(
  ctx: OrchestratorContext,
  missionId: string,
  state: OrchestratorChatSessionState
): void {
  ctx.activeChatSessions.set(missionId, state);
  try {
    updateMissionMetadata(ctx, missionId, (metadata) => {
      metadata[ORCHESTRATOR_CHAT_SESSION_METADATA_KEY] = state;
    });
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.chat_session_persist_failed", {
      missionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// ── Chat Context Builders ────────────────────────────────────────

export function formatRecentChatContext(
  messages: OrchestratorChatMessage[],
  limit = MAX_CHAT_CONTEXT_MESSAGES
): string {
  const recent = messages.slice(-limit);
  if (!recent.length) return "";
  const lines = recent.map((entry) => {
    const role = entry.role === "user" ? "User" : entry.role === "worker" ? "Worker" : "Orchestrator";
    const compact = clipTextForContext(
      entry.content.replace(/\s+/g, " ").trim(),
      MAX_CHAT_LINE_CHARS
    );
    return `- ${role}: ${compact}`;
  });
  const rendered = ["Recent mission chat:", ...lines, ""].join("\n");
  return clipTextForContext(rendered, MAX_CHAT_CONTEXT_CHARS);
}

export function buildRecentChatContext(
  ctx: OrchestratorContext,
  missionId: string,
  limit = MAX_CHAT_CONTEXT_MESSAGES
): string {
  const messages = ctx.chatMessages.get(missionId) ?? loadChatMessagesFromMetadata(ctx, missionId);
  return formatRecentChatContext(messages, limit);
}

// ── Orchestrator Message Emission ────────────────────────────────

export function formatOrchestratorContent(
  content: string,
  stepKey?: string | null,
  metadata?: Record<string, unknown> | null
): string {
  if (metadata?.role === "coordinator") return content;

  let formatted = content;
  formatted = formatted.replace(/```json[\s\S]*?```/g, "[json data]");
  formatted = formatted.replace(/```[\s\S]*?```/g, "[code block]");
  formatted = formatted.replace(/^[-+]{3}\s.*$/gm, "").replace(/^@@.*@@.*$/gm, "");
  formatted = formatted.replace(/\n{3,}/g, "\n\n").trim();

  if (formatted.length > 200) {
    formatted = `${formatted.slice(0, 197).trimEnd()}...`;
  }

  if (stepKey) {
    formatted = `[${stepKey}] ${formatted}`;
  }

  return formatted;
}

export function emitOrchestratorMessage(
  _ctx: OrchestratorContext,
  missionId: string,
  content: string,
  stepKey?: string | null,
  metadata?: Record<string, unknown> | null,
  deps?: {
    appendChatMessage: (message: OrchestratorChatMessage) => OrchestratorChatMessage;
  }
): OrchestratorChatMessage {
  const formattedContent = formatOrchestratorContent(content, stepKey, metadata);
  const msg: OrchestratorChatMessage = {
    id: randomUUID(),
    missionId,
    role: "orchestrator",
    content: formattedContent,
    timestamp: new Date().toISOString(),
    stepKey: stepKey ?? null,
    metadata: metadata ? { ...metadata, rawContent: content !== formattedContent ? content : undefined } : null
  };
  if (deps?.appendChatMessage) {
    return deps.appendChatMessage(msg);
  }
  return msg;
}

// ── Mention Parsing ──────────────────────────────────────────────

export function parseMentions(content: string): { mentions: string[]; cleanContent: string } {
  const mentionPattern = /@([\w-]+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(content)) !== null) {
    mentions.push(match[1]);
  }
  const cleanContent = content.replace(/@[\w-]+/g, "").trim();
  return { mentions, cleanContent };
}

// ── Worker Delivery Helpers ──────────────────────────────────────

export function normalizeDeliveryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  return String(error ?? "Unknown delivery failure");
}

export function isBusyDeliveryError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes("turn is already active")
    || normalized.includes("already active")
    || normalized.includes("busy");
}

export function isNoActiveTurnError(errorMessage: string): boolean {
  return /\bno active turn\b/i.test(errorMessage);
}

export function computeWorkerRetryBackoffMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1);
  return Math.min(
    WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS,
    WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS * (2 ** exponent)
  );
}

// ── Thread Row Type ──────────────────────────────────────────────

export type ThreadRow = {
  id: string;
  mission_id: string;
  thread_type: string;
  title: string;
  run_id: string | null;
  step_id: string | null;
  step_key: string | null;
  attempt_id: string | null;
  session_id: string | null;
  lane_id: string | null;
  status: string;
  unread_count: number | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

// ── Thread Management ────────────────────────────────────────────

export function parseThreadRow(row: ThreadRow): OrchestratorChatThread {
  const metadata = parseJsonRecord(row.metadata_json);
  const thread: OrchestratorChatThread = {
    id: row.id,
    missionId: row.mission_id,
    threadType: normalizeThreadType(row.thread_type),
    title: String(row.title ?? DEFAULT_CHAT_THREAD_TITLE),
    runId: row.run_id ?? null,
    stepId: row.step_id ?? null,
    stepKey: row.step_key ?? null,
    attemptId: row.attempt_id ?? null,
    sessionId: row.session_id ?? null,
    laneId: row.lane_id ?? null,
    status: row.status === "closed" ? "closed" : "active",
    unreadCount: Number.isFinite(Number(row.unread_count)) ? Math.max(0, Math.floor(Number(row.unread_count))) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata
  };
  return thread;
}

export function getThreadById(ctx: OrchestratorContext, missionId: string, threadId: string): OrchestratorChatThread | null {
  const row = ctx.db.get<ThreadRow>(
    `
      select
        id,
        mission_id,
        thread_type,
        title,
        run_id,
        step_id,
        step_key,
        attempt_id,
        session_id,
        lane_id,
        status,
        unread_count,
        metadata_json,
        created_at,
        updated_at
      from orchestrator_chat_threads
      where mission_id = ?
        and id = ?
      limit 1
    `,
    [missionId, threadId]
  );
  if (!row) return null;
  return parseThreadRow(row);
}

export function upsertThread(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    threadId: string;
    threadType: OrchestratorChatThreadType;
    title: string;
    target: OrchestratorChatTarget | null;
    status?: "active" | "closed";
    metadata?: Record<string, unknown> | null;
  }
): OrchestratorChatThread {
  const missionIdentity = getMissionIdentity(ctx, args.missionId);
  if (!missionIdentity) {
    throw new Error(`Mission not found: ${args.missionId}`);
  }
  const target = sanitizeChatTarget(args.target);
  const runId = (target && "runId" in target ? target.runId : null) ?? null;
  const isWorkerTarget = target?.kind === "worker";
  const isTeammateTarget = target?.kind === "teammate";
  const stepId = isWorkerTarget ? target.stepId ?? null : null;
  const stepKey = isWorkerTarget ? target.stepKey ?? null : null;
  const attemptId = isWorkerTarget ? target.attemptId ?? null : null;
  const sessionId = isWorkerTarget
    ? target.sessionId ?? null
    : isTeammateTarget
      ? target.sessionId ?? null
      : null;
  const laneId = isWorkerTarget ? target.laneId ?? missionIdentity.laneId : missionIdentity.laneId;
  const metadataJson =
    args.metadata
      ? JSON.stringify(args.metadata)
      : isTeammateTarget && target.teamMemberId
        ? JSON.stringify({ teamMemberId: target.teamMemberId })
        : null;
  const now = nowIso();
  ctx.db.run(
    `
      insert into orchestrator_chat_threads(
        id,
        project_id,
        mission_id,
        thread_type,
        title,
        run_id,
        step_id,
        step_key,
        attempt_id,
        session_id,
        lane_id,
        status,
        unread_count,
        metadata_json,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      on conflict(id) do update set
        thread_type = excluded.thread_type,
        title = excluded.title,
        run_id = excluded.run_id,
        step_id = excluded.step_id,
        step_key = excluded.step_key,
        attempt_id = excluded.attempt_id,
        session_id = excluded.session_id,
        lane_id = excluded.lane_id,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `,
    [
      args.threadId,
      missionIdentity.projectId,
      args.missionId,
      args.threadType,
      args.title,
      runId,
      stepId,
      stepKey,
      attemptId,
      sessionId,
      laneId,
      args.status ?? DEFAULT_THREAD_STATUS,
      metadataJson,
      now,
      now
    ]
  );
  const nextThread = getThreadById(ctx, args.missionId, args.threadId) ?? {
    id: args.threadId,
    missionId: args.missionId,
    threadType: args.threadType,
    title: args.title,
    runId,
    stepId,
    stepKey,
    attemptId,
    sessionId,
    laneId,
    status: args.status ?? "active",
    unreadCount: 0,
    createdAt: now,
    updatedAt: now,
    metadata:
      args.metadata
      ?? (isTeammateTarget && target.teamMemberId ? { teamMemberId: target.teamMemberId } : null)
  };
  emitThreadEvent(ctx, {
    type: "thread_updated",
    missionId: args.missionId,
    threadId: nextThread.id,
    runId: nextThread.runId ?? null,
    reason: "upsert_thread"
  });
  return nextThread;
}

export function ensureMissionThread(ctx: OrchestratorContext, missionId: string): OrchestratorChatThread {
  const id = missionThreadId(missionId);
  const existing = getThreadById(ctx, missionId, id);
  if (existing) return existing;
  return upsertThread(ctx, {
    missionId,
    threadId: id,
    threadType: "coordinator",
    title: DEFAULT_CHAT_THREAD_TITLE,
    target: {
      kind: "coordinator",
      runId: null
    }
  });
}

export function ensureThreadForTarget(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    threadId?: string | null;
    target?: OrchestratorChatTarget | null;
    fallbackTitle?: string | null;
  }
): OrchestratorChatThread {
  const missionId = args.missionId;
  const requestedThreadId = toOptionalString(args.threadId);
  if (requestedThreadId) {
    const existing = getThreadById(ctx, missionId, requestedThreadId);
    if (existing) return existing;
    const target = sanitizeChatTarget(args.target);
    const threadType: OrchestratorChatThreadType =
      target?.kind === "worker"
        ? "worker"
        : target?.kind === "teammate"
          ? "teammate"
          : "coordinator";
    return upsertThread(ctx, {
      missionId,
      threadId: requestedThreadId,
      threadType,
      title: deriveThreadTitle({
        target,
        step: null,
        lane: null,
        fallback: args.fallbackTitle ?? undefined
      }),
      target
    });
  }

  const target = sanitizeChatTarget(args.target);
  if (!target || target.kind === "coordinator" || target.kind === "workers") {
    return ensureMissionThread(ctx, missionId);
  }
  if (target.kind === "teammate") {
    const identity = teammateThreadIdentity(target);
    const fallbackId = `teammate:${missionId}:${identity ?? randomUUID()}`;
    const existing = getThreadById(ctx, missionId, fallbackId);
    if (existing) return existing;
    return upsertThread(ctx, {
      missionId,
      threadId: fallbackId,
      threadType: "teammate",
      title: deriveThreadTitle({
        target,
        step: null,
        lane: null,
        fallback: args.fallbackTitle ?? undefined
      }),
      target,
      metadata: target.teamMemberId ? { teamMemberId: target.teamMemberId } : null
    });
  }
  const identity = workerThreadIdentity(target);
  const fallbackId = `worker:${missionId}:${identity ?? randomUUID()}`;
  const existing = getThreadById(ctx, missionId, fallbackId);
  if (existing) return existing;
  return upsertThread(ctx, {
    missionId,
    threadId: fallbackId,
    threadType: "worker",
    title: deriveThreadTitle({
      target,
      step: null,
      lane: null,
      fallback: args.fallbackTitle ?? undefined
    }),
    target
  });
}

// ── Chat Message Row Parsing ─────────────────────────────────────

export type ChatMessageRow = {
  id: string;
  mission_id: string;
  role: string;
  content: string;
  timestamp: string;
  step_key: string | null;
  thread_id: string | null;
  target_json: string | null;
  visibility: string | null;
  delivery_state: string | null;
  source_session_id: string | null;
  attempt_id: string | null;
  lane_id: string | null;
  run_id: string | null;
  metadata_json: string | null;
};

export function parseChatMessageRow(row: ChatMessageRow): OrchestratorChatMessage | null {
  const role =
    row.role === "user" || row.role === "worker" || row.role === "orchestrator" || row.role === "agent"
      ? row.role
      : null;
  if (!role) return null;
  return {
    id: row.id,
    missionId: row.mission_id,
    role,
    content: row.content,
    timestamp: row.timestamp,
    stepKey: row.step_key ?? null,
    threadId: row.thread_id ?? null,
    target: parseChatTarget(parseJsonRecord(row.target_json)),
    visibility: normalizeChatVisibility(row.visibility),
    deliveryState: normalizeChatDeliveryState(row.delivery_state),
    sourceSessionId: row.source_session_id ?? null,
    attemptId: row.attempt_id ?? null,
    laneId: row.lane_id ?? null,
    runId: row.run_id ?? null,
    metadata: parseJsonRecord(row.metadata_json)
  };
}

export function getChatMessageById(ctx: OrchestratorContext, messageId: string): OrchestratorChatMessage | null {
  const row = ctx.db.get<ChatMessageRow>(
    `
      select
        id,
        mission_id,
        role,
        content,
        timestamp,
        step_key,
        thread_id,
        target_json,
        visibility,
        delivery_state,
        source_session_id,
        attempt_id,
        lane_id,
        run_id,
        metadata_json
      from orchestrator_chat_messages
      where id = ?
      limit 1
    `,
    [messageId]
  );
  return row ? parseChatMessageRow(row) : null;
}

export function loadChatMessagesFromDb(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    threadId?: string | null;
    limit?: number;
    before?: string | null;
  }
): OrchestratorChatMessage[] {
  const limit = clampLimit(args.limit, MAX_PERSISTED_CHAT_MESSAGES, 500);
  const rows = ctx.db.all<ChatMessageRow>(
    `
      select
        id,
        mission_id,
        role,
        content,
        timestamp,
        step_key,
        thread_id,
        target_json,
        visibility,
        delivery_state,
        source_session_id,
        attempt_id,
        lane_id,
        run_id,
        metadata_json
      from orchestrator_chat_messages
      where mission_id = ?
        and (? is null or thread_id = ?)
        and (? is null or timestamp < ?)
      order by timestamp desc
      limit ?
    `,
    [
      args.missionId,
      args.threadId ?? null,
      args.threadId ?? null,
      args.before ?? null,
      args.before ?? null,
      limit
    ]
  );
  if (!rows.length) return [];
  return rows
    .map((row) => parseChatMessageRow(row))
    .filter((entry): entry is OrchestratorChatMessage => !!entry)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/**
 * Summarize the latest run for a mission as a concise text string.
 */
export function summarizeRunForChat(ctx: OrchestratorContext, missionId: string): string {
  const runs = ctx.orchestratorService.listRuns({ missionId });
  if (!runs.length) return "No run has started yet.";
  const byCreatedDesc = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const activeRun = byCreatedDesc.find((entry) => entry.status === "active" || entry.status === "bootstrapping" || entry.status === "queued" || entry.status === "paused");
  const targetRun = activeRun ?? byCreatedDesc[0];
  if (!targetRun) return "No run has started yet.";
  try {
    const graph = ctx.orchestratorService.getRunGraph({ runId: targetRun.id, timelineLimit: 0 });
    const total = graph.steps.length;
    const running = graph.steps.filter((step) => step.status === "running").length;
    const done = graph.steps.filter((step) =>
      step.status === "succeeded" || step.status === "failed" || step.status === "skipped" || step.status === "canceled"
    ).length;
    const failed = graph.steps.filter((step) => step.status === "failed").length;
    const blocked = graph.steps.filter((step) => step.status === "blocked").length;
    const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
    const autopilot = isRecord(runMeta.autopilot) ? runMeta.autopilot : null;
    const parallelCap =
      autopilot && Number.isFinite(Number(autopilot.parallelismCap))
        ? Math.max(1, Math.floor(Number(autopilot.parallelismCap)))
        : null;
    const runningSteps = graph.steps
      .filter((step) => step.status === "running")
      .slice(0, 3)
      .map((step) => `${step.title || step.stepKey}${step.laneId ? ` @${step.laneId}` : ""}`);
    const readySteps = graph.steps
      .filter((step) => step.status === "ready")
      .slice(0, 3)
      .map((step) => `${step.title || step.stepKey}${step.laneId ? ` @${step.laneId}` : ""}`);
    return [
      `Run ${targetRun.id.slice(0, 8)} is ${targetRun.status}. Progress ${done}/${total}. Running ${running}. Failed ${failed}. Blocked ${blocked}.`,
      parallelCap ? `Parallelism cap: ${parallelCap}.` : null,
      runningSteps.length ? `Active steps: ${runningSteps.join("; ")}.` : null,
      readySteps.length ? `Ready queue: ${readySteps.join("; ")}.` : null
    ]
      .filter((line): line is string => Boolean(line))
      .join(" ");
  } catch {
    return `Latest run ${targetRun.id.slice(0, 8)} is ${targetRun.status}.`;
  }
}

// ── Chat Message Update Persistence ─────────────────────────────

export function persistUpdatedChatMessage(
  ctx: OrchestratorContext,
  next: OrchestratorChatMessage
): OrchestratorChatMessage {
  const normalized: OrchestratorChatMessage = {
    ...next,
    target: sanitizeChatTarget(next.target ?? null),
    visibility: normalizeChatVisibility(next.visibility),
    deliveryState: normalizeChatDeliveryState(next.deliveryState),
    metadata: isRecord(next.metadata) ? next.metadata : null
  };
  ctx.db.run(
    `
      update orchestrator_chat_messages
      set
        thread_id = ?,
        step_key = ?,
        target_json = ?,
        visibility = ?,
        delivery_state = ?,
        source_session_id = ?,
        attempt_id = ?,
        lane_id = ?,
        run_id = ?,
        metadata_json = ?
      where id = ?
    `,
    [
      normalized.threadId ?? missionThreadId(normalized.missionId),
      normalized.stepKey ?? null,
      normalized.target ? JSON.stringify(normalized.target) : null,
      normalizeChatVisibility(normalized.visibility),
      normalizeChatDeliveryState(normalized.deliveryState),
      normalized.sourceSessionId ?? null,
      normalized.attemptId ?? null,
      normalized.laneId ?? null,
      normalized.runId ?? null,
      normalized.metadata ? JSON.stringify(normalized.metadata) : null,
      normalized.id
    ]
  );

  const current = ctx.chatMessages.get(normalized.missionId);
  if (current?.length) {
    const nextMessages = current.map((entry) => (entry.id === normalized.id ? normalized : entry));
    ctx.chatMessages.set(normalized.missionId, nextMessages);
  }

  try {
    updateMissionMetadata(ctx, normalized.missionId, (metadata) => {
      const existing = Array.isArray(metadata[ORCHESTRATOR_CHAT_METADATA_KEY])
        ? (metadata[ORCHESTRATOR_CHAT_METADATA_KEY] as unknown[])
        : [];
      metadata[ORCHESTRATOR_CHAT_METADATA_KEY] = existing.map((entry) => {
        const parsed = parseChatMessage(entry, normalized.missionId);
        return parsed?.id === normalized.id ? normalized : entry;
      });
    });
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.chat_metadata_message_update_failed", {
      missionId: normalized.missionId,
      messageId: normalized.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  emitThreadEvent(ctx, {
    type: "message_updated",
    missionId: normalized.missionId,
    threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
    messageId: normalized.id,
    runId: normalized.runId ?? null,
    reason: "message_update"
  });
  emitThreadEvent(ctx, {
    type: "thread_updated",
    missionId: normalized.missionId,
    threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
    runId: normalized.runId ?? null,
    reason: "message_update"
  });

  return normalized;
}

export function updateChatMessage(
  ctx: OrchestratorContext,
  messageId: string,
  updater: (current: OrchestratorChatMessage) => OrchestratorChatMessage
): OrchestratorChatMessage | null {
  const current = getChatMessageById(ctx, messageId);
  if (!current) return null;
  const next = updater(current);
  if (next.id !== current.id || next.missionId !== current.missionId) {
    throw new Error("Chat message identity cannot change during update.");
  }
  return persistUpdatedChatMessage(ctx, next);
}

// ── appendChatMessage ────────────────────────────────────────────

export function appendChatMessageCtx(
  ctx: OrchestratorContext,
  message: OrchestratorChatMessage
): OrchestratorChatMessage {
  if (ctx.disposed.current) {
    return {
      ...message,
      target: sanitizeChatTarget(message.target ?? null),
      visibility: normalizeChatVisibility(message.visibility),
      deliveryState: normalizeChatDeliveryState(message.deliveryState),
      metadata: isRecord(message.metadata) ? message.metadata : null
    };
  }
  const thread = ensureThreadForTarget(ctx, {
    missionId: message.missionId,
    threadId: message.threadId ?? null,
    target: message.target ?? null
  });
  const normalized: OrchestratorChatMessage = {
    ...message,
    threadId: thread.id,
    visibility: normalizeChatVisibility(message.visibility),
    deliveryState: normalizeChatDeliveryState(message.deliveryState),
    target: sanitizeChatTarget(message.target ?? null),
    metadata: isRecord(message.metadata) ? message.metadata : null
  };
  const existing = ctx.chatMessages.has(normalized.missionId)
    ? ctx.chatMessages.get(normalized.missionId) ?? []
    : loadChatMessagesFromMetadata(ctx, normalized.missionId);
  const next = [...existing, normalized].slice(-MAX_PERSISTED_CHAT_MESSAGES);
  ctx.chatMessages.set(message.missionId, next);
  try {
    updateMissionMetadata(ctx, normalized.missionId, (metadata) => {
      metadata[ORCHESTRATOR_CHAT_METADATA_KEY] = next;
    });
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.chat_persist_failed", {
      missionId: normalized.missionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  const missionIdentity = getMissionIdentity(ctx, normalized.missionId);
  if (missionIdentity) {
    const createdAt = nowIso();
    ctx.db.run(
      `
        insert into orchestrator_chat_messages(
          id,
          project_id,
          mission_id,
          thread_id,
          role,
          content,
          timestamp,
          step_key,
          target_json,
          visibility,
          delivery_state,
          source_session_id,
          attempt_id,
          lane_id,
          run_id,
          metadata_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        normalized.id,
        missionIdentity.projectId,
        normalized.missionId,
        normalized.threadId ?? missionThreadId(normalized.missionId),
        normalized.role,
        normalized.content,
        normalized.timestamp,
        normalized.stepKey ?? null,
        normalized.target ? JSON.stringify(normalized.target) : null,
        normalizeChatVisibility(normalized.visibility),
        normalizeChatDeliveryState(normalized.deliveryState),
        normalized.sourceSessionId ?? null,
        normalized.attemptId ?? null,
        normalized.laneId ?? null,
        normalized.runId ?? null,
        normalized.metadata ? JSON.stringify(normalized.metadata) : null,
        createdAt
      ]
    );
    const unreadIncrement = normalized.role === "user" ? 0 : 1;
    ctx.db.run(
      `
        update orchestrator_chat_threads
        set updated_at = ?,
            unread_count = case when ? > 0 then unread_count + ? else unread_count end
        where id = ?
      `,
      [normalized.timestamp, unreadIncrement, unreadIncrement, normalized.threadId ?? missionThreadId(normalized.missionId)]
    );
  }
  emitThreadEvent(ctx, {
    type: "message_appended",
    missionId: normalized.missionId,
    threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
    messageId: normalized.id,
    runId: normalized.runId ?? null,
    reason: "append_message",
    metadata: {
      role: normalized.role,
      deliveryState: normalized.deliveryState ?? null
    }
  });
  emitThreadEvent(ctx, {
    type: "thread_updated",
    missionId: normalized.missionId,
    threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
    runId: normalized.runId ?? null,
    reason: "append_message"
  });
  return normalized;
}

// ── Chat Routing (Group 2) ───────────────────────────────────────

export type ChatRoutingDeps = {
  routeMessageToWorker: (message: OrchestratorChatMessage) => void;
  routeMessageToCoordinator: (message: OrchestratorChatMessage) => void;
  replayQueuedWorkerMessages: (...args: any[]) => Promise<any>;
  sendWorkerMessageToSession: (sessionId: string, content: string) => Promise<string>;
  createContextCheckpoint: (...args: any[]) => void;
  listWorkerDigests: (...args: any[]) => any[];
};

export function listChatThreadsCtx(
  ctx: OrchestratorContext,
  threadArgs: ListOrchestratorChatThreadsArgs
): OrchestratorChatThread[] {
  ensureMissionThread(ctx, threadArgs.missionId);
  const rows = ctx.db.all<{
    id: string;
    mission_id: string;
    thread_type: string;
    title: string;
    run_id: string | null;
    step_id: string | null;
    step_key: string | null;
    attempt_id: string | null;
    session_id: string | null;
    lane_id: string | null;
    status: string;
    unread_count: number | null;
    metadata_json: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select
        id,
        mission_id,
        thread_type,
        title,
        run_id,
        step_id,
        step_key,
        attempt_id,
        session_id,
        lane_id,
        status,
        unread_count,
        metadata_json,
        created_at,
        updated_at
      from orchestrator_chat_threads
      where mission_id = ?
        and (? = 1 or status != 'closed')
      order by updated_at desc, created_at desc
    `,
    [threadArgs.missionId, threadArgs.includeClosed === true ? 1 : 0]
  );
  return rows.map((row) => parseThreadRow(row));
}

export function getThreadMessagesCtx(
  ctx: OrchestratorContext,
  threadArgs: GetOrchestratorThreadMessagesArgs
): OrchestratorChatMessage[] {
  const thread = ensureThreadForTarget(ctx, {
    missionId: threadArgs.missionId,
    threadId: threadArgs.threadId
  });
  if (!threadArgs.before) {
    ctx.db.run(
      `
        update orchestrator_chat_threads
        set unread_count = 0
        where mission_id = ?
          and id = ?
      `,
      [threadArgs.missionId, thread.id]
    );
    if (thread.unreadCount > 0) {
      emitThreadEvent(ctx, {
        type: "thread_updated",
        missionId: threadArgs.missionId,
        threadId: thread.id,
        runId: thread.runId ?? null,
        reason: "thread_read"
      });
    }
  }
  const messages = loadChatMessagesFromDb(ctx, {
    missionId: threadArgs.missionId,
    threadId: thread.id,
    limit: threadArgs.limit ?? MAX_PERSISTED_CHAT_MESSAGES,
    before: threadArgs.before ?? null
  });
  if (messages.length > 0) return messages;
  if (thread.threadType === "coordinator") {
    return (ctx.chatMessages.get(threadArgs.missionId) ?? loadChatMessagesFromMetadata(ctx, threadArgs.missionId))
      .filter((entry) => (entry.threadId ?? missionThreadId(threadArgs.missionId)) === thread.id)
      .slice(-clampLimit(threadArgs.limit, MAX_PERSISTED_CHAT_MESSAGES, 500));
  }
  return [];
}

export function sendWorkersBroadcastMessageCtx(
  ctx: OrchestratorContext,
  threadArgs: SendOrchestratorThreadMessageArgs,
  target: Extract<OrchestratorChatTarget, { kind: "workers" }>,
  deps: ChatRoutingDeps
): OrchestratorChatMessage {
  const missionThread = ensureMissionThread(ctx, threadArgs.missionId);
  const metadata = isRecord(threadArgs.metadata) ? threadArgs.metadata : null;
  const broadcastMessage = appendChatMessageCtx(ctx, {
    id: randomUUID(),
    missionId: threadArgs.missionId,
    role: "user",
    content: threadArgs.content,
    timestamp: nowIso(),
    threadId: missionThread.id,
    target,
    visibility: normalizeChatVisibility(threadArgs.visibilityMode, DEFAULT_CHAT_VISIBILITY),
    deliveryState: "delivered",
    sourceSessionId: null,
    attemptId: null,
    laneId: target.laneId ?? null,
    runId: target.runId ?? null,
    stepKey: null,
    metadata
  });

  const candidates = listChatThreadsCtx(ctx, {
    missionId: threadArgs.missionId,
    includeClosed: target.includeClosed === true
  })
    .filter((thread) => thread.threadType === "worker")
    .filter((thread) => !target.runId || thread.runId === target.runId)
    .filter((thread) => !target.laneId || thread.laneId === target.laneId)
    .sort((a, b) => {
      const left = Date.parse(a.createdAt);
      const right = Date.parse(b.createdAt);
      if (left !== right) return left - right;
      return a.id.localeCompare(b.id);
    });

  if (!candidates.length) {
    emitOrchestratorMessage(
      ctx,
      threadArgs.missionId,
      "Worker broadcast queued no deliveries because no matching worker threads are currently available.",
      null,
      {
        sourceMessageId: broadcastMessage.id,
        target
      },
      { appendChatMessage: (msg) => appendChatMessageCtx(ctx, msg) }
    );
    return broadcastMessage;
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const thread = candidates[index]!;
    const workerTarget: OrchestratorChatTarget = {
      kind: "worker",
      runId: thread.runId ?? target.runId ?? null,
      stepId: thread.stepId ?? null,
      stepKey: thread.stepKey ?? null,
      attemptId: thread.attemptId ?? null,
      sessionId: thread.sessionId ?? null,
      laneId: thread.laneId ?? target.laneId ?? null
    };
    const nextMetadata: Record<string, unknown> = {
      ...(metadata ?? {}),
      workerBroadcast: {
        sourceMessageId: broadcastMessage.id,
        fanoutIndex: index + 1,
        fanoutTotal: candidates.length
      }
    };
    sendThreadMessageCtx(ctx, {
      missionId: threadArgs.missionId,
      threadId: thread.id,
      content: threadArgs.content,
      target: workerTarget,
      visibilityMode: normalizeChatVisibility(threadArgs.visibilityMode, DEFAULT_WORKER_CHAT_VISIBILITY),
      metadata: nextMetadata
    }, deps);
  }

  emitOrchestratorMessage(
    ctx,
    threadArgs.missionId,
    `Broadcast worker guidance to ${candidates.length} worker thread${candidates.length === 1 ? "" : "s"}.`,
    null,
    {
      sourceMessageId: broadcastMessage.id,
      target,
      deliveredThreads: candidates.map((thread) => thread.id)
    },
    { appendChatMessage: (msg) => appendChatMessageCtx(ctx, msg) }
  );
  return broadcastMessage;
}

export function sendThreadMessageCtx(
  ctx: OrchestratorContext,
  threadArgs: SendOrchestratorThreadMessageArgs,
  deps: ChatRoutingDeps
): OrchestratorChatMessage {
  const target = sanitizeChatTarget(threadArgs.target);
  if (target?.kind === "workers") {
    return sendWorkersBroadcastMessageCtx(ctx, threadArgs, target, deps);
  }
  const thread = ensureThreadForTarget(ctx, {
    missionId: threadArgs.missionId,
    threadId: threadArgs.threadId ?? null,
    target
  });
  const isWorkerTarget = target?.kind === "worker";
  const isTeammateTarget = target?.kind === "teammate";
  const visibilityFallback = isWorkerTarget ? DEFAULT_WORKER_CHAT_VISIBILITY : DEFAULT_CHAT_VISIBILITY;
  const visibility = normalizeChatVisibility(threadArgs.visibilityMode, visibilityFallback);
  const deliveryState: OrchestratorChatDeliveryState =
    isWorkerTarget || isTeammateTarget ? "queued" : DEFAULT_CHAT_DELIVERY;
  const msg = appendChatMessageCtx(ctx, {
    id: randomUUID(),
    missionId: threadArgs.missionId,
    role: "user",
    content: threadArgs.content,
    timestamp: nowIso(),
    threadId: thread.id,
    target: target ?? (thread.threadType === "coordinator" ? { kind: "coordinator", runId: thread.runId ?? null } : null),
    visibility,
    deliveryState,
    sourceSessionId:
      isWorkerTarget
        ? target.sessionId ?? null
        : isTeammateTarget
          ? target.sessionId ?? null
          : null,
    attemptId: isWorkerTarget ? target.attemptId ?? null : null,
    laneId: isWorkerTarget ? target.laneId ?? null : null,
    runId: target?.runId ?? thread.runId ?? null,
    stepKey: isWorkerTarget ? target.stepKey ?? null : null,
    metadata: threadArgs.metadata ?? null
  });
  if ((ctx.chatMessages.get(threadArgs.missionId)?.length ?? 0) >= CONTEXT_CHECKPOINT_CHAT_THRESHOLD) {
    const total = ctx.chatMessages.get(threadArgs.missionId)?.length ?? 0;
    if (total % CONTEXT_CHECKPOINT_CHAT_THRESHOLD === 0) {
      deps.createContextCheckpoint({
        missionId: threadArgs.missionId,
        runId: msg.runId ?? null,
        trigger: "step_threshold",
        summary: `Compressed mission chat context at ${total} messages.`,
        source: {
          digestCount: deps.listWorkerDigests({ missionId: threadArgs.missionId, limit: 1_000 }).length,
          chatMessageCount: total,
          compressedMessageCount: Math.floor(total / 2)
        }
      });
    }
  }
  if (msg.target?.kind === "worker") {
    deps.routeMessageToWorker(msg);
    void deps.replayQueuedWorkerMessages({
      reason: "send_thread_message",
      missionId: threadArgs.missionId,
      threadId: msg.threadId ?? null,
      sessionId: msg.target.sessionId ?? null
    }).catch((error: unknown) => {
      ctx.logger.debug("ai_orchestrator.worker_delivery_replay_enqueue_failed", {
        missionId: threadArgs.missionId,
        threadId: msg.threadId ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  } else if (msg.target?.kind === "teammate") {
    const teammateSessionId = toOptionalString(msg.target.sessionId);
    if (!teammateSessionId) {
      updateChatMessage(ctx, msg.id, (current) => ({ ...current, deliveryState: "failed" }));
      return msg;
    }
    void Promise.resolve()
      .then(async () => {
        await deps.sendWorkerMessageToSession(teammateSessionId, msg.content);
        updateChatMessage(ctx, msg.id, (current) => ({ ...current, deliveryState: "delivered" }));
      })
      .catch((error: unknown) => {
        updateChatMessage(ctx, msg.id, (current) => ({ ...current, deliveryState: "failed" }));
        ctx.logger.debug("ai_orchestrator.teammate_delivery_failed", {
          missionId: threadArgs.missionId,
          threadId: msg.threadId ?? null,
          sessionId: teammateSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  } else {
    deps.routeMessageToCoordinator(msg);
  }
  return msg;
}

export function sendChatCtx(
  ctx: OrchestratorContext,
  chatArgs: SendOrchestratorChatArgs,
  deps: ChatRoutingDeps
): OrchestratorChatMessage {
  return sendThreadMessageCtx(ctx, {
    missionId: chatArgs.missionId,
    content: chatArgs.content,
    threadId: chatArgs.threadId ?? missionThreadId(chatArgs.missionId),
    target: chatArgs.target ?? { kind: "coordinator", runId: null },
    visibilityMode: chatArgs.visibilityMode ?? DEFAULT_CHAT_VISIBILITY,
    metadata: chatArgs.metadata ?? null
  }, deps);
}

export function getChatCtx(
  ctx: OrchestratorContext,
  chatArgs: GetOrchestratorChatArgs
): OrchestratorChatMessage[] {
  return getThreadMessagesCtx(ctx, {
    missionId: chatArgs.missionId,
    threadId: missionThreadId(chatArgs.missionId),
    limit: MAX_PERSISTED_CHAT_MESSAGES
  });
}

export function sendAgentMessageCtx(
  ctx: OrchestratorContext,
  args: SendAgentMessageArgs
): OrchestratorChatMessage {
  const { missionId, fromAttemptId, toAttemptId, content, metadata } = args;

  // Find or create a thread for the source agent
  const sourceThread = ensureThreadForTarget(ctx, {
    missionId,
    threadId: null,
    target: { kind: "worker", attemptId: fromAttemptId } as OrchestratorChatTarget
  });

  // Record message in source agent's thread
  const agentMsg = appendChatMessageCtx(ctx, {
    id: randomUUID(),
    missionId,
    role: "agent",
    content,
    timestamp: nowIso(),
    threadId: sourceThread.id,
    target: { kind: "agent", sourceAttemptId: fromAttemptId, targetAttemptId: toAttemptId },
    visibility: "full" as OrchestratorChatVisibilityMode,
    deliveryState: "delivered" as OrchestratorChatDeliveryState,
    sourceSessionId: null,
    attemptId: fromAttemptId,
    laneId: null,
    runId: sourceThread.runId ?? null,
    stepKey: null,
    metadata: metadata ?? null
  });

  // Also deliver to target agent's thread
  const targetThread = ensureThreadForTarget(ctx, {
    missionId,
    threadId: null,
    target: { kind: "worker", attemptId: toAttemptId } as OrchestratorChatTarget
  });

  appendChatMessageCtx(ctx, {
    id: randomUUID(),
    missionId,
    role: "agent",
    content,
    timestamp: nowIso(),
    threadId: targetThread.id,
    target: { kind: "agent", sourceAttemptId: fromAttemptId, targetAttemptId: toAttemptId },
    visibility: "full" as OrchestratorChatVisibilityMode,
    deliveryState: "delivered" as OrchestratorChatDeliveryState,
    sourceSessionId: null,
    attemptId: fromAttemptId,
    laneId: null,
    runId: targetThread.runId ?? null,
    stepKey: null,
    metadata: { ...(metadata ?? {}), interAgentDelivery: true }
  });

  // Emit thread event so UI updates
  emitThreadEvent(ctx, {
    type: "message_appended",
    missionId,
    threadId: sourceThread.id,
    messageId: agentMsg.id,
    reason: "agent_message"
  });
  emitThreadEvent(ctx, {
    type: "message_appended",
    missionId,
    threadId: targetThread.id,
    messageId: agentMsg.id,
    reason: "agent_message_delivery"
  });

  return agentMsg;
}

// ── Inter-agent messaging: route message to mentioned agents ──
export function routeMessageCtx(
  ctx: OrchestratorContext,
  message: OrchestratorChatMessage,
  mentions: string[],
  deps: { deliverMessageToAgent: (...args: any[]) => Promise<any> }
): void {
  if (!message.missionId) return;
  const missionId = message.missionId;

  // Resolve active run to find agents
  const runs = ctx.orchestratorService.listRuns({ missionId });
  const activeRun = runs.find(
    (r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused"
  );
  if (!activeRun) return;

  const isBroadcast = mentions.includes("all");

  if (isBroadcast) {
    // Deliver to all active workers
    for (const [, ws] of ctx.workerStates.entries()) {
      if (ws.runId !== activeRun.id || ws.state !== "working" || !ws.sessionId) continue;
      void deps.deliverMessageToAgent({
        missionId,
        targetAttemptId: ws.attemptId,
        content: message.content,
        priority: "normal"
      });
    }
    return;
  }

  // Deliver to each specifically mentioned agent (by step key)
  const graph = ctx.orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 0 });
  for (const mention of mentions) {
    if (mention === "orchestrator") {
      // Messages to orchestrator are already in the chat system
      continue;
    }
    const targetStep = graph.steps.find((s) => s.stepKey === mention);
    if (!targetStep) continue;
    const targetWorker = [...ctx.workerStates.entries()].find(
      ([, ws]) => ws.stepId === targetStep.id && ws.runId === activeRun.id && ws.state === "working"
    );
    if (targetWorker) {
      void deps.deliverMessageToAgent({
        missionId,
        targetAttemptId: targetWorker[1].attemptId,
        content: message.content,
        priority: "normal"
      });
    }
  }
}

// ── Inter-agent messaging: deliver message to a running agent ──
export async function deliverMessageToAgentCtx(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    targetAttemptId: string;
    content: string;
    priority?: "normal" | "urgent";
    fromAttemptId?: string | null;
  },
  deps: { sendWorkerMessageToSession: (sessionId: string, content: string) => Promise<string> }
): Promise<{ delivered: boolean; method: string }> {
  const ws = ctx.workerStates.get(args.targetAttemptId);
  if (!ws) {
    return { delivered: false, method: "not_found" };
  }

  const priority = args.priority ?? "normal";
  const prefix = args.fromAttemptId ? `[Message from ${args.fromAttemptId}] ` : "[Team message] ";
  const formattedContent = `${prefix}${args.content}`;

  // For agents with an active session (both CLI-wrapped and SDK), use the existing delivery mechanism
  if (ws.sessionId && ctx.agentChatService) {
    try {
      if (priority === "urgent") {
        // Use steer for urgent messages — injects immediately even if agent is busy
        try {
          await ctx.agentChatService.steer({ sessionId: ws.sessionId, text: formattedContent });
          return { delivered: true, method: "steer" };
        } catch {
          // Fall through to sendMessage
        }
      }
      const method = await deps.sendWorkerMessageToSession(ws.sessionId, formattedContent);
      return { delivered: true, method };
    } catch (error) {
      ctx.logger.debug("ai_orchestrator.deliver_message_to_agent_failed", {
        missionId: args.missionId,
        targetAttemptId: args.targetAttemptId,
        sessionId: ws.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { delivered: false, method: "no_active_session" };
}

// ── Global chat: all messages for a mission across all threads ──
export function getGlobalChatCtx(
  ctx: OrchestratorContext,
  args: GetGlobalChatArgs
): OrchestratorChatMessage[] {
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
  return loadChatMessagesFromDb(ctx, {
    missionId: args.missionId,
    threadId: null, // null = all threads
    limit,
    before: args.since ? null : null // since is used as a floor, not a ceiling
  }).filter((msg) => {
    if (!args.since) return true;
    return Date.parse(msg.timestamp) >= Date.parse(args.since);
  });
}

// ── Active agents: list for @mention autocomplete ──
export function getActiveAgentsCtx(
  ctx: OrchestratorContext,
  args: GetActiveAgentsArgs
): ActiveAgentInfo[] {
  const result: ActiveAgentInfo[] = [];
  // Find active run for the mission
  const runs = ctx.orchestratorService.listRuns({ missionId: args.missionId });
  const activeRun = runs.find(
    (r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused"
  );
  if (!activeRun) return result;

  let graph: OrchestratorRunGraph | null = null;
  try {
    graph = ctx.orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 0 });
  } catch {
    return result;
  }

  for (const [, ws] of ctx.workerStates.entries()) {
    if (ws.runId !== activeRun.id) continue;
    if (ws.state !== "working" && ws.state !== "waiting_input" && ws.state !== "idle") continue;
    const step = graph.steps.find((s) => s.id === ws.stepId);
    result.push({
      attemptId: ws.attemptId,
      stepId: ws.stepId,
      stepKey: step?.stepKey ?? null,
      runId: ws.runId,
      sessionId: ws.sessionId,
      state: ws.state,
      executorKind: ws.executorKind
    });
  }
  return result;
}

// ── Wire @mention parsing into sendAgentMessage flow ──
export function sendAgentMessageWithMentionsCtx(
  ctx: OrchestratorContext,
  agentMsgArgs: SendAgentMessageArgs,
  deps: { deliverMessageToAgent: (...args: any[]) => Promise<any> }
): OrchestratorChatMessage {
  const msg = sendAgentMessageCtx(ctx, agentMsgArgs);
  const { mentions } = parseMentions(agentMsgArgs.content);
  if (mentions.length > 0) {
    routeMessageCtx(ctx, msg, mentions, deps);
  }
  return msg;
}

// ── Reconciliation (Group 4) ─────────────────────────────────────

export type ReconciliationDeps = {
  resolveWorkerDeliveryContext: (message: OrchestratorChatMessage) => any | null;
  persistThreadWorkerLinks: (context: any) => void;
  replayQueuedWorkerMessages: (...args: any[]) => Promise<any>;
};

export function reconcileMissingThreadRowsCtx(
  ctx: OrchestratorContext,
  missionId: string
): number {
  const orphans = ctx.db.all<{
    thread_id: string;
    target_json: string | null;
  }>(
    `
      select distinct
        m.thread_id as thread_id,
        m.target_json as target_json
      from orchestrator_chat_messages m
      left join orchestrator_chat_threads t on t.id = m.thread_id
      where m.mission_id = ?
        and t.id is null
    `,
    [missionId]
  );
  let repaired = 0;
  for (const orphan of orphans) {
    const threadId = toOptionalString(orphan.thread_id);
    if (!threadId) continue;
    ensureThreadForTarget(ctx, {
      missionId,
      threadId,
      target: parseChatTarget(parseJsonRecord(orphan.target_json))
    });
    repaired += 1;
  }
  return repaired;
}

export function reconcileWorkerThreadLinksCtx(
  ctx: OrchestratorContext,
  missionId: string,
  deps: ReconciliationDeps
): number {
  const rows = ctx.db.all<{
    id: string;
    run_id: string | null;
    step_id: string | null;
    step_key: string | null;
    attempt_id: string | null;
    session_id: string | null;
    lane_id: string | null;
  }>(
    `
      select
        id,
        run_id,
        step_id,
        step_key,
        attempt_id,
        session_id,
        lane_id
      from orchestrator_chat_threads
      where mission_id = ?
        and thread_type = 'worker'
    `,
    [missionId]
  );
  let repaired = 0;
  for (const row of rows) {
    const latestMessage = loadChatMessagesFromDb(ctx, {
      missionId,
      threadId: row.id,
      limit: 1
    })[0] ?? null;
    const synthetic: OrchestratorChatMessage = latestMessage ?? {
      id: `reconcile:${row.id}`,
      missionId,
      role: "orchestrator",
      content: "Thread link reconciliation",
      timestamp: nowIso(),
      threadId: row.id,
      target: {
        kind: "worker",
        runId: row.run_id ?? null,
        stepId: row.step_id ?? null,
        stepKey: row.step_key ?? null,
        attemptId: row.attempt_id ?? null,
        sessionId: row.session_id ?? null,
        laneId: row.lane_id ?? null
      },
      visibility: "metadata_only",
      deliveryState: "queued",
      sourceSessionId: row.session_id ?? null,
      attemptId: row.attempt_id ?? null,
      laneId: row.lane_id ?? null,
      runId: row.run_id ?? null,
      stepKey: row.step_key ?? null,
      metadata: null
    };
    const context = deps.resolveWorkerDeliveryContext(synthetic);
    if (!context) continue;
    deps.persistThreadWorkerLinks(context);
    repaired += 1;
  }
  return repaired;
}

export function reconcileUnreadSanityCtx(
  ctx: OrchestratorContext,
  missionId: string
): number {
  const threads = ctx.db.all<{ id: string; unread_count: number | null }>(
    `
      select id, unread_count
      from orchestrator_chat_threads
      where mission_id = ?
    `,
    [missionId]
  );
  let updated = 0;
  for (const thread of threads) {
    const totalNonUser = ctx.db.get<{ count: number }>(
      `
        select count(1) as count
        from orchestrator_chat_messages
        where thread_id = ?
          and role != 'user'
      `,
      [thread.id]
    );
    const total = Math.max(0, Math.floor(Number(totalNonUser?.count) || 0));
    const current = Number.isFinite(Number(thread.unread_count))
      ? Math.floor(Number(thread.unread_count))
      : total;
    const normalized = Math.min(total, Math.max(0, current));
    if (normalized === current) continue;
    ctx.db.run(
      `
        update orchestrator_chat_threads
        set unread_count = ?
        where mission_id = ?
          and id = ?
      `,
      [normalized, missionId, thread.id]
    );
    updated += 1;
  }
  return updated;
}

export async function reconcileThreadedMessagingStateCtx(
  ctx: OrchestratorContext,
  deps: ReconciliationDeps
): Promise<void> {
  if (ctx.disposed.current) return;
  const missions = ctx.db.all<{ id: string }>(
    `
      select id
      from missions
      order by created_at asc
    `
  );
  let missingThreadsRepaired = 0;
  let linksRepaired = 0;
  let unreadNormalized = 0;

  for (const mission of missions) {
    if (ctx.disposed.current) return;
    const missionId = toOptionalString(mission.id);
    if (!missionId) continue;
    ensureMissionThread(ctx, missionId);
    missingThreadsRepaired += reconcileMissingThreadRowsCtx(ctx, missionId);
    linksRepaired += reconcileWorkerThreadLinksCtx(ctx, missionId, deps);
    unreadNormalized += reconcileUnreadSanityCtx(ctx, missionId);
  }

  if (missingThreadsRepaired > 0 || linksRepaired > 0 || unreadNormalized > 0) {
    ctx.logger.info("ai_orchestrator.chat_reconciliation_complete", {
      missions: missions.length,
      missingThreadsRepaired,
      linksRepaired,
      unreadNormalized
    });
  }

  await deps.replayQueuedWorkerMessages({
    reason: "startup"
  });
}
