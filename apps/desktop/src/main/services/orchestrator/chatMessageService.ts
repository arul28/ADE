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
  WorkerDeliveryContext,
  WorkerDeliverySessionResolution,
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
  parseChatVisibility,
  parseChatDeliveryState,
  parseThreadType,
  sanitizeChatTarget,
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
  parseJsonArray,
  ORCHESTRATOR_CHAT_METADATA_KEY,
  ORCHESTRATOR_CHAT_SESSION_METADATA_KEY,
  MAX_PERSISTED_CHAT_MESSAGES,
  MAX_CHAT_CONTEXT_CHARS,
  MAX_CHAT_CONTEXT_MESSAGES,
  MAX_CHAT_LINE_CHARS,
  MAX_LATEST_CHAT_MESSAGE_CHARS,
  MAX_THREAD_PAGE_SIZE,
  DEFAULT_CHAT_VISIBILITY,
  DEFAULT_CHAT_DELIVERY,
  DEFAULT_WORKER_CHAT_VISIBILITY,
  DEFAULT_THREAD_STATUS,
  DEFAULT_CHAT_THREAD_TITLE,
  CONTEXT_CHECKPOINT_CHAT_THRESHOLD,
  WORKER_MESSAGE_RETRY_BUDGET,
  WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS,
  WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS,
  WORKER_MESSAGE_RETRY_INTERVENTION_COOLDOWN_MS,
  WORKER_MESSAGE_INFLIGHT_LEASE_MS,
  WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS,
  STEERING_DIRECTIVES_METADATA_KEY,
  MAX_PERSISTED_STEERING_DIRECTIVES,
  parseSteeringDirective,
  parseWorkerProviderHint,
} from "./orchestratorContext";
import type {
  SendOrchestratorChatArgs,
  GetOrchestratorChatArgs,
  ListOrchestratorChatThreadsArgs,
  GetOrchestratorThreadMessagesArgs,
  SendOrchestratorThreadMessageArgs,
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
  try {
    const row = ctx.db.get<{ mission_id: string }>(
      `select mission_id from orchestrator_runs where id = ? limit 1`,
      [runId]
    );
    return row?.mission_id ?? null;
  } catch {
    return null;
  }
}

export function getRunMetadata(ctx: OrchestratorContext, runId: string): Record<string, unknown> {
  try {
    const row = ctx.db.get<{ metadata_json: string | null }>(
      `select metadata_json from orchestrator_runs where id = ? limit 1`,
      [runId]
    );
    return row?.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    return {};
  }
}

export function updateRunMetadata(
  ctx: OrchestratorContext,
  runId: string,
  mutate: (metadata: Record<string, unknown>) => void
): boolean {
  const metadata = (() => {
    try {
      const row = ctx.db.get<{ metadata_json: string | null }>(
        `select metadata_json from orchestrator_runs where id = ? limit 1`,
        [runId]
      );
      return row?.metadata_json ? JSON.parse(row.metadata_json) : {};
    } catch {
      return {};
    }
  })();
  mutate(metadata);
  try {
    ctx.db.run(
      `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
      [JSON.stringify(metadata), nowIso(), runId]
    );
    return true;
  } catch {
    return false;
  }
}

// ── Steering Directive Helpers ───────────────────────────────────

export function loadSteeringDirectivesFromMetadata(
  ctx: OrchestratorContext,
  missionId: string
): import("./orchestratorContext").UserSteeringDirective[] {
  const metadata = getMissionMetadata(ctx, missionId);
  const raw = metadata[STEERING_DIRECTIVES_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => parseSteeringDirective(entry, missionId))
    .filter((d): d is import("./orchestratorContext").UserSteeringDirective => d !== null);
}

export function loadChatMessagesFromMetadata(
  ctx: OrchestratorContext,
  missionId: string
): OrchestratorChatMessage[] {
  const metadata = getMissionMetadata(ctx, missionId);
  const raw = metadata[ORCHESTRATOR_CHAT_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, i) => parseChatMessage(entry, missionId, i))
    .filter((msg): msg is OrchestratorChatMessage => msg !== null);
}

export function loadChatSessionStateFromMetadata(
  ctx: OrchestratorContext,
  missionId: string
): OrchestratorChatSessionState | null {
  const metadata = getMissionMetadata(ctx, missionId);
  const raw = metadata[ORCHESTRATOR_CHAT_SESSION_METADATA_KEY];
  return parseChatSessionState(raw);
}

export function persistChatSessionState(
  ctx: OrchestratorContext,
  missionId: string,
  state: OrchestratorChatSessionState
): void {
  ctx.activeChatSessions.set(missionId, state);
  updateMissionMetadata(ctx, missionId, (metadata) => {
    metadata[ORCHESTRATOR_CHAT_SESSION_METADATA_KEY] = state;
  });
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
  ctx: OrchestratorContext,
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
  const mentionPattern = /@(\w+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(content)) !== null) {
    mentions.push(match[1]);
  }
  const cleanContent = content.replace(/@\w+/g, "").trim();
  return { mentions, cleanContent };
}

// ── Worker Delivery Helpers ──────────────────────────────────────

export function normalizeDeliveryError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isBusyDeliveryError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes("busy") || lower.includes("in progress") ||
    lower.includes("rate limit") || lower.includes("too many");
}

export function isNoActiveTurnError(errorMessage: string): boolean {
  return errorMessage.toLowerCase().includes("no active turn");
}

export function computeWorkerRetryBackoffMs(retryCount: number): number {
  const base = WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS;
  const computed = base * Math.pow(2, Math.max(0, retryCount - 1));
  return Math.min(computed, WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS);
}
