import fs from "node:fs";
import type { AdeDb } from "../state/kvDb";
import type {
  ClaudeSessionPointer,
  SessionAttentionSource,
  SessionSettleSource,
  SessionSettleOverride,
  SessionWakeReason,
  TerminalSessionDetail,
  TerminalSessionChangedEvent,
  TerminalResumeMetadata,
  TerminalResumeProvider,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType,
  ListSessionsArgs,
  UpdateSessionMetaArgs,
} from "../../../shared/types";
import { normalizeSessionStatusNote } from "../../../shared/sessionStatusNote";
import {
  isTrackedAgentCliToolType,
  parseSessionSettleOverride,
  SESSION_WAKE_REASONS,
} from "../../../shared/types";
import { isWakingSessionError } from "../../../shared/sessionCanonicalState";
import { stripAnsi } from "../../utils/ansiStrip";
import { readHistoryFileSync } from "../storage/historyCompression";
import {
  buildTrackedCliResumeCommand,
  defaultResumeCommandForTool,
  normalizeResumeCommand,
  parseTrackedCliLaunchConfig,
  parseTrackedCliResumeCommand,
  providerFromTool,
  sanitizeResumeTargetId,
} from "../../utils/terminalSessionSignals";

type SessionRow = {
  id: string;
  laneId: string;
  laneName: string;
  ptyId: string | null;
  ownerPid: number | null;
  ownerProcessStartedAt: string | null;
  tracked: number;
  pinned: number;
  manuallyNamed: number;
  goal: string | null;
  toolType: string | null;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt: string | null;
  archivedAt: string | null;
  settledAt: string | null;
  statusNote: string | null;
  attentionRequestedAt: string | null;
  attentionMessage: string | null;
  attentionSource: string | null;
  lastTurnFailedAt: string | null;
  settleOverride: string | null;
  settleSource: string | null;
  snoozedUntil: string | null;
  snoozedAt: string | null;
  wokeAt: string | null;
  wokeReason: string | null;
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
  lastActivityAt: string | null;
  summary: string | null;
  resumeCommand: string | null;
  resumeMetadataJson: string | null;
  chatSessionId: string | null;
};

type ClaudeSessionRow = {
  sessionId: string;
  laneId: string;
  laneName: string;
  chatSessionId: string | null;
  title: string | null;
  tagsJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export const STALE_RUNNING_SESSION_FRESH_ACTIVITY_GRACE_MS = 2 * 60 * 1000;

const SESSION_COLUMNS = `
  s.id as id,
  s.lane_id as laneId,
  l.name as laneName,
  s.pty_id as ptyId,
  s.owner_pid as ownerPid,
  s.owner_process_started_at as ownerProcessStartedAt,
  s.tracked as tracked,
  s.pinned as pinned,
  s.manually_named as manuallyNamed,
  s.goal as goal,
  s.tool_type as toolType,
  s.title as title,
  s.status as status,
  s.started_at as startedAt,
  s.ended_at as endedAt,
  s.archived_at as archivedAt,
  s.settled_at as settledAt,
  s.status_note as statusNote,
  s.attention_requested_at as attentionRequestedAt,
  s.attention_message as attentionMessage,
  s.attention_source as attentionSource,
  s.last_turn_failed_at as lastTurnFailedAt,
  s.settle_override as settleOverride,
  s.settle_source as settleSource,
  s.snoozed_until as snoozedUntil,
  s.snoozed_at as snoozedAt,
  s.woke_at as wokeAt,
  s.woke_reason as wokeReason,
  s.exit_code as exitCode,
  s.transcript_path as transcriptPath,
  s.head_sha_start as headShaStart,
  s.head_sha_end as headShaEnd,
  s.last_output_preview as lastOutputPreview,
  s.last_output_at as lastActivityAt,
  s.summary as summary,
  s.resume_command as resumeCommand,
  s.resume_metadata_json as resumeMetadataJson,
  s.chat_session_id as chatSessionId
`;

export const CLAUDE_SESSION_POINTER_MAX_LIMIT = 5000;

const CLAUDE_SESSION_COLUMNS = `
  c.session_id as sessionId,
  c.lane_id as laneId,
  l.name as laneName,
  c.chat_session_id as chatSessionId,
  c.title as title,
  c.tags_json as tagsJson,
  c.created_at as createdAt,
  c.updated_at as updatedAt
`;

function isResumeProvider(value: unknown): value is TerminalResumeProvider {
  return value === "claude" || value === "codex" || value === "cursor" || value === "droid" || value === "opencode";
}

function normalizeAttentionSource(value: unknown): SessionAttentionSource | null {
  return value === "agent_explicit" || value === "provider_structured" || value === "user"
    ? value
    : null;
}

function normalizeSettleSource(value: unknown): SessionSettleSource | null {
  return value === "agent_explicit" || value === "user" || value === "pr_merge" || value === "operator"
    ? value
    : null;
}

function normalizeResumeMetadata(raw: unknown): TerminalResumeMetadata | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const provider = isResumeProvider(record.provider) ? record.provider : null;
  const targetKind = record.targetKind === "session" || record.targetKind === "thread" ? record.targetKind : null;
  const legacyTarget = typeof record.target === "string" ? record.target.trim() : "";
  const rawTargetId = typeof record.targetId === "string" ? record.targetId.trim() : legacyTarget;
  const targetId = sanitizeResumeTargetId(rawTargetId);
  const launchRecord = record.launch != null && typeof record.launch === "object" && !Array.isArray(record.launch)
    ? (record.launch as Record<string, unknown>)
    : {};
  type LaunchPermissionMode = TerminalResumeMetadata["launch"]["permissionMode"];
  let permissionMode: LaunchPermissionMode | null = null;
  if (typeof launchRecord.permissionMode === "string") {
    permissionMode = launchRecord.permissionMode as LaunchPermissionMode;
  } else if (typeof record.permissionMode === "string") {
    permissionMode = record.permissionMode as LaunchPermissionMode;
  }
  const claudePermissionMode = typeof launchRecord.claudePermissionMode === "string" ? launchRecord.claudePermissionMode : null;
  const model = typeof launchRecord.model === "string" && launchRecord.model.trim().length
    ? launchRecord.model.trim()
    : null;
  const reasoningEffort = typeof launchRecord.reasoningEffort === "string" && launchRecord.reasoningEffort.trim().length
    ? launchRecord.reasoningEffort.trim()
    : null;
  const fastMode = typeof launchRecord.fastMode === "boolean"
    ? launchRecord.fastMode
    : typeof launchRecord.codexFastMode === "boolean"
      ? launchRecord.codexFastMode
      : null;
  const codexApprovalPolicy = launchRecord.codexApprovalPolicy === "untrusted"
    || launchRecord.codexApprovalPolicy === "on-request"
    || launchRecord.codexApprovalPolicy === "on-failure"
    || launchRecord.codexApprovalPolicy === "never"
    ? launchRecord.codexApprovalPolicy
    : null;
  const codexSandbox = launchRecord.codexSandbox === "read-only"
    || launchRecord.codexSandbox === "workspace-write"
    || launchRecord.codexSandbox === "danger-full-access"
    ? launchRecord.codexSandbox
    : null;
  const codexConfigSource = launchRecord.codexConfigSource === "flags" || launchRecord.codexConfigSource === "config-toml"
    ? launchRecord.codexConfigSource
    : null;
  const importedFromRecord = record.importedFrom != null && typeof record.importedFrom === "object" && !Array.isArray(record.importedFrom)
    ? record.importedFrom as Record<string, unknown>
    : null;
  const importedFromProvider = isResumeProvider(importedFromRecord?.provider)
    ? importedFromRecord.provider
    : null;
  const importedFromTargetId = sanitizeResumeTargetId(
    typeof importedFromRecord?.targetId === "string" ? importedFromRecord.targetId : null,
  );
  const importedFromMode = importedFromRecord?.mode === "fork" ? "fork" : importedFromRecord?.mode === "resume" ? "resume" : null;
  const importedFromAt = typeof importedFromRecord?.importedAt === "string" && importedFromRecord.importedAt.trim().length
    ? importedFromRecord.importedAt.trim()
    : null;
  const orchestrationParentSessionId = typeof record.orchestrationParentSessionId === "string"
    ? record.orchestrationParentSessionId.trim()
    : "";
  const spawnKind = record.spawnKind === "subagent" || record.spawnKind === "peer"
    ? record.spawnKind
    : null;
  if (!provider || !targetKind) return null;
  return {
    provider,
    targetKind,
    targetId,
    launch: {
      ...(permissionMode ? { permissionMode } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fastMode !== null ? { fastMode } : {}),
      ...(claudePermissionMode ? { claudePermissionMode: claudePermissionMode as TerminalResumeMetadata["launch"]["claudePermissionMode"] } : {}),
      ...(codexApprovalPolicy ? { codexApprovalPolicy: codexApprovalPolicy as TerminalResumeMetadata["launch"]["codexApprovalPolicy"] } : {}),
      ...(codexSandbox ? { codexSandbox: codexSandbox as TerminalResumeMetadata["launch"]["codexSandbox"] } : {}),
      ...(codexConfigSource ? { codexConfigSource: codexConfigSource as TerminalResumeMetadata["launch"]["codexConfigSource"] } : {}),
    },
    ...(importedFromProvider && importedFromTargetId && importedFromMode
      ? {
          importedFrom: {
            provider: importedFromProvider,
            targetId: importedFromTargetId,
            mode: importedFromMode,
            ...(importedFromAt ? { importedAt: importedFromAt } : {}),
          },
        }
      : {}),
    ...(legacyTarget ? { target: legacyTarget } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(orchestrationParentSessionId ? { orchestrationParentSessionId } : {}),
    ...(spawnKind ? { spawnKind } : {}),
  };
}

function serializeResumeMetadata(metadata: TerminalResumeMetadata | null | undefined): string | null {
  if (!metadata) return null;
  return JSON.stringify(metadata);
}

function deriveResumeMetadataCommand(
  metadata: TerminalResumeMetadata | null | undefined,
  legacyResumeCommand: string | null,
  toolType: TerminalToolType | null,
): string | null {
  if (metadata) {
    return buildTrackedCliResumeCommand(metadata);
  }
  return normalizeResumeCommand(legacyResumeCommand, toolType);
}

function parseLaunchMetadataFromCurrentSession(
  currentSession: TerminalSessionSummary | null,
): TerminalResumeMetadata | null {
  if (!currentSession) return null;
  const currentMetadata = currentSession.resumeMetadata ?? null;
  if (currentMetadata) return currentMetadata;

  const provider = providerFromTool(currentSession.toolType);
  if (!provider) return null;

  return {
    provider,
    targetKind: provider === "codex" ? "thread" : "session",
    targetId: null,
    launch: {},
  };
}

function normalizeClaudeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of value) {
    const tag = typeof entry === "string" ? entry.trim() : "";
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function parseClaudeTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return normalizeClaudeTags(JSON.parse(raw));
  } catch {
    return [];
  }
}

function serializeClaudeTags(tags: string[]): string | null {
  const normalized = normalizeClaudeTags(tags);
  return normalized.length ? JSON.stringify(normalized) : null;
}

function normalizeOwnerPid(ownerPid: unknown): number | null {
  if (typeof ownerPid !== "number" || !Number.isFinite(ownerPid)) return null;
  const normalized = Math.trunc(ownerPid);
  return normalized > 0 ? normalized : null;
}

function normalizeOwnerProcessStartedAt(startedAt: unknown): string | null {
  const normalized = typeof startedAt === "string" ? startedAt.trim() : "";
  return normalized.length ? normalized : null;
}

/**
 * Normalize a persisted timestamp column to a valid ISO string or null, so
 * downstream idle-age math never keys off an empty/garbage string (which would
 * otherwise show a misleading floored age instead of "no activity recorded").
 */
function normalizeIsoTimestamp(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function normalizeOptionalText(value: unknown, maxChars: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text.slice(0, maxChars) : null;
}

function normalizeSettleOverride(value: unknown): SessionSettleOverride | null {
  // undefined (unrecognized) collapses to null here — this is the persistence
  // boundary, and the throwing parsers upstream have already rejected garbage.
  return parseSessionSettleOverride(value) ?? null;
}

function normalizeWakeReason(value: unknown): SessionWakeReason | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SESSION_WAKE_REASONS as readonly string[]).includes(text)
    ? (text as SessionWakeReason)
    : null;
}

function normalizeSessionIds(sessionIds: string[]): string[] {
  return Array.from(new Set(
    (Array.isArray(sessionIds) ? sessionIds : [])
      .map((sessionId) => (typeof sessionId === "string" ? sessionId.trim() : ""))
      .filter(Boolean),
  ));
}

export function createSessionService({ db }: { db: AdeDb }) {
  const changeListeners = new Set<(event: TerminalSessionChangedEvent) => void>();

  /**
   * Shared skeleton for the single-session lifecycle mutators: trim, existence
   * probe, run the update, broadcast. Keeps every SQL literal at its call site.
   */
  const mutateSessionMeta = (sessionId: string, run: (id: string) => void): boolean => {
    const trimmed = sessionId.trim();
    if (!trimmed) return false;
    const existing = db.get<{ present: number }>(
      "select 1 as present from terminal_sessions where id = ? limit 1",
      [trimmed],
    );
    if (!existing) return false;
    run(trimmed);
    emitChanged({ sessionId: trimmed, reason: "meta-updated" });
    return true;
  };

  /**
   * Early wake (hand-raising), shared by every trigger site.
   *
   * A snoozed row wakes BEFORE its timer when a pending approval / input
   * request appears, when a session error strictly NEWER than `snoozed_at`
   * lands, or when a running turn completes. The newer-than comparison is
   * load-bearing: without it the very error the user snoozed on top of
   * re-wakes the row instantly and snooze does nothing.
   *
   * Waking clears the snooze columns and records why, so the UI can show a
   * "woke" marker with its reason until the user visits the row. Timer expiry
   * is NOT handled here — it is derived from `snoozed_until` at read time, so
   * no scheduler or watchdog exists.
   *
   * Returns the recorded reason, or null when the row was not snoozed / the
   * signal did not qualify. Does not broadcast; call sites are already inside
   * a mutation that emits.
   */
  const wakeSnoozedRow = (
    sessionId: string,
    reason: SessionWakeReason,
    opts: { errorAt?: string | null } = {},
  ): SessionWakeReason | null => {
    const row = db.get<{ snoozedUntil: string | null; snoozedAt: string | null }>(
      "select snoozed_until as snoozedUntil, snoozed_at as snoozedAt from terminal_sessions where id = ? limit 1",
      [sessionId],
    );
    const snoozedUntil = normalizeIsoTimestamp(row?.snoozedUntil);
    if (!snoozedUntil) return null;
    if (
      reason === "error"
      && !isWakingSessionError(
        { snoozedUntil, snoozedAt: normalizeIsoTimestamp(row?.snoozedAt) },
        opts.errorAt,
      )
    ) {
      return null;
    }
    db.run(
      `
        update terminal_sessions
        set snoozed_until = null,
            snoozed_at = null,
            woke_at = ?,
            woke_reason = ?
        where id = ?
      `,
      [new Date().toISOString(), reason, sessionId],
    );
    return reason;
  };

  /**
   * Did this session END in failure? The PTY-backed mirror of the canonical
   * failure tier (`canonicalSessionState` rules 3-4), minus the runtime-state
   * check the end write site cannot see:
   *   - a non-zero exit code is the process reporting it died,
   *   - status "failed" covers spawn/setup deaths that never got an exit code,
   *   - "disposed" is a user/system stop, not a failure,
   *   - exit code 0 is the SETTLED path — the process declaring it's done — and
   *     must never raise a hand.
   */
  const isFailedSessionEnd = (
    exitCode: number | null | undefined,
    status: TerminalSessionStatus,
  ): boolean => {
    if (status === "disposed") return false;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) return exitCode !== 0;
    return status === "failed";
  };

  const emitChanged = (event: TerminalSessionChangedEvent): void => {
    for (const listener of changeListeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener failures so persistence stays best-effort.
      }
    }
  };

  const runtimeStateFromStatus = (status: TerminalSessionStatus): TerminalRuntimeState => {
    if (status === "running") return "running";
    if (status === "disposed") return "killed";
    return "exited";
  };

  const normalizeToolType = (raw: unknown): TerminalToolType | null => {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!value) return null;
    const allowed: TerminalToolType[] = [
      "shell",
      "claude",
      "codex",
      "cursor-cli",
      "droid",
      "opencode",
      "claude-orchestrated",
      "codex-orchestrated",
      "opencode-orchestrated",
      "codex-chat",
      "claude-chat",
      "opencode-chat",
      "cursor",
      "droid-chat",
      "aider",
      "continue",
      "other"
    ];
    return (allowed as string[]).includes(value) ? (value as TerminalToolType) : "other";
  };

  const inferToolTypeFromResumeCommand = (
    toolType: TerminalToolType | null,
    resumeCommand: string | null,
  ): TerminalToolType | null => {
    if (toolType && toolType !== "other") return toolType;
    const normalized = String(resumeCommand ?? "").trim().toLowerCase();
    if (!normalized) return toolType;
    if (normalized.startsWith("chat:droid:")) return "droid-chat";
    if (normalized.startsWith("chat:cursor:")) return "cursor";
    if (normalized.startsWith("chat:unified:")) return "opencode-chat";
    if (normalized.startsWith("chat:claude:")) return "claude-chat";
    if (normalized === "chat:codex" || normalized.startsWith("chat:codex:")) return "codex-chat";
    return toolType;
  };

  const normalizeToolTypes = (raw: unknown): TerminalToolType[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<TerminalToolType>();
    for (const value of raw) {
      const normalized = normalizeToolType(value);
      if (normalized) seen.add(normalized);
    }
    return Array.from(seen);
  };

  const mapRow = (row: SessionRow) => {
    const toolType = inferToolTypeFromResumeCommand(
      normalizeToolType(row.toolType),
      row.resumeCommand ?? null,
    );
    let resumeMetadata: TerminalResumeMetadata | null = null;
    if (row.resumeMetadataJson) {
      try {
        resumeMetadata = normalizeResumeMetadata(JSON.parse(row.resumeMetadataJson) as unknown);
      } catch {
        resumeMetadata = null;
      }
    }
    return {
      ...row,
      tracked: row.tracked === 1,
      pinned: row.pinned === 1,
      manuallyNamed: row.manuallyNamed === 1,
      goal: row.goal ?? null,
      toolType,
      summary: row.summary ?? null,
      lastActivityAt: normalizeIsoTimestamp(row.lastActivityAt),
      runtimeState: runtimeStateFromStatus(row.status),
      resumeMetadata,
      resumeCommand: deriveResumeMetadataCommand(resumeMetadata, row.resumeCommand, toolType),
      archivedAt: row.archivedAt ?? null,
      settledAt: normalizeIsoTimestamp(row.settledAt),
      statusNote: normalizeSessionStatusNote(row.statusNote),
      attentionRequestedAt: normalizeIsoTimestamp(row.attentionRequestedAt),
      attentionMessage: normalizeOptionalText(row.attentionMessage, 500),
      attentionSource: normalizeAttentionSource(row.attentionSource),
      lastTurnFailedAt: normalizeIsoTimestamp(row.lastTurnFailedAt),
      settleOverride: normalizeSettleOverride(row.settleOverride),
      settleSource: normalizeSettleSource(row.settleSource),
      snoozedUntil: normalizeIsoTimestamp(row.snoozedUntil),
      snoozedAt: normalizeIsoTimestamp(row.snoozedAt),
      wokeAt: normalizeIsoTimestamp(row.wokeAt),
      wokeReason: normalizeWakeReason(row.wokeReason),
      chatSessionId: row.chatSessionId ?? null,
      ownerPid: normalizeOwnerPid(row.ownerPid),
      ownerProcessStartedAt: normalizeOwnerProcessStartedAt(row.ownerProcessStartedAt),
      ...(isTrackedAgentCliToolType(toolType) && resumeMetadata?.orchestrationParentSessionId
        ? { orchestrationParentSessionId: resumeMetadata.orchestrationParentSessionId }
        : {}),
      ...(isTrackedAgentCliToolType(toolType) && resumeMetadata?.spawnKind
        ? { spawnKind: resumeMetadata.spawnKind }
        : {}),
    };
  };

  const mapClaudeSessionRow = (row: ClaudeSessionRow): ClaudeSessionPointer => ({
    sessionId: row.sessionId,
    laneId: row.laneId,
    laneName: row.laneName,
    chatSessionId: row.chatSessionId ?? null,
    title: row.title ?? null,
    tags: parseClaudeTags(row.tagsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const list =({ laneId, status, limit, toolTypes }: ListSessionsArgs = {}) => {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    const effectiveLimit = limit === null ? null : typeof limit === "number" ? limit : 200;

    if (laneId) {
      where.push("s.lane_id = ?");
      params.push(laneId);
    }
    if (status) {
      where.push("s.status = ?");
      params.push(status);
    }
    const normalizedToolTypes = normalizeToolTypes(toolTypes);
    const fetchRows = (
      extraWhere: string[] = [],
      extraParams: (string | number | null)[] = [],
    ): SessionRow[] => {
      const queryWhere = [...where, ...extraWhere];
      const queryParams: (string | number | null)[] = [...params, ...extraParams];
      const whereSql = queryWhere.length ? `where ${queryWhere.join(" and ")}` : "";
      const limitSql = effectiveLimit === null ? "" : "limit ?";
      if (effectiveLimit !== null) queryParams.push(effectiveLimit);

      return db.all<SessionRow>(
        `
          select ${SESSION_COLUMNS}
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          ${whereSql}
          order by s.started_at desc
          ${limitSql}
        `,
        queryParams
      );
    };

    if (normalizedToolTypes.length > 0) {
      const legacyChatClauses: string[] = [];
      const legacyChatParams: (string | number | null)[] = [];

      for (const toolType of normalizedToolTypes) {
        if (toolType === "codex-chat") {
          legacyChatClauses.push(
            "(lower(coalesce(s.resume_command, '')) = ? or lower(coalesce(s.resume_command, '')) like ?)",
          );
          legacyChatParams.push("chat:codex", "chat:codex:%");
        } else if (toolType === "claude-chat") {
          legacyChatClauses.push("lower(coalesce(s.resume_command, '')) like ?");
          legacyChatParams.push("chat:claude:%");
        } else if (toolType === "opencode-chat") {
          legacyChatClauses.push("lower(coalesce(s.resume_command, '')) like ?");
          legacyChatParams.push("chat:unified:%");
        } else if (toolType === "cursor") {
          legacyChatClauses.push("lower(coalesce(s.resume_command, '')) like ?");
          legacyChatParams.push("chat:cursor:%");
        } else if (toolType === "droid-chat") {
          legacyChatClauses.push("lower(coalesce(s.resume_command, '')) like ?");
          legacyChatParams.push("chat:droid:%");
        }
      }

      const rowsById = new Map<string, SessionRow>();
      for (const toolType of normalizedToolTypes) {
        for (const row of fetchRows(["s.tool_type = ?"], [toolType])) {
          rowsById.set(row.id, row);
        }
      }
      if (legacyChatClauses.length > 0) {
        for (const row of fetchRows(["s.tool_type = 'other'", `(${legacyChatClauses.join(" or ")})`], legacyChatParams)) {
          rowsById.set(row.id, row);
        }
      }

      const rows = Array.from(rowsById.values())
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
      const limitedRows = effectiveLimit === null ? rows : rows.slice(0, effectiveLimit);
      return limitedRows.map(mapRow) as TerminalSessionSummary[];
    }

    const rows = fetchRows();

    return rows.map(mapRow) as TerminalSessionSummary[];
  };

  const settleMany = (
    sessionIds: string[],
    options: { outcome?: string; settledAt?: string; source?: SessionSettleSource } = {},
  ): string[] => {
    const ids = normalizeSessionIds(sessionIds);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const newlySettled = db.all<{ id: string }>(
      `
        select id from terminal_sessions
        where (settled_at is null or settle_override is not null)
          and id in (${placeholders})
      `,
      ids,
    ).map((row) => row.id);
    if (!newlySettled.length) return [];
    const updatePlaceholders = newlySettled.map(() => "?").join(", ");
    const hasOutcome = Object.prototype.hasOwnProperty.call(options, "outcome");
    db.run(
      `
        update terminal_sessions
        set settled_at = coalesce(settled_at, ?),
            settle_override = null,
            settle_source = ?,
            ${hasOutcome ? "status_note = ?," : ""}
            attention_requested_at = null,
            attention_message = null,
            attention_source = null
        where (settled_at is null or settle_override is not null)
          and id in (${updatePlaceholders})
      `,
      [
        normalizeIsoTimestamp(options.settledAt) ?? new Date().toISOString(),
        options.source ?? "user",
        ...(hasOutcome ? [normalizeSessionStatusNote(options.outcome)] : []),
        ...newlySettled,
      ],
    );
    for (const id of newlySettled) {
      emitChanged({ sessionId: id, reason: "meta-updated" });
    }
    return newlySettled;
  };

  return {
    list,

    upsertClaudeSessionPointer(args: {
      sessionId: string;
      laneId: string;
      chatSessionId?: string | null;
      title?: string | null;
      tags?: string[] | null;
      createdAt?: string;
      updatedAt?: string;
    }): ClaudeSessionPointer | null {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
      if (!sessionId || !laneId) return null;

      const existing = this.getClaudeSessionPointer(sessionId);
      const now = args.updatedAt ?? new Date().toISOString();
      const createdAt = existing?.createdAt ?? args.createdAt ?? now;
      const chatSessionId = args.chatSessionId !== undefined
        ? (typeof args.chatSessionId === "string" && args.chatSessionId.trim().length ? args.chatSessionId.trim() : null)
        : existing?.chatSessionId ?? null;
      const title = args.title !== undefined
        ? (typeof args.title === "string" && args.title.trim().length ? args.title.trim() : null)
        : existing?.title ?? null;
      const tags = args.tags !== undefined
        ? normalizeClaudeTags(args.tags ?? [])
        : existing?.tags ?? [];

      if (chatSessionId) {
        db.run(
          "update claude_sessions set chat_session_id = null, updated_at = ? where chat_session_id = ? and session_id <> ?",
          [now, chatSessionId, sessionId],
        );
      }

      db.run(
        `
          insert into claude_sessions(session_id, lane_id, chat_session_id, title, tags_json, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict(session_id) do update set
            lane_id = excluded.lane_id,
            chat_session_id = excluded.chat_session_id,
            title = excluded.title,
            tags_json = excluded.tags_json,
            updated_at = excluded.updated_at
        `,
        [sessionId, laneId, chatSessionId, title, serializeClaudeTags(tags), createdAt, now],
      );

      return this.getClaudeSessionPointer(sessionId);
    },

    getClaudeSessionPointer(sessionId: string): ClaudeSessionPointer | null {
      const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!trimmed) return null;
      const row = db.get<ClaudeSessionRow>(
        `
          select ${CLAUDE_SESSION_COLUMNS}
          from claude_sessions c
          join lanes l on l.id = c.lane_id
          where c.session_id = ?
          limit 1
        `,
        [trimmed],
      );
      return row ? mapClaudeSessionRow(row) : null;
    },

    getClaudeSessionPointerByChatSessionId(chatSessionId: string): ClaudeSessionPointer | null {
      const trimmed = typeof chatSessionId === "string" ? chatSessionId.trim() : "";
      if (!trimmed) return null;
      const row = db.get<ClaudeSessionRow>(
        `
          select ${CLAUDE_SESSION_COLUMNS}
          from claude_sessions c
          join lanes l on l.id = c.lane_id
          where c.chat_session_id = ?
          order by c.updated_at desc
          limit 1
        `,
        [trimmed],
      );
      return row ? mapClaudeSessionRow(row) : null;
    },

    listClaudeSessionPointers(args: { laneId?: string; limit?: number } = {}): ClaudeSessionPointer[] {
      const params: Array<string | number | null> = [];
      const where: string[] = [];
      const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
      if (laneId) {
        where.push("c.lane_id = ?");
        params.push(laneId);
      }
      // External-session import asks for every pointer it can get to decide
      // which Claude transcripts are already in ADE; a 500-row silent clamp made
      // older imports look un-imported without telling the caller.
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.trunc(args.limit), CLAUDE_SESSION_POINTER_MAX_LIMIT)
        : 200;
      params.push(limit);
      const rows = db.all<ClaudeSessionRow>(
        `
          select ${CLAUDE_SESSION_COLUMNS}
          from claude_sessions c
          join lanes l on l.id = c.lane_id
          ${where.length ? `where ${where.join(" and ")}` : ""}
          order by c.updated_at desc
          limit ?
        `,
        params,
      );
      return rows.map(mapClaudeSessionRow);
    },

    updateClaudeSessionPointerMeta(args: {
      sessionId: string;
      title?: string | null;
      tags?: string[] | null;
      updatedAt?: string;
    }): ClaudeSessionPointer | null {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;
      const existing = this.getClaudeSessionPointer(sessionId);
      if (!existing) return null;
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (args.title !== undefined) {
        sets.push("title = ?");
        params.push(typeof args.title === "string" && args.title.trim().length ? args.title.trim() : null);
      }
      if (args.tags !== undefined) {
        sets.push("tags_json = ?");
        params.push(serializeClaudeTags(normalizeClaudeTags(args.tags ?? [])));
      }
      if (!sets.length) return existing;
      sets.push("updated_at = ?");
      params.push(args.updatedAt ?? new Date().toISOString());
      params.push(sessionId);
      db.run(`update claude_sessions set ${sets.join(", ")} where session_id = ?`, params);
      return this.getClaudeSessionPointer(sessionId);
    },

    onChanged(listener: (event: TerminalSessionChangedEvent) => void): () => void {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },

    reconcileStaleRunningSessions({
      endedAt,
      status,
      excludeToolTypes,
      liveOwnerPids,
      liveOwnerIdentities,
      knownOwnerPids,
      knownOwnerIdentities,
      freshActivityGraceMs,
    }: {
      endedAt?: string;
      status?: TerminalSessionStatus;
      excludeToolTypes?: string[];
      liveOwnerPids?: Set<number>;
      liveOwnerIdentities?: Array<{ pid: number; startedAt: string }>;
      knownOwnerPids?: Set<number>;
      knownOwnerIdentities?: Array<{ pid: number; startedAt: string }>;
      freshActivityGraceMs?: number;
    } = {}): number {
      const normalizedExcludedToolTypes = Array.isArray(excludeToolTypes)
        ? excludeToolTypes
            .map((toolType) => normalizeToolType(toolType))
            .filter((toolType): toolType is TerminalToolType => toolType != null)
        : [];
      type SqlClause = { sql: string; params: Array<string | number> };
      const exclusionClause: SqlClause = normalizedExcludedToolTypes.length
        ? {
            sql: ` and (tool_type is null or tool_type not in (${normalizedExcludedToolTypes.map(() => "?").join(", ")}))`,
            params: normalizedExcludedToolTypes,
          }
        : { sql: "", params: [] };
      const ownerParams = liveOwnerPids
        ? Array.from(liveOwnerPids)
            .map((pid) => normalizeOwnerPid(pid))
            .filter((pid): pid is number => pid != null)
        : [];
      const ownerIdentities = liveOwnerIdentities
        ? liveOwnerIdentities
            .map((identity) => ({
              pid: normalizeOwnerPid(identity?.pid),
              startedAt: normalizeOwnerProcessStartedAt(identity?.startedAt),
            }))
            .filter((identity): identity is { pid: number; startedAt: string } => (
              identity.pid != null && identity.startedAt != null
            ))
        : [];
      const ownerIdentityParams = ownerIdentities.flatMap((identity) => [
        identity.pid,
        identity.startedAt,
      ]);
      const knownOwnerIdentityRows = knownOwnerIdentities
        ? knownOwnerIdentities
            .map((identity) => ({
              pid: normalizeOwnerPid(identity?.pid),
              startedAt: normalizeOwnerProcessStartedAt(identity?.startedAt),
            }))
            .filter((identity): identity is { pid: number; startedAt: string } => (
              identity.pid != null && identity.startedAt != null
            ))
        : [];
      const knownOwnerPidSet = new Set<number>([
        ...(knownOwnerPids
          ? Array.from(knownOwnerPids)
              .map((pid) => normalizeOwnerPid(pid))
              .filter((pid): pid is number => pid != null)
          : []),
        ...knownOwnerIdentityRows.map((identity) => identity.pid),
      ]);
      const knownOwnerParams = Array.from(knownOwnerPidSet);
      const knownOwnerIdentityParams = knownOwnerIdentityRows.flatMap((identity) => [
        identity.pid,
        identity.startedAt,
      ]);
      const ownerGuardClause = ((): SqlClause => {
        if (liveOwnerPids === undefined) return { sql: " and owner_pid is null", params: [] };
        const hasKnownOwnerScope = knownOwnerPids !== undefined || knownOwnerIdentities !== undefined;
        if (!hasKnownOwnerScope) {
          if (ownerIdentities.length) {
            return {
              sql: ` and (owner_pid is null or owner_process_started_at is null or not (${ownerIdentities.map(() => "(owner_pid = ? and owner_process_started_at = ?)").join(" or ")}))`,
              params: ownerIdentityParams,
            };
          }
          return ownerParams.length
            ? {
                sql: ` and (owner_pid is null or owner_pid not in (${ownerParams.map(() => "?").join(", ")}))`,
                params: ownerParams,
              }
            : { sql: "", params: [] };
        }

        const staleKnownClauses = ["owner_pid is null"];
        const params: Array<string | number> = [];
        if (knownOwnerIdentityRows.length) {
          const knownIdentitySql = knownOwnerIdentityRows.map(() => "(owner_pid = ? and owner_process_started_at = ?)").join(" or ");
          const liveIdentitySql = ownerIdentities.length
            ? ownerIdentities.map(() => "(owner_pid = ? and owner_process_started_at = ?)").join(" or ")
            : "0";
          staleKnownClauses.push(`(owner_process_started_at is not null and (${knownIdentitySql}) and not (${liveIdentitySql}))`);
          params.push(...knownOwnerIdentityParams, ...ownerIdentityParams);
        }
        if (knownOwnerParams.length) {
          const knownPidSql = knownOwnerParams.map(() => "?").join(", ");
          const livePidSql = ownerParams.length
            ? ` and owner_pid not in (${ownerParams.map(() => "?").join(", ")})`
            : "";
          staleKnownClauses.push(`(owner_process_started_at is null and owner_pid in (${knownPidSql})${livePidSql})`);
          params.push(...knownOwnerParams, ...ownerParams);
        }
        return { sql: ` and (${staleKnownClauses.join(" or ")})`, params };
      })();
      const graceMs = typeof freshActivityGraceMs === "number" && Number.isFinite(freshActivityGraceMs)
        ? Math.max(0, freshActivityGraceMs)
        : 0;
      const endedAtMs = endedAt ? Date.parse(endedAt) : NaN;
      const cutoffMs = (Number.isFinite(endedAtMs) ? endedAtMs : Date.now()) - graceMs;
      const activityCutoff = graceMs > 0 && Number.isFinite(cutoffMs)
        ? new Date(cutoffMs).toISOString()
        : null;
      const activityClause: SqlClause = activityCutoff
        ? {
            sql: " and started_at < ? and (last_output_at is null or last_output_at < ?)",
            params: [activityCutoff, activityCutoff],
          }
        : { sql: "", params: [] };
      const clauses = [exclusionClause, ownerGuardClause, activityClause];
      const whereSql = `status = 'running'${clauses.map((clause) => clause.sql).join("")}`;
      const params = clauses.flatMap((clause) => clause.params);
      const rows = db.all<{ id: string }>(
        `select id from terminal_sessions where ${whereSql}`,
        params,
      );
      if (!rows.length) return 0;

      const finalEndedAt = endedAt ?? new Date().toISOString();
      const finalStatus = status ?? "detached";
      db.run(
        `update terminal_sessions set ended_at = ?, exit_code = ?, status = ?, pty_id = null where ${whereSql}`,
        [
          finalEndedAt,
          null,
          finalStatus,
          ...params,
        ],
      );
      // Same hand-raise rule as the single-session `end()`: a reconcile that
      // ends rows AS FAILED wakes any snoozed row it touched (the exit code is
      // always null here, so only the status can carry the failure). The usual
      // "detached" reconcile is not a failure and wakes nothing, and a clean
      // exit never reaches this path at all.
      const reconcileFailed = isFailedSessionEnd(null, finalStatus);
      for (const row of rows) {
        if (typeof row.id === "string" && row.id.trim().length) {
          if (reconcileFailed) wakeSnoozedRow(row.id, "error", { errorAt: finalEndedAt });
          emitChanged({ sessionId: row.id, reason: "meta-updated" });
        }
      }
      return rows.length;
    },

    get(sessionId: string): TerminalSessionDetail | null {
      const row = db.get<SessionRow>(
        `
          select ${SESSION_COLUMNS}
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          where s.id = ?
          limit 1
        `,
        [sessionId]
      );
      if (!row) return null;
      return mapRow(row) as TerminalSessionDetail;
    },

    updateMeta(args: UpdateSessionMetaArgs): TerminalSessionSummary | null {
      const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;
      const currentSession = this.get(sessionId);
      const currentMetadata = currentSession?.resumeMetadata ?? null;
      const nextMetadata = args.resumeMetadata !== undefined
        ? normalizeResumeMetadata(args.resumeMetadata)
        : currentMetadata;
      let nextResumeCommand: string | null | undefined;

      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (typeof args.pinned === "boolean") {
        sets.push("pinned = ?");
        params.push(args.pinned ? 1 : 0);
      }

      if (typeof args.manuallyNamed === "boolean") {
        sets.push("manually_named = ?");
        params.push(args.manuallyNamed ? 1 : 0);
      }

      if (typeof args.laneId === "string") {
        const nextLaneId = args.laneId.trim();
        if (nextLaneId.length) {
          sets.push("lane_id = ?");
          params.push(nextLaneId);
        }
      }

      if (args.title !== undefined) {
        const nextTitle = typeof args.title === "string" ? args.title.trim() : "";
        if (nextTitle.length) {
          sets.push("title = ?");
          params.push(nextTitle);
        }
      }

      if (args.goal !== undefined) {
        sets.push("goal = ?");
        params.push(args.goal == null ? null : String(args.goal));
      }

      if (args.toolType !== undefined) {
        const normalized = normalizeToolType(args.toolType);
        sets.push("tool_type = ?");
        params.push(normalized);
      }

      if (args.resumeCommand !== undefined) {
        const preferredToolType = args.toolType !== undefined
          ? normalizeToolType(args.toolType)
          : currentSession?.toolType ?? null;
        const nextParsed = parseTrackedCliResumeCommand(args.resumeCommand, preferredToolType);
        nextResumeCommand = nextMetadata && nextMetadata.provider === nextParsed?.provider
          ? buildTrackedCliResumeCommand({
              ...nextMetadata,
              targetId: nextParsed?.targetId ?? nextMetadata.targetId,
            })
          : normalizeResumeCommand(args.resumeCommand, preferredToolType);
      }

      if (args.resumeMetadata !== undefined) {
        sets.push("resume_metadata_json = ?");
        params.push(serializeResumeMetadata(nextMetadata));
        if (nextResumeCommand === undefined) {
          nextResumeCommand = deriveResumeMetadataCommand(nextMetadata, currentSession?.resumeCommand ?? null, currentSession?.toolType ?? null);
        }
      }

      if (nextResumeCommand !== undefined) {
        sets.push("resume_command = ?");
        params.push(nextResumeCommand);
      }

      if (sets.length) {
        params.push(sessionId);
        db.run(`update terminal_sessions set ${sets.join(", ")} where id = ?`, params);
        emitChanged({ sessionId, reason: "meta-updated" });
      }

      const updated = this.get(sessionId);
      if (!updated) return null;
      if (args.resumeCommand !== undefined) return updated;

      if (args.toolType !== undefined && !updated.resumeCommand) {
        const fallback = defaultResumeCommandForTool(updated.toolType);
        if (fallback) {
          db.run("update terminal_sessions set resume_command = ? where id = ?", [fallback, sessionId]);
          const withResume = this.get(sessionId);
          return withResume ?? updated;
        }
      }
      return updated;
    },

    create({
      sessionId,
      laneId,
      ptyId,
      title,
      startedAt,
      transcriptPath,
      tracked,
      toolType,
      resumeCommand,
      resumeMetadata,
      chatSessionId,
      ownerPid,
      ownerProcessStartedAt,
      goal,
    }: {
      sessionId: string;
      laneId: string;
      ptyId: string | null;
      tracked: boolean;
      title: string;
      startedAt: string;
      transcriptPath: string;
      toolType?: TerminalToolType | null;
      resumeCommand?: string | null;
      resumeMetadata?: TerminalResumeMetadata | null;
      chatSessionId?: string | null;
      ownerPid?: number | null;
      ownerProcessStartedAt?: string | null;
      goal?: string | null;
    }): void {
      const normalizedToolType = normalizeToolType(toolType);
      const normalizedMetadata = normalizeResumeMetadata(resumeMetadata);
      const normalizedResumeCommand = normalizedMetadata
        ? buildTrackedCliResumeCommand(normalizedMetadata)
        : normalizeResumeCommand(resumeCommand, normalizedToolType) ?? defaultResumeCommandForTool(normalizedToolType);
      const normalizedChatSessionId = typeof chatSessionId === "string" && chatSessionId.trim().length
        ? chatSessionId.trim()
        : null;
      const normalizedOwnerPid = normalizeOwnerPid(ownerPid);
      const normalizedOwnerProcessStartedAt = normalizeOwnerProcessStartedAt(ownerProcessStartedAt);
      const normalizedGoal = typeof goal === "string" && goal.trim().length
        ? goal.trim()
        : null;
      db.run(
        `
          insert into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at, exit_code, transcript_path,
            head_sha_start, head_sha_end, status, last_output_preview, last_output_at, summary, tool_type, resume_command, resume_metadata_json, chat_session_id, owner_pid, owner_process_started_at, goal
          ) values (?, ?, ?, ?, ?, ?, null, null, ?, null, null, 'running', null, null, null, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          sessionId,
          laneId,
          ptyId ?? null,
          tracked ? 1 : 0,
          title,
          startedAt,
          transcriptPath,
          normalizedToolType,
          normalizedResumeCommand ?? null,
          serializeResumeMetadata(normalizedMetadata),
          normalizedChatSessionId,
          normalizedOwnerPid,
          normalizedOwnerProcessStartedAt,
          normalizedGoal,
        ]
      );
      emitChanged({ sessionId, reason: "created" });
    },

    setChatSessionId(sessionId: string, chatSessionId: string | null): void {
      const normalized = typeof chatSessionId === "string" && chatSessionId.trim().length
        ? chatSessionId.trim()
        : null;
      db.run(
        "update terminal_sessions set chat_session_id = ? where id = ?",
        [normalized, sessionId],
      );
      emitChanged({ sessionId, reason: "meta-updated" });
    },

    reopen(sessionId: string): void {
      const trimmed = sessionId.trim();
      if (!trimmed) return;
      db.run(
        `
          update terminal_sessions
          set status = 'running',
              ended_at = null,
              exit_code = null
          where id = ?
        `,
        [trimmed]
      );
      // Without this, the renderer never learns the session went from
      // stopped/ended back to running, so the Work tab keeps showing the
      // frozen ClosedCliSessionSurface even though the PTY is live and
      // streaming output that the TUI receives.
      emitChanged({ sessionId: trimmed, reason: "meta-updated" });
    },

    reattach(args: { sessionId: string; ptyId: string | null; startedAt: string; ownerPid?: number | null; ownerProcessStartedAt?: string | null }): TerminalSessionSummary | null {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;
      const ownerPid = normalizeOwnerPid(args.ownerPid);
      const ownerProcessStartedAt = normalizeOwnerProcessStartedAt(args.ownerProcessStartedAt);
      const ownerSql = args.ownerPid !== undefined || args.ownerProcessStartedAt !== undefined
        ? ",\n              owner_pid = ?,\n              owner_process_started_at = ?"
        : "";
      db.run(
        `
          update terminal_sessions
          set pty_id = ?,
              started_at = ?,
              status = 'running',
              ended_at = null,
              exit_code = null,
              summary = null,
              head_sha_end = null${ownerSql}
          where id = ?
        `,
        args.ownerPid !== undefined || args.ownerProcessStartedAt !== undefined
          ? [args.ptyId, args.startedAt, ownerPid, ownerProcessStartedAt, sessionId]
          : [args.ptyId, args.startedAt, sessionId],
      );
      // Resuming a stopped CLI session lands here (ptyService.create →
      // reattach). The renderer needs to know so it can swap the closed
      // snapshot surface for the live TerminalView pointed at the new ptyId.
      emitChanged({ sessionId, reason: "meta-updated" });
      return this.get(sessionId);
    },

    setOwnerPid(sessionId: string, ownerPid: number | null, ownerProcessStartedAt?: string | null): void {
      const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!trimmed) return;
      db.run(
        "update terminal_sessions set owner_pid = ?, owner_process_started_at = ? where id = ?",
        [normalizeOwnerPid(ownerPid), normalizeOwnerProcessStartedAt(ownerProcessStartedAt), trimmed],
      );
      emitChanged({ sessionId: trimmed, reason: "meta-updated" });
    },

    setHeadShaStart(sessionId: string, sha: string): void {
      db.run("update terminal_sessions set head_sha_start = ? where id = ?", [sha, sessionId]);
    },

    setHeadShaEnd(sessionId: string, sha: string): void {
      db.run("update terminal_sessions set head_sha_end = ? where id = ?", [sha, sessionId]);
    },

    /**
     * Callers decide whether output un-settles. Ordinary PTYs pass
     * `clearSettled: true`, while chat previews and tracked agent CLIs preserve
     * a declared settle through the agent's final output. Those agent sessions
     * are cleared explicitly at the next user turn start.
     */
    setLastOutputPreview(sessionId: string, preview: string, opts?: { clearSettled?: boolean }): void {
      db.run(
        opts?.clearSettled
          ? "update terminal_sessions set last_output_preview = ?, last_output_at = ?, settled_at = null, settle_override = null, settle_source = null where id = ?"
          : "update terminal_sessions set last_output_preview = ?, last_output_at = ? where id = ?",
        [preview, new Date().toISOString(), sessionId]
      );
    },

    /**
     * Refresh only the activity timestamp (not the preview text). Lets the PTY
     * layer record that a session is still producing output even when the
     * derived preview line is blank or unchanged (spinners, repeated status
     * lines), so the stale-session detector does not treat live work as idle.
     * PTY-only. Ordinary shell output un-settles by default; tracked agent
     * CLIs opt out because an agent's trailing output would otherwise undo a
     * settle the user just took on the row. Their next input explicitly clears
     * the markers.
     */
    touchSessionActivity(
      sessionId: string,
      at: string = new Date().toISOString(),
      opts?: { clearSettled?: boolean },
    ): void {
      db.run(
        opts?.clearSettled === false
          ? "update terminal_sessions set last_output_at = ? where id = ?"
          : "update terminal_sessions set last_output_at = ?, settled_at = null, settle_override = null, settle_source = null where id = ?",
        [at, sessionId]
      );
    },

    setSummary(sessionId: string, summary: string | null): void {
      db.run("update terminal_sessions set summary = ? where id = ?", [summary, sessionId]);
    },

    setResumeCommand(sessionId: string, resumeCommand: string | null): void {
      const currentSession = this.get(sessionId);
      const preferredToolType = currentSession?.toolType ?? null;
      const parsed = parseTrackedCliResumeCommand(resumeCommand, preferredToolType);
      const currentMetadata = currentSession?.resumeMetadata ?? null;
      const launchFromResumeCommand = typeof resumeCommand === "string"
        ? parseTrackedCliLaunchConfig(resumeCommand, preferredToolType)
        : null;
      const nextMetadata = parsed
        ? {
            ...currentMetadata,
            provider: parsed.provider,
            targetKind: parsed.provider === "codex" ? "thread" : "session",
            targetId: parsed.targetId ?? currentMetadata?.targetId ?? null,
            launch: currentMetadata?.launch
              ?? launchFromResumeCommand
              ?? parseLaunchMetadataFromCurrentSession(currentSession)?.launch
              ?? {},
          } satisfies TerminalResumeMetadata
        : currentMetadata;
      const next = nextMetadata
        ? buildTrackedCliResumeCommand(nextMetadata)
        : normalizeResumeCommand(resumeCommand, preferredToolType);
      db.run(
        "update terminal_sessions set resume_command = ?, resume_metadata_json = ? where id = ?",
        [next, serializeResumeMetadata(nextMetadata), sessionId],
      );
    },

    end({
      sessionId,
      endedAt,
      exitCode,
      status
    }: {
      sessionId: string;
      endedAt: string;
      exitCode: number | null;
      status: TerminalSessionStatus;
    }): void {
      db.run("update terminal_sessions set ended_at = ?, exit_code = ?, status = ?, pty_id = null where id = ?", [
        endedAt,
        exitCode,
        status,
        sessionId
      ]);
      // A session that DIED is a hand-raise, exactly like a failed chat turn:
      // it wakes a snoozed row early and records why, so the row carries a
      // persisted "woke · errored" marker instead of staying hidden until its
      // (possibly ~100-year "until I'm asked") deadline. Reason "error" keeps
      // the newer-than-`snoozed_at` guard, so snoozing on top of an already
      // dead session stays snoozed. A clean exit 0 does not wake because it is
      // neither a failure nor an explicit request for attention.
      if (isFailedSessionEnd(exitCode, status)) {
        const woke = wakeSnoozedRow(sessionId, "error", { errorAt: endedAt });
        if (woke) emitChanged({ sessionId, reason: "meta-updated" });
      }
    },

    archiveSession(sessionId: string, archivedAt: string = new Date().toISOString()): boolean {
      const trimmed = sessionId.trim();
      if (!trimmed) return false;
      const existing = db.get<{ present: number }>(
        "select 1 as present from terminal_sessions where id = ? limit 1",
        [trimmed],
      );
      if (!existing) return false;
      db.run("update terminal_sessions set archived_at = coalesce(archived_at, ?) where id = ?", [archivedAt, trimmed]);
      emitChanged({ sessionId: trimmed, reason: "meta-updated" });
      return true;
    },

    unarchiveSession(sessionId: string): boolean {
      const trimmed = sessionId.trim();
      if (!trimmed) return false;
      const existing = db.get<{ present: number }>(
        "select 1 as present from terminal_sessions where id = ? limit 1",
        [trimmed],
      );
      if (!existing) return false;
      db.run("update terminal_sessions set archived_at = null where id = ?", [trimmed]);
      emitChanged({ sessionId: trimmed, reason: "meta-updated" });
      return true;
    },

    settleSession(
      sessionId: string,
      opts: { outcome?: string | null; settledAt?: string; source?: SessionSettleSource } = {},
    ): boolean {
      const settledAt = normalizeIsoTimestamp(opts.settledAt) ?? new Date().toISOString();
      const outcome = normalizeSessionStatusNote(opts.outcome);
      return mutateSessionMeta(sessionId, (id) => {
        // An explicit settle also drops a stale keep-active pin — otherwise the
        // override would silently veto the settle the user just asked for.
        if (outcome) {
          db.run(
            `
              update terminal_sessions
              set settled_at = coalesce(settled_at, ?),
                  settle_override = null,
                  settle_source = ?,
                  status_note = ?,
                  attention_requested_at = null,
                  attention_message = null,
                  attention_source = null
              where id = ?
            `,
            [settledAt, opts.source ?? "user", outcome, id],
          );
        } else {
          db.run(
            `
              update terminal_sessions
              set settled_at = coalesce(settled_at, ?),
                  settle_override = null,
                  settle_source = ?,
                  attention_requested_at = null,
                  attention_message = null,
                  attention_source = null
              where id = ?
            `,
            [settledAt, opts.source ?? "user", id],
          );
        }
      });
    },

    /** Clears a declared settle plus any `'settled'` override. */
    unsettleSession(sessionId: string): boolean {
      return mutateSessionMeta(sessionId, (id) => {
        db.run(
          `
            update terminal_sessions
            set settled_at = null,
                settle_override = case when settle_override = 'settled' then null else settle_override end,
                settle_source = null
            where id = ?
          `,
          [id],
        );
      });
    },

    /** Explicit settle override, cleared with `settled_at` on real activity. */
    setSettleOverride(
      sessionId: string,
      override: SessionSettleOverride | null,
      source: SessionSettleSource = "user",
    ): boolean {
      const normalized = override == null ? null : normalizeSettleOverride(override);
      const normalizedSource = normalizeSettleSource(source) ?? "user";
      return mutateSessionMeta(sessionId, (id) => {
        db.run(
          `
            update terminal_sessions
            set settle_override = ?,
              settle_source = case
                  when ? = 'settled' then ?
                  when settled_at is null then null
                  else settle_source
                end
            where id = ?
          `,
          [normalized, normalized, normalizedSource, id],
        );
      });
    },

    setSettleOverrides(sessionIds: string[], override: SessionSettleOverride | null): string[] {
      const ids = normalizeSessionIds(sessionIds);
      if (!ids.length) return [];
      const normalized = override == null ? null : normalizeSettleOverride(override);
      const placeholders = ids.map(() => "?").join(", ");
      const present = db.all<{ id: string }>(
        `select id from terminal_sessions where id in (${placeholders})`,
        ids,
      ).map((row) => row.id);
      if (!present.length) return [];
      const updatePlaceholders = present.map(() => "?").join(", ");
      db.run(
        `
          update terminal_sessions
          set settle_override = ?,
              settle_source = case
                when ? = 'settled' then 'user'
                when settled_at is null then null
                else settle_source
              end
          where id in (${updatePlaceholders})
        `,
        [normalized, normalized, ...present],
      );
      for (const id of present) {
        emitChanged({ sessionId: id, reason: "meta-updated" });
      }
      return present;
    },

    settleSessions(sessionIds: string[]): string[] {
      return settleMany(sessionIds);
    },

    settleSessionsWithOutcome(
      sessionIds: string[],
      outcome: string,
      settledAt: string = new Date().toISOString(),
      source: SessionSettleSource = "user",
    ): string[] {
      return settleMany(sessionIds, { outcome, settledAt, source });
    },

    unsettleSessions(sessionIds: string[]): void {
      const ids = normalizeSessionIds(sessionIds);
      if (!ids.length) return;
      const placeholders = ids.map(() => "?").join(", ");
      db.run(
        `
          update terminal_sessions
          set settled_at = null,
              settle_override = case when settle_override = 'settled' then null else settle_override end,
              settle_source = null
          where id in (${placeholders})
        `,
        ids,
      );
      for (const id of ids) {
        emitChanged({ sessionId: id, reason: "meta-updated" });
      }
    },

    // -----------------------------------------------------------------------
    // Snooze — synced VISIBILITY overlay. It never touches lifecycle columns
    // and `canonicalSessionState()` never reads it; only the UI's filing does.
    // -----------------------------------------------------------------------

    /**
     * Snooze a session until `untilIso`. Stamps `snoozed_at` (the baseline the
     * early-wake error comparison needs) and clears any stale "woke" marker.
     * Returns false for a missing row or an unparseable deadline.
     */
    snoozeSession(
      sessionId: string,
      untilIso: string,
      opts: { snoozedAt?: string } = {},
    ): boolean {
      const until = normalizeIsoTimestamp(untilIso);
      if (!until) return false;
      const snoozedAt = normalizeIsoTimestamp(opts.snoozedAt) ?? new Date().toISOString();
      return mutateSessionMeta(sessionId, (id) => {
        db.run(
          `
            update terminal_sessions
            set snoozed_until = ?,
                snoozed_at = ?,
                woke_at = null,
                woke_reason = null
            where id = ?
          `,
          [until, snoozedAt, id],
        );
      });
    },

    /** Bulk snooze; mirrors `settleSessions` and returns the ids it changed. */
    snoozeSessions(sessionIds: string[], untilIso: string, opts: { snoozedAt?: string } = {}): string[] {
      const until = normalizeIsoTimestamp(untilIso);
      if (!until) return [];
      const ids = normalizeSessionIds(sessionIds);
      if (!ids.length) return [];
      const placeholders = ids.map(() => "?").join(", ");
      const present = db.all<{ id: string }>(
        `select id from terminal_sessions where id in (${placeholders})`,
        ids,
      ).map((row) => row.id);
      if (!present.length) return [];
      const snoozedAt = normalizeIsoTimestamp(opts.snoozedAt) ?? new Date().toISOString();
      const updatePlaceholders = present.map(() => "?").join(", ");
      db.run(
        `
          update terminal_sessions
          set snoozed_until = ?,
              snoozed_at = ?,
              woke_at = null,
              woke_reason = null
          where id in (${updatePlaceholders})
        `,
        [until, snoozedAt, ...present],
      );
      for (const id of present) {
        emitChanged({ sessionId: id, reason: "meta-updated" });
      }
      return present;
    },

    /**
     * Wake a snoozed session now and record why. Returns false when the row is
     * missing or was not snoozed (nothing to wake).
     */
    wakeSession(sessionId: string, reason: SessionWakeReason = "manual"): boolean {
      const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!trimmed) return false;
      const woke = wakeSnoozedRow(trimmed, normalizeWakeReason(reason) ?? "manual");
      if (!woke) return false;
      emitChanged({ sessionId: trimmed, reason: "meta-updated" });
      return true;
    },

    /** Bulk wake; mirrors `unsettleSessions`. */
    wakeSessions(sessionIds: string[], reason: SessionWakeReason = "manual"): string[] {
      const ids = normalizeSessionIds(sessionIds);
      if (!ids.length) return [];
      const normalizedReason = normalizeWakeReason(reason) ?? "manual";
      const woken: string[] = [];
      for (const id of ids) {
        if (wakeSnoozedRow(id, normalizedReason)) woken.push(id);
      }
      for (const id of woken) {
        emitChanged({ sessionId: id, reason: "meta-updated" });
      }
      return woken;
    },

    /**
     * Early-wake entry point for hand-raise signals owned by other services
     * (chat runtimes, PTY, the action registry). `reason: "error"` additionally
     * requires `errorAt` to be strictly newer than the row's `snoozed_at`;
     * everything else wakes unconditionally when the row is snoozed. Returns
     * the recorded reason, or null when the row stayed asleep.
     */
    wakeSessionIfSnoozed(
      sessionId: string,
      reason: SessionWakeReason,
      opts: { errorAt?: string | null } = {},
    ): SessionWakeReason | null {
      const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!trimmed) return null;
      const normalizedReason = normalizeWakeReason(reason);
      if (!normalizedReason) return null;
      const woke = wakeSnoozedRow(trimmed, normalizedReason, opts);
      if (woke) emitChanged({ sessionId: trimmed, reason: "meta-updated" });
      return woke;
    },

    /** Drop the "woke" marker once the user has visited the row. */
    clearWokeMarker(sessionId: string): boolean {
      return mutateSessionMeta(sessionId, (id) => {
        db.run("update terminal_sessions set woke_at = null, woke_reason = null where id = ?", [id]);
      });
    },

    setStatusNote(sessionId: string, note: string | null): boolean {
      return mutateSessionMeta(sessionId, (id) => {
        db.run(
          "update terminal_sessions set status_note = ? where id = ?",
          [normalizeSessionStatusNote(note), id],
        );
      });
    },

    /**
     * A pending approval / input request is the loudest hand-raise there is:
     * it un-settles (including any override) and it wakes a snoozed row early,
     * before its timer.
     */
    requestAttention(
      sessionId: string,
      message: string | null,
      source: SessionAttentionSource = "agent_explicit",
    ): boolean {
      return mutateSessionMeta(sessionId, (id) => {
        db.run(
          `
            update terminal_sessions
            set attention_requested_at = ?,
                attention_message = ?,
                attention_source = ?,
                settled_at = null,
                settle_override = null,
                settle_source = null
            where id = ?
          `,
          [new Date().toISOString(), normalizeOptionalText(message, 500), source, id],
        );
        wakeSnoozedRow(id, "needs_you");
      });
    },

    clearAttentionRequest(sessionId: string): boolean {
      return mutateSessionMeta(sessionId, (id) => {
        db.run(
          "update terminal_sessions set attention_requested_at = null, attention_message = null, attention_source = null where id = ?",
          [id],
        );
      });
    },

    markLastTurnFailed(sessionId: string, at?: string): boolean {
      const failedAt = normalizeIsoTimestamp(at) ?? new Date().toISOString();
      return mutateSessionMeta(sessionId, (id) => {
        // A turn failure also un-settles: the declared outcome is now in doubt
        // and the row must surface red, not hide in the quiet tier. This keeps
        // settled/failed mutually exclusive at write time, so every surface's
        // precedence order agrees by construction.
        db.run(
          "update terminal_sessions set last_turn_failed_at = ?, settled_at = null, settle_override = null, settle_source = null where id = ?",
          [failedAt, id],
        );
        // Early wake, but ONLY for an error newer than the snooze. Snoozing on
        // top of an existing failure must stay snoozed.
        wakeSnoozedRow(id, "error", { errorAt: failedAt });
      });
    },

    /**
     * A completed turn supersedes an earlier failure; never touches
     * settle/attention. It is also the "running turn completed" early-wake
     * trigger, so a snoozed row comes back as soon as its work is done.
     */
    clearLastTurnFailed(sessionId: string): boolean {
      return mutateSessionMeta(sessionId, (id) => {
        db.run("update terminal_sessions set last_turn_failed_at = null where id = ?", [id]);
        wakeSnoozedRow(id, "turn_complete");
      });
    },

    clearTurnStartMarkers(sessionId: string): boolean {
      return mutateSessionMeta(sessionId, (id) => {
        db.run(
          `
            update terminal_sessions
            set last_turn_failed_at = null,
                settled_at = null,
                settle_override = null,
                settle_source = null,
                attention_requested_at = null,
                attention_message = null,
                attention_source = null
            where id = ?
          `,
          [id],
        );
      });
    },

    deleteSession(sessionId: string): boolean {
      const trimmed = sessionId.trim();
      if (!trimmed) return false;
      const existing = db.get<{ present: number }>(
        "select 1 as present from terminal_sessions where id = ? limit 1",
        [trimmed],
      );
      if (!existing) return false;
      db.run("delete from terminal_sessions where id = ?", [trimmed]);
      emitChanged({ sessionId: trimmed, reason: "deleted" });
      return true;
    },

    async readTranscriptTail(
      transcriptPath: string,
      maxBytes: number,
      options?: { raw?: boolean; alignToLineBoundary?: boolean }
    ): Promise<string> {
      if (!transcriptPath) return "";
      const readablePath = fs.existsSync(transcriptPath)
        ? transcriptPath
        : fs.existsSync(`${transcriptPath}.gz`)
          ? `${transcriptPath}.gz`
          : transcriptPath;
      if (readablePath.endsWith(".gz")) {
        try {
          const full = readHistoryFileSync(readablePath);
          const start = Math.max(0, full.length - maxBytes);
          let slice = full.subarray(start);
          if (options?.alignToLineBoundary === true && start > 0 && slice.length > 0) {
            const nextNewline = slice.indexOf(0x0a);
            if (nextNewline >= 0 && nextNewline + 1 < slice.length) {
              slice = slice.subarray(nextNewline + 1);
            }
          }
          const text = slice.toString("utf8");
          return options?.raw ? text : stripAnsi(text);
        } catch {
          return "";
        }
      }
      let fh: fs.promises.FileHandle | null = null;
      try {
        fh = await fs.promises.open(readablePath, "r");
        const stat = await fh.stat();
        const size = stat.size;
        const start = Math.max(0, size - maxBytes);
        const out = Buffer.alloc(size - start);
        await fh.read(out, 0, out.length, start);
        const alignToLineBoundary = options?.alignToLineBoundary === true;
        let slice = out;
        if (alignToLineBoundary && start > 0 && out.length > 0) {
          const nextNewline = out.indexOf(0x0a);
          if (nextNewline >= 0 && nextNewline + 1 < out.length) {
            slice = out.subarray(nextNewline + 1);
          }
        }
        const text = slice.toString("utf8");
        return options?.raw ? text : stripAnsi(text);
      } catch {
        return "";
      } finally {
        await fh?.close().catch(() => {});
      }
    }
  };
}
