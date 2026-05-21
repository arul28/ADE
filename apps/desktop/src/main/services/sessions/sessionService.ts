import fs from "node:fs";
import type { AdeDb } from "../state/kvDb";
import type {
  ClaudeSessionPointer,
  TerminalSessionDetail,
  TerminalSessionChangedEvent,
  TerminalResumeMetadata,
  TerminalResumeProvider,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType,
  UpdateSessionMetaArgs
} from "../../../shared/types";
import { stripAnsi } from "../../utils/ansiStrip";
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
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
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
  s.exit_code as exitCode,
  s.transcript_path as transcriptPath,
  s.head_sha_start as headShaStart,
  s.head_sha_end as headShaEnd,
  s.last_output_preview as lastOutputPreview,
  s.summary as summary,
  s.resume_command as resumeCommand,
  s.resume_metadata_json as resumeMetadataJson,
  s.chat_session_id as chatSessionId
`;

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
  const codexApprovalPolicy = typeof launchRecord.codexApprovalPolicy === "string" ? launchRecord.codexApprovalPolicy : null;
  const codexSandbox = typeof launchRecord.codexSandbox === "string" ? launchRecord.codexSandbox : null;
  const codexConfigSource = typeof launchRecord.codexConfigSource === "string" ? launchRecord.codexConfigSource : null;
  if (!provider || !targetKind) return null;
  return {
    provider,
    targetKind,
    targetId,
    launch: {
      ...(permissionMode ? { permissionMode } : {}),
      ...(claudePermissionMode ? { claudePermissionMode: claudePermissionMode as TerminalResumeMetadata["launch"]["claudePermissionMode"] } : {}),
      ...(codexApprovalPolicy ? { codexApprovalPolicy: codexApprovalPolicy as TerminalResumeMetadata["launch"]["codexApprovalPolicy"] } : {}),
      ...(codexSandbox ? { codexSandbox: codexSandbox as TerminalResumeMetadata["launch"]["codexSandbox"] } : {}),
      ...(codexConfigSource ? { codexConfigSource: codexConfigSource as TerminalResumeMetadata["launch"]["codexConfigSource"] } : {}),
    },
    ...(legacyTarget ? { target: legacyTarget } : {}),
    ...(permissionMode ? { permissionMode } : {}),
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

export function createSessionService({ db }: { db: AdeDb }) {
  const changeListeners = new Set<(event: TerminalSessionChangedEvent) => void>();

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
      "run-shell",
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
      runtimeState: runtimeStateFromStatus(row.status),
      resumeMetadata,
      resumeCommand: deriveResumeMetadataCommand(resumeMetadata, row.resumeCommand, toolType),
      archivedAt: row.archivedAt ?? null,
      chatSessionId: row.chatSessionId ?? null,
      ownerPid: normalizeOwnerPid(row.ownerPid),
      ownerProcessStartedAt: normalizeOwnerProcessStartedAt(row.ownerProcessStartedAt),
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

  const list =({ laneId, status, limit }: { laneId?: string; status?: TerminalSessionStatus; limit?: number } = {}) => {
    const where: string[] = [];
    const params: (string | number | null)[] = [];

    if (laneId) {
      where.push("s.lane_id = ?");
      params.push(laneId);
    }
    if (status) {
      where.push("s.status = ?");
      params.push(status);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limitSql = typeof limit === "number" ? "limit ?" : "limit 200";
    if (typeof limit === "number") params.push(limit);

    const rows = db.all<SessionRow>(
      `
        select ${SESSION_COLUMNS}
        from terminal_sessions s
        join lanes l on l.id = s.lane_id
        ${whereSql}
        order by s.started_at desc
        ${limitSql}
      `,
      params
    );

    return rows.map(mapRow) as TerminalSessionSummary[];
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
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.trunc(args.limit), 500)
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
    }: {
      endedAt?: string;
      status?: TerminalSessionStatus;
      excludeToolTypes?: string[];
      liveOwnerPids?: Set<number>;
      liveOwnerIdentities?: Array<{ pid: number; startedAt: string }>;
    } = {}): number {
      const normalizedExcludedToolTypes = Array.isArray(excludeToolTypes)
        ? excludeToolTypes
            .map((toolType) => normalizeToolType(toolType))
            .filter((toolType): toolType is TerminalToolType => toolType != null)
        : [];
      const exclusionSql = normalizedExcludedToolTypes.length
        ? ` and (tool_type is null or tool_type not in (${normalizedExcludedToolTypes.map(() => "?").join(", ")}))`
        : "";
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
      const ownerGuardSql = liveOwnerPids === undefined
        ? " and owner_pid is null"
        : ownerIdentities.length
          ? ` and (owner_pid is null or owner_process_started_at is null or not (${ownerIdentities.map(() => "(owner_pid = ? and owner_process_started_at = ?)").join(" or ")}))`
          : ownerParams.length
            ? ` and (owner_pid is null or owner_pid not in (${ownerParams.map(() => "?").join(", ")}))`
          : "";
      const whereSql = `status = 'running'${exclusionSql}${ownerGuardSql}`;
      const params = [...normalizedExcludedToolTypes, ...(ownerIdentities.length ? ownerIdentityParams : ownerParams)];
      const rows = db.all<{ id: string }>(
        `select id from terminal_sessions where ${whereSql}`,
        params,
      );
      if (!rows.length) return 0;

      const finalEndedAt = endedAt ?? new Date().toISOString();
      const finalStatus = status ?? "disposed";
      db.run(
        `update terminal_sessions set ended_at = ?, exit_code = ?, status = ?, pty_id = null where ${whereSql}`,
        [
          finalEndedAt,
          null,
          finalStatus,
          ...params,
        ],
      );
      for (const row of rows) {
        if (typeof row.id === "string" && row.id.trim().length) {
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
      db.run(
        `
          insert into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at, exit_code, transcript_path,
            head_sha_start, head_sha_end, status, last_output_preview, last_output_at, summary, tool_type, resume_command, resume_metadata_json, chat_session_id, owner_pid, owner_process_started_at
          ) values (?, ?, ?, ?, ?, ?, null, null, ?, null, null, 'running', null, null, null, ?, ?, ?, ?, ?, ?)
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

    setLastOutputPreview(sessionId: string, preview: string): void {
      db.run(
        "update terminal_sessions set last_output_preview = ?, last_output_at = ? where id = ?",
        [preview, new Date().toISOString(), sessionId]
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
      let fh: fs.promises.FileHandle | null = null;
      try {
        fh = await fs.promises.open(transcriptPath, "r");
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
