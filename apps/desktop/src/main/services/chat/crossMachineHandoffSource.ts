/**
 * The source brain's side of moving a chat to another machine, kept out of
 * agentChatService: where a move is stored, what on the source blocks one, and
 * the outbox that lets a retry finish a move instead of starting it over.
 * The orchestrator (crossMachineHandoffOrchestrator.ts) drives the steps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentChatCrossMachineArrival,
  AgentChatCrossMachineHandoffBlocker,
  AgentChatCrossMachineBatchMoveApproval,
  AgentChatCrossMachineBatchMoveRecord,
  AgentChatCrossMachineHandoffOrigin,
  AgentChatCrossMachineHandoffRecord,
  AgentChatEventEnvelope,
  AgentChatEventMetadata,
  AgentChatSpawnKind,
  LaneSummary,
} from "../../../shared/types";
import {
  decodeCrossMachineLaneImportArgs,
  isCrossMachineHandoffActive,
  normalizeGitRemoteIdentity,
  sanitizePortableGitRemote,
} from "../../../shared/crossMachineHandoff";
import { canonicalGitOriginUrl, gitRemoteIdentity } from "../github/githubSshAlias";
import type { GitRunOptions, GitRunResult } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import { writeFileAtomic } from "../state/durableFile";
import { messageClearsAttentionMarkers } from "./spawnMissionOwnership";
import { CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES } from "./crossMachineForkTransport";
import { packHandoffGitBundle, readHandoffWorkingTreeSha, validateHandoffGitBundle } from "./handoffGitBundle";
import {
  crossMachineBatchMoveApproval,
  isCrossMachineBatchSettled,
  type CrossMachineBatchChat,
  type CrossMachineBatchLane,
  type CrossMachineBatchMoveDeps,
} from "./crossMachineBatchMove";
import {
  CrossMachineSourceStaleError,
  requireMovable,
  type CrossMachineHandoffOutbox,
  type CrossMachineHandoffPersisted,
  type CrossMachineLaneOutboxEntry,
  type CrossMachinePreparedCapsule,
  type CrossMachineSourceInspection,
} from "./crossMachineHandoffOrchestrator";
import { redactGitOutput } from "../../utils/redaction";

type RunGit = (args: string[], opts: GitRunOptions) => Promise<GitRunResult>;

export type CrossMachineHandoffSourceDeps = {
  runGit: RunGit;
  laneService: { getSummary(laneId: string, options: { includeStatus?: boolean }): Promise<LaneSummary | null> };
  db: (Pick<AdeDb, "getJson" | "setJson"> & Partial<Pick<AdeDb, "all" | "run">>) | null | undefined;
  /** Machine-local folder for prepared capsules (under the project's .ade). */
  outboxDir: string;
  logger?: { warn(event: string, data?: Record<string, unknown>): void } | null;
};

const MOVE_KEY_PREFIX = "agent-chat-cross-machine-move:v1:";

/** This machine's name as moves show it, or `fallback` when the host has none. */
export function localMachineName(fallback = "source machine"): string {
  return os.hostname().trim() || fallback;
}

/** A handoff, batch or lane import id: the replay key both machines dedupe by. */
export function requireHandoffId(value: unknown): string {
  const handoffId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(handoffId)) {
    throw new Error("The handoff request has an invalid replay identifier.");
  }
  return handoffId;
}

/** `value` as a short branch name Git accepts in `cwd` (a leading `refs/heads/` is dropped). */
export async function requireGitBranch(runGit: RunGit, value: unknown, cwd: string): Promise<string> {
  const branchRef = typeof value === "string" ? value.trim().replace(/^refs\/heads\//, "") : "";
  if (!branchRef || branchRef.length > 255 || branchRef.includes("\0") || branchRef.startsWith("-")) {
    throw new Error("The handoff branch name is invalid.");
  }
  const checked = await runGit(["check-ref-format", "--branch", branchRef], { cwd, timeoutMs: 8_000 });
  if (checked.exitCode !== 0) {
    throw new Error(`The handoff branch '${branchRef}' is not a valid Git branch.`);
  }
  return branchRef;
}

/** A Git command's trimmed output; throws `failureMessage` (plus Git's words) when it fails or prints nothing. */
export async function requireGitOutput(
  runGit: RunGit,
  gitArgs: string[],
  cwd: string,
  failureMessage: string,
): Promise<string> {
  const result = await runGit(gitArgs, { cwd, timeoutMs: 15_000 });
  const output = result.stdout.trim();
  if (result.exitCode !== 0 || !output) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail ? `${failureMessage} ${detail}` : failureMessage);
  }
  return output;
}

/**
 * Whether an envelope is the arrival's own bookkeeping (its "Arrived from"
 * notice, the continuation prompt ADE sent on arrival, any imported history):
 * it is about getting here, and the original chat already has everything
 * before it. A brief arrival records no imported boundary (0), so the prompt
 * and notice are matched by the arrival's handoff id rather than by sequence.
 */
function isCrossMachineArrivalBookkeeping(
  envelope: AgentChatEventEnvelope,
  arrivalHandoffId: string,
  arrivalPromptIds: ReadonlySet<string>,
): boolean {
  const event = envelope.event;
  if (envelope.provenance?.crossMachineHandoffId === arrivalHandoffId) return true;
  if (event.type === "system_notice" && event.status === "cross_machine_handoff_arrived") {
    const detail = event.detail as Record<string, unknown> | null | undefined;
    const arrival = detail?.crossMachineHandoffArrival as Record<string, unknown> | null | undefined;
    return arrival?.handoffId === arrivalHandoffId;
  }
  if (event.type === "user_message") {
    if (event.metadata?.kind === "cross_machine_handoff" && event.metadata.crossMachineHandoffId === arrivalHandoffId) return true;
    return Boolean(event.messageId && arrivalPromptIds.has(event.messageId));
  }
  return false;
}

/** A return's transcript suffix: only what this copy wrote while away (see above). */
export function selectCrossMachineReturnSuffix(
  envelopes: AgentChatEventEnvelope[],
  suffix: { afterSequence: number; arrivalHandoffId: string },
): AgentChatEventEnvelope[] {
  // Delivery updates of the arrival prompt reuse its message id.
  const arrivalPromptIds = new Set(envelopes.flatMap((envelope) => {
    const event = envelope.event;
    return event.type === "user_message"
      && event.metadata?.kind === "cross_machine_handoff"
      && event.metadata.crossMachineHandoffId === suffix.arrivalHandoffId
      && event.messageId
      ? [event.messageId]
      : [];
  }));
  return envelopes.filter((envelope) =>
    typeof envelope.sequence === "number"
    && envelope.sequence > suffix.afterSequence
    && !isCrossMachineArrivalBookkeeping(envelope, suffix.arrivalHandoffId, arrivalPromptIds));
}

const BATCH_KEY_PREFIX = "agent-chat-cross-machine-batch:v1:";

/**
 * Whether a user_message came from the person. Host-authored deliveries (a
 * scheduled wake, a subagent's report, another agent's relay, a continuation
 * ADE wrote, a PR Watch wake, a usage-limit resume, a parent's dispatch) are
 * not new instructions, so they must not cancel a queued move.
 */
export function isPersonAuthoredUserMessage(metadata: AgentChatEventMetadata | null | undefined): boolean {
  if (!metadata) return true;
  if (metadata.usageLimitResume || metadata.spawnDispatch || metadata.orchestrationOrigin) return false;
  return messageClearsAttentionMarkers(metadata);
}

export function createCrossMachineHandoffSource(deps: CrossMachineHandoffSourceDeps) {
  const moveKey = (sessionId: string): string => `${MOVE_KEY_PREFIX}${sessionId}`;

  const readMove = (sessionId: string): CrossMachineHandoffPersisted | null => {
    const value = deps.db?.getJson<unknown>(moveKey(sessionId));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const persisted = value as Partial<CrossMachineHandoffPersisted>;
    if (!persisted.record || !persisted.request || typeof persisted.record.handoffId !== "string") return null;
    return persisted as CrossMachineHandoffPersisted;
  };

  /** Null clears the chat's move (it stores JSON null, which reads as none). */
  const writeMove = (sessionId: string, value: CrossMachineHandoffPersisted | null): void => {
    deps.db?.setJson(moveKey(sessionId), value);
  };

  const listMoves = (): Array<{ sessionId: string; value: CrossMachineHandoffPersisted }> => {
    const rows = deps.db?.all?.<{ key: string }>("select key from kv where key like ?", [`${MOVE_KEY_PREFIX}%`]) ?? [];
    const moves: Array<{ sessionId: string; value: CrossMachineHandoffPersisted }> = [];
    for (const row of rows) {
      const sessionId = row.key.slice(MOVE_KEY_PREFIX.length);
      const value = readMove(sessionId);
      if (value) moves.push({ sessionId, value });
    }
    return moves;
  };

  const batchKey = (batchId: string): string => `${BATCH_KEY_PREFIX}${batchId}`;
  const readBatch = (batchId: string): AgentChatCrossMachineBatchMoveRecord | null => {
    const value = deps.db?.getJson<unknown>(batchKey(batchId));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<AgentChatCrossMachineBatchMoveRecord>;
    if (record.batchId !== batchId || !Array.isArray(record.items)) return null;
    return record as AgentChatCrossMachineBatchMoveRecord;
  };
  /** A full scan of every batch record: the startup sweep and the index build only. */
  const listBatches = (): AgentChatCrossMachineBatchMoveRecord[] => {
    const rows = deps.db?.all?.<{ key: string }>("select key from kv where key like ?", [`${BATCH_KEY_PREFIX}%`]) ?? [];
    return rows.flatMap((row) => {
      const id = row.key.slice(BATCH_KEY_PREFIX.length);
      const value = readBatch(id);
      return value ? [value] : [];
    });
  };

  /**
   * Batches that may still run, by id: built from one scan on first use and
   * kept current by every write here (this brain is the only writer), so
   * summaries and move runs never scan the kv table.
   */
  let openBatches: Map<string, AgentChatCrossMachineBatchMoveRecord> | null = null;
  const batchIsOpen = (record: AgentChatCrossMachineBatchMoveRecord): boolean => !isCrossMachineBatchSettled(record);
  const openBatchIndex = (): Map<string, AgentChatCrossMachineBatchMoveRecord> => {
    if (!openBatches) {
      openBatches = new Map(listBatches().filter(batchIsOpen).map((record) => [record.batchId, record]));
    }
    return openBatches;
  };
  const writeBatch = (batchId: string, value: AgentChatCrossMachineBatchMoveRecord | null): void => {
    if (value === null && deps.db?.run) {
      // A pruned record leaves no row behind for later scans to read.
      deps.db.run("delete from kv where key = ?", [batchKey(batchId)]);
    } else {
      deps.db?.setJson(batchKey(batchId), value);
    }
    if (!openBatches) return;
    if (value && batchIsOpen(value)) openBatches.set(batchId, value);
    else openBatches.delete(batchId);
  };
  const listOpenBatches = (): AgentChatCrossMachineBatchMoveRecord[] => [...openBatchIndex().values()];
  /** Per requesting chat, its newest agent batch still waiting for the person. */
  const listBatchApprovals = (): Map<string, AgentChatCrossMachineBatchMoveApproval> => {
    const approvals = new Map<string, AgentChatCrossMachineBatchMoveApproval>();
    const pending = listOpenBatches()
      .filter((batch) => batch.state === "awaiting_approval" && batch.requestedBy === "agent" && batch.requestingSessionId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
    for (const batch of pending) {
      const requestingSessionId = batch.requestingSessionId;
      if (!requestingSessionId || approvals.has(requestingSessionId)) continue;
      approvals.set(requestingSessionId, crossMachineBatchMoveApproval(batch));
    }
    return approvals;
  };

  /**
   * Everything on the source lane that stops a move, as a list rather than
   * the first thrown error, so a person and an agent both see every fix at
   * once. The one canonical source check: the send path
   * (`requireCrossMachineSourceReady`) refuses on these same blockers.
   */
  const inspectLane = async (
    lane: LaneSummary,
    options: { activeMove?: AgentChatCrossMachineHandoffRecord | null } = {},
  ): Promise<CrossMachineSourceInspection> => {
    const blockers: AgentChatCrossMachineHandoffBlocker[] = [];
    const cwd = lane.worktreePath;
    const gitText = async (args: string[], timeoutMs = 15_000): Promise<string | null> => {
      const result = await deps.runGit(args, { cwd, timeoutMs });
      return result.exitCode === 0 ? result.stdout.trim() : null;
    };
    const laneFlag = `--lane ${lane.id}`;
    if (lane.status?.rebaseInProgress) {
      blockers.push({
        id: "rebasing",
        title: "A rebase is in progress",
        detail: "Finish or abort it before moving this chat.",
        clearedByIncludeChanges: false,
        fixHint: `finish the rebase in ${lane.name}`,
      });
    }
    const mergeHead = await gitText(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], 8_000);
    if (mergeHead && /^[0-9a-f]{40,64}$/i.test(mergeHead)) {
      blockers.push({
        id: "merging",
        title: "A merge is in progress",
        detail: "Finish or abort it before moving this chat.",
        clearedByIncludeChanges: false,
        fixHint: `finish or abort the merge in ${lane.name}`,
      });
    }
    // The capsule carries the canonical origin: an SSH alias of GitHub only
    // exists in this machine's ssh config, so the other machine could neither
    // match nor fetch it.
    const rawOrigin = canonicalGitOriginUrl(await gitText(["remote", "get-url", "origin"]));
    const originUrl = rawOrigin ? normalizeGitRemoteIdentity(sanitizePortableGitRemote(rawOrigin)) : null;
    if (!originUrl) {
      blockers.push({
        id: "no_origin",
        title: "This project has no origin remote",
        detail: "The other machine finds the repository by its origin.",
        clearedByIncludeChanges: false,
        fixHint: null,
      });
    }
    // The full ref, stripped here: `--short` turns a branch that shares its
    // name with a tag into `heads/<name>`, which no other machine has.
    const headRef = await gitText(["symbolic-ref", "--quiet", "HEAD"]);
    const branchRef = headRef?.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) || null : null;
    const headSha = await gitText(["rev-parse", "HEAD"]);
    const status = await deps.runGit(["status", "--porcelain=v1"], { cwd, timeoutMs: 15_000 });
    if (status.exitCode !== 0) {
      throw new Error(`ADE could not inspect the source lane. ${status.stderr.trim()}`.trim());
    }
    const changedFiles = status.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
    if (changedFiles > 0) {
      blockers.push({
        id: "dirty",
        title: `${changedFiles} uncommitted change${changedFiles === 1 ? "" : "s"}`,
        detail: "Commit them, or bring them along to the other machine.",
        clearedByIncludeChanges: true,
        fixHint: `commit in ${lane.name}, or pass --include-changes`,
      });
    }
    // Only origin counts: the other machine fetches from origin.
    const unpushedText = await gitText(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
    const unpushedCommits = unpushedText ? Number.parseInt(unpushedText, 10) || 0 : 0;
    const upstreamSha = await gitText(["rev-parse", "@{upstream}"]);
    const upstream = upstreamSha
      ? (await gitText(["rev-parse", "--abbrev-ref", "@{upstream}"])) || "its upstream"
      : null;
    if (!upstream) {
      // Bringing changes along carries commits and edits. A clean branch whose
      // commits are all on origin already has nothing to carry, so only
      // publishing gives the other machine the branch.
      const somethingToCarry = unpushedCommits > 0 || changedFiles > 0;
      blockers.push({
        id: "no_upstream",
        title: `${branchRef ?? "This branch"} hasn't been published`,
        detail: somethingToCarry
          ? "The other machine fetches the branch from origin."
          : "The other machine fetches the branch from origin. It has no new commits to bring along, so publish it.",
        clearedByIncludeChanges: somethingToCarry,
        fixHint: somethingToCarry
          ? `run \`ade git push ${laneFlag}\`, or pass --include-changes`
          : `run \`ade git push ${laneFlag}\``,
      });
    } else {
      const counts = await gitText(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
      const [behind = 0, ahead = 0] = (counts ?? "0 0").split(/\s+/).map((part) => Number.parseInt(part, 10) || 0);
      if (behind > 0 && ahead > 0) {
        blockers.push({
          id: "diverged",
          title: `${branchRef ?? "This branch"} has diverged from ${upstream}`,
          detail: "Reconcile it (rebase or merge) yourself; ADE won't pick a strategy.",
          clearedByIncludeChanges: false,
          fixHint: null,
        });
      } else if (behind > 0) {
        blockers.push({
          id: "behind",
          title: `${branchRef ?? "This branch"} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream}`,
          detail: "Update it so both machines start from the same commit.",
          clearedByIncludeChanges: false,
          fixHint: `run \`ade git pull ${laneFlag}\``,
        });
      } else if (ahead > 0) {
        blockers.push({
          id: "unpushed",
          title: `${ahead} unpushed commit${ahead === 1 ? "" : "s"}`,
          detail: "Push them, or bring them along to the other machine.",
          clearedByIncludeChanges: true,
          fixHint: `run \`ade git push ${laneFlag}\`, or pass --include-changes`,
        });
      }
    }
    const move = options.activeMove;
    if (move && isCrossMachineHandoffActive(move)) {
      blockers.push({
        id: "move_in_progress",
        title: `Already moving to ${move.targetMachineName}`,
        detail: "Cancel that move first.",
        clearedByIncludeChanges: false,
        fixHint: "run `ade chat handoff <session> --cancel`",
      });
    }
    return {
      originUrl,
      rawOriginUrl: rawOrigin || null,
      branchRef,
      headSha,
      blockers,
      changes: changedFiles > 0 || unpushedCommits > 0 ? { unpushedCommits, changedFiles } : null,
    };
  };

  /** A chat's lane, inspected with its own move counted as a blocker. */
  const inspect = async (sessionId: string, laneId: string): Promise<CrossMachineSourceInspection> => {
    const lane = await deps.laneService.getSummary(laneId, { includeStatus: true });
    if (!lane) return { originUrl: null, rawOriginUrl: null, branchRef: null, headSha: null, blockers: [], changes: null };
    return inspectLane(lane, { activeMove: readMove(sessionId)?.record ?? null });
  };

  /**
   * The exact capsule a move handed to the destination, written before
   * acceptance starts and removed once the move ends. A retry of a move whose
   * answer was lost resends this same capsule, so the destination reconciles
   * through its record for that handoffId instead of refusing a re-prepared
   * capsule with different content.
   */
  const outboxPath = (handoffId: string): string =>
    // Handoff ids may hold `:`, which Windows file names cannot.
    path.join(deps.outboxDir, `${handoffId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  const laneOutboxPath = (importId: string): string =>
    path.join(deps.outboxDir, `${importId.replace(/[^A-Za-z0-9._-]/g, "_")}.lane.json`);

  const outbox: CrossMachineHandoffOutbox = {
    read: (handoffId) => {
      let raw: string;
      try {
        raw = fs.readFileSync(outboxPath(handoffId), "utf8");
      } catch {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as Partial<CrossMachinePreparedCapsule> & { handoffId?: unknown };
        if (
          parsed.handoffId !== handoffId
          || !parsed.capsule
          || parsed.capsule.handoffId !== handoffId
          || typeof parsed.capsuleFingerprint !== "string"
        ) {
          return null;
        }
        return { capsule: parsed.capsule, capsuleFingerprint: parsed.capsuleFingerprint };
      } catch {
        return null;
      }
    },
    write: (handoffId, prepared) => {
      fs.mkdirSync(deps.outboxDir, { recursive: true });
      writeFileAtomic(
        outboxPath(handoffId),
        JSON.stringify({ handoffId, capsule: prepared.capsule, capsuleFingerprint: prepared.capsuleFingerprint }),
        { fsync: true },
      );
    },
    remove: (handoffId) => {
      try {
        fs.rmSync(outboxPath(handoffId), { force: true });
      } catch {
        // A leftover outbox file is only a stale copy of a capsule.
      }
    },
    readLane: (importId): CrossMachineLaneOutboxEntry | null => {
      let raw: string;
      try {
        raw = fs.readFileSync(laneOutboxPath(importId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          deps.logger?.warn("agent_chat.cross_machine_lane_outbox_read_failed", {
            importId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as { payload?: unknown; sent?: unknown };
        // An entry without the wrapper predates the sent marker: whether it
        // was sent is unknown, and nothing landed in a batch that old.
        if (!parsed || typeof parsed !== "object" || !("payload" in parsed)) return null;
        const payload = decodeCrossMachineLaneImportArgs(parsed.payload);
        if (payload.importId !== importId) return null;
        return { payload, sent: parsed.sent === true };
      } catch (error) {
        deps.logger?.warn("agent_chat.cross_machine_lane_outbox_unreadable", {
          importId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    writeLane: (importId, entry) => {
      fs.mkdirSync(deps.outboxDir, { recursive: true });
      writeFileAtomic(laneOutboxPath(importId), JSON.stringify({ payload: entry.payload, sent: entry.sent }), { fsync: true });
    },
    removeLane: (importId) => {
      try {
        fs.rmSync(laneOutboxPath(importId), { force: true });
      } catch (error) {
        // A leftover lane payload is reconciled by importId at the destination.
        deps.logger?.warn("agent_chat.cross_machine_lane_outbox_cleanup_failed", {
          importId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };

  return {
    readMove,
    writeMove,
    listMoves,
    readBatch,
    writeBatch,
    listBatches,
    listOpenBatches,
    listBatchApprovals,
    inspect,
    inspectLane,
    outbox,
  };
}

export type CrossMachineHandoffSourceStore = ReturnType<typeof createCrossMachineHandoffSource>;

/** One chat of this project as a batch sees it: its row, lineage and live state. */
export type CrossMachineBatchChatState = {
  row: {
    id: string;
    laneId: string;
    status: string;
    model?: string | null;
    title?: string | null;
    archivedAt?: string | null;
    settledAt?: string | null;
    surface?: string | null;
  };
  /** The live session, else its persisted state. */
  lineage: {
    laneId?: string | null;
    orchestrationParentSessionId?: string | null;
    spawnKind?: AgentChatSpawnKind | null;
    surface?: string | null;
    provider?: string | null;
    model?: string | null;
    modelId?: string | null;
    crossMachineOrigin?: AgentChatCrossMachineHandoffOrigin | null;
    crossMachineArrival?: AgentChatCrossMachineArrival | null;
  } | null;
  /** Why a loaded chat can't move right now (`turn_active`, `awaiting_input`, …); null when unloaded or free. */
  blockedKind: string | null;
  /** The unified permission level of a loaded chat. */
  permissionLevel: string | null;
};

/**
 * The source side of a batch move: its records, the chats and lanes it can
 * select, and each lane's import payload, packed and later re-checked
 * against the lane before it is sent.
 */
export function createCrossMachineBatchSource(deps: {
  store: CrossMachineHandoffSourceStore;
  runGit: RunGit;
  laneService: {
    getSummary(laneId: string, options: { includeStatus?: boolean }): Promise<LaneSummary | null>;
    list(options: { includeArchived?: boolean; includeStatus?: boolean }): Promise<LaneSummary[]>;
  };
  listChatSessions: () => CrossMachineBatchChatState[];
  /** Where a lane that arrived here came from (the destination's lane origin record). */
  readLaneOrigin: (laneId: string) => { sourceMachineKey: string; sourceLaneId: string } | null;
  localMachineKey: () => string;
}): Omit<CrossMachineBatchMoveDeps, "interruptBatchChat" | "showBatchApprovalCard"> {
  const { store, laneService } = deps;

  const listBatchChats = async (): Promise<CrossMachineBatchChat[]> => deps.listChatSessions()
    .map(({ row, lineage, blockedKind, permissionLevel }) => {
      const activeWork = row.archivedAt == null
        && row.settledAt == null
        && (lineage?.surface ?? row.surface ?? "work") === "work";
      return {
        sessionId: row.id,
        laneId: lineage?.laneId ?? row.laneId,
        parentSessionId: lineage?.orchestrationParentSessionId ?? null,
        spawnKind: lineage?.spawnKind ?? "subagent",
        isWorkChat: activeWork,
        turnActive: blockedKind === "turn_active" || row.status === "running" || row.status === "detached",
        awaitingInput: blockedKind === "awaiting_input",
        permissionLevel,
        provider: lineage?.provider ?? "",
        model: lineage?.model ?? row.model ?? "",
        modelId: lineage?.modelId ?? null,
        title: row.title ?? null,
        crossMachineOrigin: lineage?.crossMachineOrigin ?? null,
        crossMachineArrival: lineage?.crossMachineArrival ?? null,
      };
    });

  const listBatchLanes = async (): Promise<CrossMachineBatchLane[]> => (await laneService
    .list({ includeArchived: false, includeStatus: false }))
    .map((lane) => {
      const origin = deps.readLaneOrigin(lane.id);
      return {
        laneId: lane.id,
        parentLaneId: lane.parentLaneId ?? null,
        name: lane.name,
        branchRef: lane.branchRef ?? "",
        ...(origin ? { originMachineKey: origin.sourceMachineKey, originLaneId: origin.sourceLaneId } : {}),
      };
    });

  const inspectBatchLane = async (laneId: string): Promise<CrossMachineSourceInspection> => {
    const lane = await laneService.getSummary(laneId, { includeStatus: true });
    if (!lane) throw new Error(`The source lane '${laneId}' could not be loaded.`);
    return store.inspectLane(lane);
  };

  const prepareBatchLane: CrossMachineBatchMoveDeps["prepareBatchLane"] = async (
    { importId, lane, returnToLaneId, destinationParentLaneId, includeChanges },
  ) => {
    const summary = await laneService.getSummary(lane.laneId, { includeStatus: true });
    if (!summary) throw new Error(`The source lane '${lane.name}' could not be loaded.`);
    const inspection = await store.inspectLane(summary);
    const label = `Lane '${lane.name}'`;
    const { branchRef, headSha } = requireMovable(inspection, { includeChanges, label });
    const rawOriginUrl = inspection.rawOriginUrl;
    if (!rawOriginUrl) throw new Error(`${label} needs a published branch and origin before it can move.`);
    const remote = await deps.runGit(["ls-remote", "--heads", "origin", `refs/heads/${branchRef}`], {
      cwd: summary.worktreePath,
      timeoutMs: 30_000,
    });
    if (remote.exitCode !== 0) throw new Error(`ADE could not read '${branchRef}' on origin. ${redactGitOutput(remote.stderr.trim())}`.trim());
    const remoteHeadSha = remote.stdout.trim().split(/\s+/)[0]?.trim() || null;
    const sourceMachineKey = deps.localMachineKey();
    const gitBundle = includeChanges
      ? await packHandoffGitBundle({
          worktreePath: summary.worktreePath,
          branchRef: branchRef,
          handoffId: importId,
          remoteBranchSha: remoteHeadSha,
          maxEncodedBytes: CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES - 1024 * 1024,
        })
      : null;
    if (!gitBundle && remoteHeadSha !== headSha) {
      throw new Error(`Publish '${branchRef}' or include its changes before moving lane '${lane.name}'.`);
    }
    return {
      importId,
      sourceMachineName: localMachineName(),
      ...(sourceMachineKey ? { sourceMachineKey } : {}),
      sourceLane: { laneId: lane.laneId, parentLaneId: lane.parentLaneId, name: lane.name },
      ...(returnToLaneId ? { returnToLaneId } : {}),
      ...(destinationParentLaneId ? { destinationParentLaneId } : {}),
      branchRef: branchRef,
      headSha: headSha,
      originUrl: rawOriginUrl,
      ...(gitBundle ? { gitBundle } : {}),
    };
  };

  const validateBatchLane: CrossMachineBatchMoveDeps["validateBatchLane"] = async (payload) => {
    const summary = await laneService.getSummary(payload.sourceLane.laneId, { includeStatus: true });
    if (!summary) throw new CrossMachineSourceStaleError("The source lane was removed after the batch was prepared.");
    const current = await store.inspectLane(summary);
    if (
      current.branchRef !== payload.branchRef
      || current.headSha !== payload.headSha
      || gitRemoteIdentity(current.originUrl) !== gitRemoteIdentity(payload.originUrl)
    ) throw new CrossMachineSourceStaleError("The source lane changed after the batch was prepared. Review the batch again.");
    if (payload.gitBundle) {
      validateHandoffGitBundle({ source: { headSha: payload.headSha }, gitBundle: payload.gitBundle });
      const tree = await readHandoffWorkingTreeSha({ worktreePath: summary.worktreePath });
      const expected = await requireGitOutput(
        deps.runGit,
        ["rev-parse", `${payload.gitBundle.snapshotSha ?? payload.headSha}^{tree}`],
        summary.worktreePath,
        "ADE could not verify the prepared lane changes.",
      );
      if (tree !== expected) throw new CrossMachineSourceStaleError("The source lane files changed after the batch was prepared.");
    } else if (current.changes !== null) {
      throw new CrossMachineSourceStaleError("The source lane has changes that were not included in the batch.");
    }
  };

  return {
    readBatch: store.readBatch,
    writeBatch: store.writeBatch,
    listBatches: store.listBatches,
    listOpenBatches: store.listOpenBatches,
    listBatchChats,
    listBatchLanes,
    inspectBatchLane,
    prepareBatchLane,
    validateBatchLane,
  };
}
