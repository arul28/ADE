import type { AgentChatCliLaunchProvider, AgentChatPermissionMode, AgentChatTranscriptEntry } from "../../../shared/types/chat";
import type { ExternalSessionDetail } from "../../../shared/types/externalSessionDetail";
import { isExternalSessionProvider, type ExternalSessionProvider } from "../../../shared/types/externalSessions";
import {
  isTrackedAgentCliToolType,
  type PtyCreateArgs,
  type PtyCreateResult,
  type PtyDisposeResult,
  type PtyResumeSessionArgs,
  type PtyResumeSessionResult,
  type TerminalResumeMetadata,
  type TerminalSessionSummary,
  type TerminalToolType,
} from "../../../shared/types/sessions";
import { readAgentChatPermissionMode } from "../../../shared/types/chat";
import { clampGenericPermissionMode, sessionPermissionLevel } from "../../../shared/permissionLadder";
import { LAUNCH_PROFILE_TITLE } from "../../../shared/cliLaunch";
import { providerFromTool } from "../../utils/terminalSessionSignals";
import { lastMeaningfulTerminalLines } from "./cliChildSessions";
import type { DeletedCliSnapshot, RecordDeletedCliInput } from "./deletedChats";

/**
 * Delete, archive and Recently deleted for tracked agent CLI terminals
 * (Claude Code, Codex, OpenCode, … run in a PTY), so they behave like chats:
 *
 * - Delete stops the CLI, keeps a note in Recently deleted (`deletedChats.ts`)
 *   and removes the row. ADE's own recording of the terminal and the agent's
 *   own conversation file both stay on disk, so Reopen can bring it back.
 * - Archive stops a CLI that sits at its prompt (its conversation resumes
 *   later, like an idle chat's runtime); one mid-turn keeps running until it
 *   finishes, the same rule chat archive follows.
 * - Reopen relaunches the CLI in its lane under the same id, resuming its own
 *   conversation when ADE knows the id, else a fresh CLI that says so.
 */

type LoggerLike = { warn: (message: string, fields?: Record<string, unknown>) => void };

type SessionServiceLike = {
  get: (sessionId: string) => TerminalSessionSummary | null;
  create: (args: {
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
    goal?: string | null;
  }) => void;
  end: (args: { sessionId: string; endedAt: string; exitCode: number | null; status: TerminalSessionSummary["status"] }) => void;
  deleteSession: (sessionId: string) => boolean;
  archiveSession: (sessionId: string) => boolean;
  unarchiveSession: (sessionId: string) => boolean;
  readTranscriptTail: (transcriptPath: string, maxBytes: number) => Promise<string>;
};

type PtyServiceLike = {
  create: (args: PtyCreateArgs) => Promise<PtyCreateResult>;
  enrichSessions: (rows: TerminalSessionSummary[]) => TerminalSessionSummary[];
  dispose?: (args: { ptyId: string; sessionId?: string }) => PtyDisposeResult;
  isSessionOwnedByLivePeerRuntime?: (session: { ownerPid?: number | null; ownerProcessStartedAt?: string | null }) => boolean;
  resumeSession?: (args: PtyResumeSessionArgs) => Promise<PtyResumeSessionResult>;
  waitForResumeTargetBackfill?: (sessionId: string) => Promise<void>;
  ensureResumeTargets?: (sessionIds: string[]) => Promise<void>;
  hasLivePty?: (sessionId: string) => boolean;
  stopAndWaitForExit?: (sessionId: string, timeoutMs: number) => Promise<boolean>;
};

export type CliSessionLifecycleDeps = {
  sessionService: SessionServiceLike;
  ptyService: PtyServiceLike | null | undefined;
  /** Lane name and folder, for the Recently deleted row. */
  getLane: (laneId: string) => { name: string | null; worktreePath: string | null } | null;
  rememberCli: (input: RecordDeletedCliInput) => boolean;
  /** True while the CLI is mid-turn or another runtime holds its terminal. */
  midTurn: (sessionId: string) => boolean;
  /** The agent's own conversation file, read the way Import and Recently deleted read it. */
  loadProviderDetail?: (
    args: { provider: ExternalSessionProvider; sessionId: string },
    options: { includeAdeOwned: true },
  ) => Promise<ExternalSessionDetail>;
  /** The CLI's last provider message and terminal lines (`cliChildSessions.readCliTranscript`). */
  readCliTranscript?: (sessionId: string) => Promise<{ entries: AgentChatTranscriptEntry[] } | null>;
  logger: LoggerLike;
};

/** What a handoff or fork from an agent CLI carries into the new chat. */
export type CliHandoffContext = {
  provider: ExternalSessionProvider | null;
  /** The agent's own conversation id; set when a fork can copy it whole. */
  conversationId: string | null;
  /** The model the CLI ran, as it recorded it. */
  model: string | null;
  entries: AgentChatTranscriptEntry[];
  truncated: boolean;
  source: "provider_transcript" | "terminal_output";
};

/** How long a delete waits for the CLI's conversation id to be read off its output. */
const RESUME_TARGET_WAIT_MS = 3_000;
/** How long a move waits for a stopped CLI's process to exit (two writers on one conversation corrupt it). */
const MOVE_EXIT_WAIT_MS = 5_000;
const MOVE_EXIT_POLL_MS = 100;
const TERMINAL_TAIL_BYTES = 64_000;
/** The handoff brief's transcript window, the same size a chat handoff reads. */
const HANDOFF_ENTRY_LIMIT = 12;
const HANDOFF_MAX_CHARS = 12_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/** A tracked agent CLI terminal: delete, archive and Recently deleted treat it like a chat. */
export function isTrackedAgentCliRow(row: TerminalSessionSummary | null | undefined): boolean {
  return Boolean(row?.tracked && isTrackedAgentCliToolType(row.toolType ?? null));
}

/** The CLI's own name ("Claude Code", "Codex", …), the label its live row and the archive use. */
export function agentCliDisplayName(toolType: string | null | undefined): string | null {
  if (!isTrackedAgentCliToolType((toolType ?? null) as TerminalToolType | null)) return null;
  const provider = providerFromTool(toolType as TerminalToolType);
  if (provider) return LAUNCH_PROFILE_TITLE[provider];
  return toolType === "devin" ? LAUNCH_PROFILE_TITLE.devin : null;
}

/** Placeholder titles a terminal row starts with ("Shell"), which say nothing about the CLI in it. */
const GENERIC_TERMINAL_TITLES = new Set(["shell", "terminal", "workspace"]);

/** A CLI row's title, or the CLI's name when the title is only a terminal placeholder. */
export function agentCliRowTitle(title: string | null | undefined, toolType: string | null | undefined): string | null {
  const trimmed = typeof title === "string" ? title.trim() : "";
  const name = agentCliDisplayName(toolType);
  if (trimmed && !(name && GENERIC_TERMINAL_TITLES.has(trimmed.toLowerCase()))) return trimmed;
  return name ?? (trimmed || null);
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    work.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}


function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createCliSessionLifecycle(deps: CliSessionLifecycleDeps) {
  const { sessionService, logger } = deps;

  const peerOwned = (row: TerminalSessionSummary): boolean =>
    row.status === "running" && deps.ptyService?.isSessionOwnedByLivePeerRuntime?.(row) === true;

  const livePtyId = (row: TerminalSessionSummary): string => {
    let enriched = row;
    try {
      enriched = deps.ptyService?.enrichSessions([row])[0] ?? row;
    } catch {
      enriched = row;
    }
    const ptyId = typeof enriched.ptyId === "string" ? enriched.ptyId.trim() : "";
    return enriched.status === "running" || ptyId ? ptyId : "";
  };

  /** Stops the CLI's process when this runtime holds it. Throws when another runtime does. */
  const stopProcess = (row: TerminalSessionSummary, action: string): void => {
    if (peerOwned(row)) {
      throw new Error(`Session '${row.id}' is still owned by another ADE runtime. Stop it from that runtime before you ${action} it.`);
    }
    const ptyId = livePtyId(row);
    if (!ptyId) {
      if (row.status === "running") {
        throw new Error(`The CLI session '${row.id}' is still running but ADE can't reach its terminal. Stop it first.`);
      }
      return;
    }
    if (!deps.ptyService?.dispose) throw new Error("Terminals aren't available on this machine, so the CLI can't be stopped.");
    deps.ptyService.dispose({ ptyId, sessionId: row.id });
  };

  /**
   * The conversation id a stopped CLI left behind. Some CLIs (Codex, Droid,
   * OpenCode) only name it in their output, which ADE reads as the process
   * ends; this waits a moment for that read instead of losing the resume.
   */
  const settleResumeTarget = async (sessionId: string): Promise<TerminalSessionSummary | null> => {
    const pty = deps.ptyService;
    if (pty?.waitForResumeTargetBackfill || pty?.ensureResumeTargets) {
      await withTimeout((async () => {
        await pty.waitForResumeTargetBackfill?.(sessionId);
        const row = sessionService.get(sessionId);
        if (row && !row.resumeMetadata?.targetId) await pty.ensureResumeTargets?.([sessionId]);
      })(), RESUME_TARGET_WAIT_MS);
    }
    return sessionService.get(sessionId);
  };

  const snapshotOf = (row: TerminalSessionSummary): DeletedCliSnapshot => ({
    toolType: row.toolType ?? "shell",
    title: text(row.title),
    goal: text(row.goal),
    resumeCommand: text(row.resumeCommand),
    resumeMetadata: row.resumeMetadata ?? null,
    transcriptPath: text(row.transcriptPath),
  });

  /**
   * Deletes a tracked agent CLI: stops it, notes it in Recently deleted (when
   * `remember`, a person's delete), removes the row. `recoverable` is true when
   * Recently deleted lists it, so Undo can bring it back.
   */
  const deleteCli = async (
    row: TerminalSessionSummary,
    options: { remember: boolean },
  ): Promise<{ recoverable: boolean }> => {
    stopProcess(row, "delete");
    const settled = (await settleResumeTarget(row.id)) ?? null;
    if (!settled) return { recoverable: false };
    const stillLive = livePtyId(settled);
    if (stillLive || peerOwned(settled)) {
      throw new Error("Running terminal sessions must be closed before they can be deleted.");
    }
    const provider = settled.resumeMetadata?.provider ?? providerFromTool(settled.toolType ?? null);
    let recoverable = false;
    if (provider && isExternalSessionProvider(provider)) {
      const lane = deps.getLane(settled.laneId);
      const launch = settled.resumeMetadata?.launch ?? null;
      const targetId = settled.resumeMetadata?.provider === provider ? text(settled.resumeMetadata?.targetId) : null;
      recoverable = deps.rememberCli({
        id: settled.id,
        laneId: settled.laneId,
        laneName: lane?.name ?? settled.laneName ?? null,
        title: text(settled.goal) ?? agentCliRowTitle(settled.title, settled.toolType),
        provider,
        externalId: targetId,
        modelId: text(launch?.model),
        instanceId: text(settled.resumeMetadata?.instanceId) ?? text(launch?.instanceId),
        cwd: lane?.worktreePath ?? null,
        createdAt: settled.startedAt ?? null,
        lastActiveAt: settled.lastActivityAt ?? settled.endedAt ?? null,
        snapshot: snapshotOf(settled),
        // Spawned by a chat as its worker: that chat owns it, so it is not listed.
        hidden: !options.remember || Boolean(settled.resumeMetadata?.orchestrationParentSessionId),
      });
    }
    sessionService.deleteSession(settled.id);
    return { recoverable };
  };

  /** Archive: a CLI at its prompt stops (it resumes later); one mid-turn finishes first, like a chat. */
  const archiveCli = (row: TerminalSessionSummary): { stopped: boolean } => {
    let stopped = false;
    if (livePtyId(row) && !peerOwned(row) && !deps.midTurn(row.id)) {
      try {
        stopProcess(row, "archive");
        stopped = true;
      } catch (error) {
        // The archive the person asked for still happens; the process is left alone.
        logger.warn("agent_cli.archive_stop_failed", {
          sessionId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    sessionService.archiveSession(row.id);
    return { stopped };
  };

  /**
   * The turn an archive let finish has ended: stop the CLI now, as archiving
   * it at its prompt would have. A no-op for a CLI that is not archived.
   */
  const stopArchivedAfterTurn = (sessionId: string): void => {
    const row = sessionService.get(sessionId);
    if (!row?.archivedAt || !livePtyId(row) || peerOwned(row)) return;
    try {
      stopProcess(row, "archive");
    } catch (error) {
      logger.warn("agent_cli.archive_stop_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const unarchiveCli = (row: TerminalSessionSummary): void => {
    sessionService.unarchiveSession(row.id);
  };

  const launchProviderOf = (snapshot: DeletedCliSnapshot): AgentChatCliLaunchProvider | null => {
    const provider = snapshot.resumeMetadata?.provider ?? providerFromTool(snapshot.toolType as TerminalToolType);
    return provider ?? null;
  };

  const freshLaunch = async (args: {
    id: string;
    laneId: string;
    title: string;
    snapshot: DeletedCliSnapshot;
    /** Typed as the new CLI's first prompt (a moved CLI's brief). */
    initialPrompt?: string | null;
    spawnLineage?: PtyCreateArgs["spawnLineage"];
  }): Promise<void> => {
    const provider = launchProviderOf(args.snapshot);
    if (!provider) throw new Error("ADE doesn't know which agent this CLI ran, so it can't start it again.");
    const metadata = args.snapshot.resumeMetadata;
    const launch = metadata?.launch ?? {};
    const savedMode = readAgentChatPermissionMode(launch.permissionMode) ?? readAgentChatPermissionMode(metadata?.permissionMode) ?? "default";
    // A fresh launch takes only the generic word, but the CLI may have been
    // restricted through its own settings since (Codex's sandbox and approval
    // policy, Claude's mode). Start it no higher than what those grant.
    // A Codex CLI on its own config.toml grants what that file says, which ADE
    // cannot read as a level: it relaunches on the same file, unchanged.
    const deferredToConfig = savedMode === "config-toml" || launch.codexConfigSource === "config-toml";
    const effectiveLevel = sessionPermissionLevel({ provider: metadata?.provider ?? provider, ...launch }, "ask");
    const permissionMode = deferredToConfig
      ? savedMode
      : (clampGenericPermissionMode(savedMode, effectiveLevel) ?? savedMode) as AgentChatPermissionMode;
    const instanceId = text(metadata?.instanceId) ?? text(launch.instanceId);
    const presetId = text(metadata?.presetId) ?? text(launch.presetId);
    const credentialId = text(metadata?.credentialId) ?? text(launch.credentialId);
    const toolType = (isTrackedAgentCliToolType(args.snapshot.toolType as TerminalToolType)
      ? args.snapshot.toolType
      : null) as TerminalToolType | null;
    await deps.ptyService!.create({
      sessionId: args.id,
      allowNewSessionId: true,
      laneId: args.laneId,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      title: args.title,
      tracked: true,
      ...(toolType ? { toolType } : {}),
      ...(args.spawnLineage ? { spawnLineage: args.spawnLineage } : {}),
      runtimeCliLaunch: {
        provider,
        permissionMode,
        ...(args.initialPrompt?.trim() ? { initialPrompt: args.initialPrompt.trim() } : {}),
        ...(launch.fastMode === true && launch.fastTier === "ultrafast" ? { fastTier: "ultrafast" as const } : {}),
        ...(launch.droidPermissionMode ? { droidPermissionMode: launch.droidPermissionMode } : {}),
        ...(launch.musePermissionMode ? { musePermissionMode: launch.musePermissionMode } : {}),
        ...(text(launch.model) ? { model: text(launch.model) } : {}),
        ...(text(launch.reasoningEffort) ? { reasoningEffort: text(launch.reasoningEffort) } : {}),
        ...(typeof launch.fastMode === "boolean" ? { fastMode: launch.fastMode } : {}),
        ...(instanceId ? { instanceId } : {}),
        ...(presetId ? { presetId } : credentialId ? { credentialId } : {}),
      },
    });
  };

  /**
   * Puts a closed row under `id` and resumes the CLI's own conversation in
   * it. When the resume fails the row is removed and `fresh` starts a new CLI
   * under the same id; the reason comes back for the caller's notice.
   */
  const resumeOrStartFresh = async (args: {
    row: Omit<Parameters<typeof sessionService.create>[0], "ptyId" | "tracked" | "startedAt">;
    provider: string;
    failureEvent: string;
    fresh: () => Promise<void>;
  }): Promise<{ resumed: true } | { resumed: false; reason: string }> => {
    const now = new Date().toISOString();
    sessionService.create({ ...args.row, ptyId: null, tracked: true, startedAt: now });
    sessionService.end({ sessionId: args.row.sessionId, endedAt: now, exitCode: null, status: "disposed" });
    try {
      await deps.ptyService!.resumeSession!({ sessionId: args.row.sessionId, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
      return { resumed: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(args.failureEvent, { sessionId: args.row.sessionId, provider: args.provider, error: reason });
      sessionService.deleteSession(args.row.sessionId);
      await args.fresh();
      return { resumed: false, reason };
    }
  };

  /**
   * Recently deleted › Reopen for a CLI. Same lane with a known conversation:
   * the row comes back under its id and the CLI resumes its own conversation.
   * Otherwise (or when that resume fails) a fresh CLI starts under the same id.
   */
  const reopenCli = async (args: {
    id: string;
    laneId: string;
    sameLane: boolean;
    provider: ExternalSessionProvider;
    resumeTargetId: string | null;
    title: string | null;
    snapshot: DeletedCliSnapshot;
  }): Promise<{ sessionId: string; mode: "continue" | "fresh"; notice: string | null }> => {
    if (!deps.ptyService) throw new Error("Terminals aren't available on this machine, so the CLI can't be reopened.");
    if (sessionService.get(args.id)) throw new Error("This CLI session is already open.");
    const title = agentCliRowTitle(args.snapshot.title ?? args.title, args.snapshot.toolType) ?? args.title ?? "CLI session";
    const toolType = args.snapshot.toolType as TerminalToolType;
    if (args.resumeTargetId && deps.ptyService.resumeSession) {
      const metadata: TerminalResumeMetadata | null = args.snapshot.resumeMetadata
        ? { ...args.snapshot.resumeMetadata, targetId: args.resumeTargetId }
        : null;
      const result = await resumeOrStartFresh({
        row: {
          sessionId: args.id,
          laneId: args.laneId,
          title,
          // Empty lets the terminal pick its usual recording path for this id.
          transcriptPath: args.sameLane ? args.snapshot.transcriptPath ?? "" : "",
          toolType,
          resumeCommand: args.snapshot.resumeCommand,
          resumeMetadata: metadata,
          goal: args.snapshot.goal,
        },
        provider: args.provider,
        failureEvent: "agent_cli.reopen_resume_failed",
        fresh: () => freshLaunch({ id: args.id, laneId: args.laneId, title, snapshot: args.snapshot }),
      });
      return result.resumed
        ? { sessionId: args.id, mode: "continue", notice: null }
        : { sessionId: args.id, mode: "fresh", notice: `Started a new CLI: resuming its conversation failed (${result.reason}).` };
    }
    await freshLaunch({ id: args.id, laneId: args.laneId, title, snapshot: args.snapshot });
    return { sessionId: args.id, mode: "fresh", notice: null };
  };

  /** The last lines of a deleted CLI's own terminal recording. */
  const readTerminalTail = async (transcriptPath: string): Promise<string | null> => {
    try {
      return lastMeaningfulTerminalLines(await sessionService.readTranscriptTail(transcriptPath, TERMINAL_TAIL_BYTES), 200);
    } catch {
      return null;
    }
  };

  /**
   * The context a handoff or fork from a CLI carries: the agent's own
   * conversation file when ADE knows its id and can read it, else the CLI's
   * last message and terminal lines.
   */
  const handoffContext = async (row: TerminalSessionSummary): Promise<CliHandoffContext> => {
    let current = row;
    if (!current.resumeMetadata?.targetId && deps.ptyService?.ensureResumeTargets) {
      await withTimeout(deps.ptyService.ensureResumeTargets([row.id]), RESUME_TARGET_WAIT_MS);
      current = sessionService.get(row.id) ?? row;
    }
    const resumeProvider = current.resumeMetadata?.provider ?? providerFromTool(current.toolType ?? null);
    const provider = resumeProvider && isExternalSessionProvider(resumeProvider) ? resumeProvider : null;
    const conversationId = provider && current.resumeMetadata?.provider === provider
      ? text(current.resumeMetadata?.targetId)
      : null;
    const model = text(current.resumeMetadata?.launch?.model);
    if (provider && conversationId && deps.loadProviderDetail) {
      try {
        const detail = await deps.loadProviderDetail({ provider, sessionId: conversationId }, { includeAdeOwned: true });
        const messages = detail.messages.filter((message) => message.text.trim().length > 0);
        if (messages.length) {
          const windowed = messages.slice(-HANDOFF_ENTRY_LIMIT);
          const entries: AgentChatTranscriptEntry[] = [];
          let remaining = HANDOFF_MAX_CHARS;
          let truncated = windowed.length < messages.length;
          // Newest first, so the latest turns survive the character budget.
          for (let index = windowed.length - 1; index >= 0 && remaining > 0; index -= 1) {
            const message = windowed[index]!;
            const body = message.text.trim();
            const clipped = body.length > remaining ? `${body.slice(0, Math.max(0, remaining - 1))}…` : body;
            if (clipped.length < body.length) truncated = true;
            remaining -= clipped.length;
            entries.unshift({
              role: message.role,
              text: clipped,
              timestamp: message.at != null ? new Date(message.at).toISOString() : (current.lastActivityAt ?? current.startedAt),
            });
          }
          if (remaining <= 0 && entries.length < windowed.length) truncated = true;
          return { provider, conversationId, model: model ?? text(detail.model), entries, truncated, source: "provider_transcript" };
        }
      } catch (error) {
        logger.warn("agent_cli.handoff_transcript_read_failed", {
          sessionId: row.id,
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const terminal = await deps.readCliTranscript?.(row.id).catch(() => null) ?? null;
    return {
      provider,
      conversationId,
      model,
      entries: terminal?.entries ?? [],
      truncated: true,
      source: "terminal_output",
    };
  };

  /**
   * A move to another machine: stops the CLI and waits for its process to
   * exit, so its conversation file is whole before it is packed. Refused
   * while another ADE runtime holds the terminal. Returns the row as it is
   * now (with the conversation id a stopped CLI names as it ends), and
   * whether this call stopped it.
   */
  const stopForMove = async (row: TerminalSessionSummary): Promise<{ row: TerminalSessionSummary; stopped: boolean }> => {
    const wasLive = Boolean(livePtyId(row));
    if (wasLive && deps.ptyService?.stopAndWaitForExit && !peerOwned(row)) {
      // The process itself must be gone, not only its terminal: it may still
      // be flushing its conversation file.
      if (!(await deps.ptyService.stopAndWaitForExit(row.id, MOVE_EXIT_WAIT_MS))) {
        throw new Error("The CLI didn't stop within 5 seconds, so its conversation can't be moved safely. Stop it, then move it again.");
      }
      const settled = (await settleResumeTarget(row.id)) ?? row;
      return { row: settled, stopped: true };
    }
    stopProcess(row, "move");
    if (wasLive) {
      const deadline = Date.now() + MOVE_EXIT_WAIT_MS;
      const stillLive = (): boolean => {
        if (deps.ptyService?.hasLivePty) return deps.ptyService.hasLivePty(row.id);
        const current = sessionService.get(row.id);
        return Boolean(current && livePtyId(current));
      };
      while (stillLive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, MOVE_EXIT_POLL_MS));
      }
      if (stillLive()) {
        throw new Error("The CLI didn't stop within 5 seconds, so its conversation can't be moved safely. Stop it, then move it again.");
      }
    }
    const settled = (await settleResumeTarget(row.id)) ?? row;
    return { row: settled, stopped: wasLive };
  };

  /**
   * A CLI that arrived from another machine, started in its lane here under
   * `id`: resumed from the conversation written for it (`resumeTargetId`),
   * else (or when that resume fails) a fresh CLI with the same launch
   * settings and `brief` as its first prompt.
   */
  const launchMovedCli = async (args: {
    id: string;
    laneId: string;
    title: string;
    toolType: TerminalToolType;
    provider: AgentChatCliLaunchProvider;
    resumeMetadata: TerminalResumeMetadata;
    resumeTargetId: string | null;
    brief: string;
    goal: string | null;
    parent: { sessionId: string; spawnKind: NonNullable<TerminalResumeMetadata["spawnKind"]> } | null;
  }): Promise<{ mode: "resume" | "fresh"; notice: string | null }> => {
    if (!deps.ptyService) throw new Error("Terminals aren't available on this machine, so the CLI can't start here.");
    const metadata: TerminalResumeMetadata = {
      ...args.resumeMetadata,
      targetId: args.resumeTargetId,
      ...(args.parent
        ? { orchestrationParentSessionId: args.parent.sessionId, spawnKind: args.parent.spawnKind }
        : {}),
    };
    const snapshot: DeletedCliSnapshot = {
      toolType: args.toolType,
      title: args.title,
      goal: args.goal,
      resumeCommand: null,
      resumeMetadata: metadata,
      transcriptPath: null,
    };
    const fresh = async (): Promise<void> => {
      await freshLaunch({
        id: args.id,
        laneId: args.laneId,
        title: args.title,
        snapshot,
        initialPrompt: args.brief,
        ...(args.parent ? { spawnLineage: { parentChatSessionId: args.parent.sessionId, spawnKind: args.parent.spawnKind } } : {}),
      });
    };
    if (args.resumeTargetId && deps.ptyService.resumeSession) {
      const result = await resumeOrStartFresh({
        row: {
          sessionId: args.id,
          laneId: args.laneId,
          title: args.title,
          transcriptPath: "",
          toolType: args.toolType,
          resumeCommand: null,
          resumeMetadata: metadata,
          goal: args.goal,
        },
        provider: args.provider,
        failureEvent: "agent_cli.moved_resume_failed",
        fresh,
      });
      return result.resumed
        ? { mode: "resume", notice: null }
        : { mode: "fresh", notice: `Started a new CLI with a brief: resuming its conversation here failed (${result.reason}).` };
    }
    await fresh();
    return { mode: "fresh", notice: null };
  };

  return { deleteCli, archiveCli, stopArchivedAfterTurn, unarchiveCli, reopenCli, readTerminalTail, handoffContext, stopForMove, launchMovedCli };
}

export type CliSessionLifecycle = ReturnType<typeof createCliSessionLifecycle>;
