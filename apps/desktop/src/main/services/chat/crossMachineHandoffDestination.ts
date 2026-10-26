/**
 * The destination brain's side of moving chats between machines, kept out of
 * agentChatService: importing a batch's lanes (and running their setup),
 * continuing the ORIGINAL chat when a moved chat comes back (a return), and
 * the durable records both keep so a resend reconciles instead of
 * duplicating. agentChatService accepts ordinary arrivals and delegates here.
 *
 * Records (machine-local kv, keyed by the source's ids):
 * - lane import (`importId`): the lane a batch import landed or reused, its
 *   changes and its setup outcome. A resend with the same contents answers
 *   from it; different contents under the same id are refused.
 * - lane origin (destination lane id): which source lane this lane came from,
 *   so moving it back reuses that lane instead of importing a third.
 * - return receipt (`handoffId`): how far a return got. Each step runs once;
 *   a resend picks up after the last step that finished.
 * - handoff record (`handoffId`): the destination's transaction for one
 *   accepted handoff (`CrossMachineHandoffRecord`).
 */
import { randomUUID } from "node:crypto";
import {
  CROSS_MACHINE_HANDOFF_DEFAULT_PROMPT,
  CROSS_MACHINE_RETURN_REFUSED_CODE,
  decodeCrossMachineLaneImportArgs,
  sanitizePortableGitRemote,
} from "../../../shared/crossMachineHandoff";
import { isSameGitRepository } from "../github/githubSshAlias";
import { crossMachineScheduledWorkId } from "../../../shared/deterministicChatSessionId";
import { getModelById, resolveModelAlias, resolveProviderGroupForModel } from "../../../shared/modelRegistry";
import type {
  AgentChatAcceptCrossMachineHandoffResult,
  AgentChatCrossMachineGitBundle,
  AgentChatCrossMachineHandoffCapsule,
  AgentChatCrossMachineLaneImportResult,
  AgentChatCrossMachineLaneSetupStatus,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSendArgs,
  AgentChatSession,
  LaneSummary,
} from "../../../shared/types";
import type { GitRunOptions, GitRunResult } from "../git/git";
import type { createLaneService } from "../lanes/laneService";
import { nowIso, stableFingerprint } from "../shared/utils";
import type { AdeDb } from "../state/kvDb";
import type { ChatScheduledWorkScheduler } from "./chatScheduledWorkScheduler";
import type { CrossMachineHandoffPersisted } from "./crossMachineHandoffOrchestrator";
import { localMachineName, requireGitBranch, requireGitOutput, requireHandoffId } from "./crossMachineHandoffSource";
import { landHandoffGitBundle, validateHandoffGitBundle } from "./handoffGitBundle";

/** The destination's own transaction for one accepted handoff, keyed by handoffId. */
export type CrossMachineHandoffRecord = {
  version: 1;
  handoffId: string;
  capsuleFingerprint: string;
  state: "preparing" | "lane_ready" | "chat_ready" | "dispatched" | "complete" | "failed";
  laneId: string | null;
  sessionId: string | null;
  updatedAt: string;
  lastError: string | null;
  /**
   * Set once fork materialization (provider files + thread fork + transcript
   * seeding) completed for this handoff. A retry after a later failure (e.g.
   * the continuation sendMessage) must skip those side effects or it would
   * fork the provider thread and append the transported transcript twice.
   */
  forkMaterializedAt?: string | null;
};

const RETURN_STEPS = ["lane_ready", "provider_replaced", "transcript_appended", "unlocked", "complete"] as const;
type CrossMachineReturnStep = (typeof RETURN_STEPS)[number];

type CrossMachineReturnReceipt = {
  version: 1;
  handoffId: string;
  capsuleFingerprint: string;
  sessionId: string;
  laneId: string;
  state: CrossMachineReturnStep;
  updatedAt: string;
};

// Sync commands and run_ade_action can deliver the same durable import at the
// same time. Keep one operation per destination project and import id.
const laneImportsInFlight = new Map<string, Promise<AgentChatCrossMachineLaneImportResult>>();

export type CrossMachineReturnRefusalReason =
  | "return_address_invalid"
  | "original_chat_missing"
  | "original_lane_unavailable"
  | "move_not_continued"
  | "sender_mismatch"
  | "provider_mismatch"
  | "lane_mismatch"
  | "lane_blocked"
  | "original_lane_primary"
  | "receipt_mismatch";

/**
 * A definitive refusal to continue the original chat: nothing was committed,
 * so the source may move the chat again as a new chat here.
 */
export class CrossMachineHandoffReturnRefusedError extends Error {
  readonly code = CROSS_MACHINE_RETURN_REFUSED_CODE;
  readonly reason: CrossMachineReturnRefusalReason;

  constructor(reason: CrossMachineReturnRefusalReason, message: string) {
    super(
      `Cannot return this chat to its original chat: ${message.replace(/[.\s]+$/, "")}. Retry or move it again to start it there as a new chat; the original chat stays as it is.`,
    );
    this.name = "CrossMachineHandoffReturnRefusedError";
    this.reason = reason;
  }
}

export type CrossMachineLaneImportRecord = {
  version: 1;
  importId: string;
  fingerprint: string;
  state: "importing" | "complete" | "failed";
  laneId: string | null;
  reusedLane: boolean;
  carriedChanges: boolean;
  snapshotSha: string | null;
  warnings: string[];
  setupStatus?: AgentChatCrossMachineLaneSetupStatus;
  setupRunnerId?: string | null;
  setupMessage?: string | null;
  updatedAt: string;
  lastError: string | null;
};

export type CrossMachineLaneOriginRecord = {
  version: 1;
  destinationLaneId: string;
  sourceMachineKey: string;
  sourceLaneId: string;
  sourceParentLaneId: string | null;
};

const laneImportKey = (importId: string): string => `agent-chat-cross-machine-lane-import:v1:${importId}`;
const laneOriginKey = (destinationLaneId: string): string => `agent-chat-cross-machine-lane-origin:v1:${destinationLaneId}`;
const returnReceiptKey = (handoffId: string): string => `agent-chat-cross-machine-return:v1:${handoffId}`;
const handoffRecordKey = (handoffId: string): string => `agent-chat-cross-machine-handoff:v1:${handoffId}`;

const HANDOFF_RECORD_STATES: ReadonlySet<string> = new Set<CrossMachineHandoffRecord["state"]>([
  "preparing",
  "lane_ready",
  "chat_ready",
  "dispatched",
  "complete",
  "failed",
]);

/** The source's ids of the scheduled work this capsule recreated here (the source cancels exactly these). */
export function crossMachineScheduledWorkIds(capsule: AgentChatCrossMachineHandoffCapsule): string[] {
  return (capsule.scheduledWork ?? []).flatMap((item) => (item.id?.trim() ? [item.id.trim()] : []));
}

const primaryCheckoutRefusal = (laneName: string, branchRef: string): string =>
  `'${branchRef}' is checked out in this machine's primary checkout ('${laneName}'), and ADE never writes moved work into it. Switch that checkout to another branch, then retry the move.`;

type RunGit = (args: string[], opts: GitRunOptions) => Promise<GitRunResult>;

export type CrossMachineHandoffDestinationDeps<TManaged extends { session: AgentChatSession }> = {
  projectRoot: string;
  db: Pick<AdeDb, "getJson" | "setJson"> | null | undefined;
  laneService: Pick<ReturnType<typeof createLaneService>, "getSummary" | "list" | "importBranch" | "delete">;
  runGit: RunGit;
  logger: { info(event: string, data?: Record<string, unknown>): void; warn(event: string, data?: Record<string, unknown>): void };
  /** This machine's account key; empty when it can't be identified. */
  localMachineKey: () => string;
  /** Git credentials for fetches from origin. */
  gitEnv: () => Promise<NodeJS.ProcessEnv>;
  fastForwardLane: (args: { laneId: string; expectedHead: string }) => Promise<unknown>;
  /** A lane's environment setup; absent means this host cannot run it. */
  runLaneSetup: ((laneId: string) => Promise<void>) | null | undefined;
  /** The scheduler once it has loaded; null when this host has none. */
  scheduledWork: () => Promise<Pick<ChatScheduledWorkScheduler, "upsert"> | null>;
  chat: {
    /** The chat's session row, when it is an ADE chat of this project. */
    readChatRow: (sessionId: string) => { laneId: string; archivedAt?: string | null } | null;
    tryManaged: (sessionId: string) => TManaged | null;
    assertOwnedHere: (sessionId: string, action: string) => void;
    readMove: (sessionId: string) => CrossMachineHandoffPersisted | null;
    writeMove: (sessionId: string, value: CrossMachineHandoffPersisted | null) => void;
    materializeFork: (args: {
      capsule: AgentChatCrossMachineHandoffCapsule;
      handoffId: string;
      destinationLanePath: string;
      managed: TManaged;
    }) => Promise<void>;
    persist: (managed: TManaged) => void;
    parseTranscriptEnvelopes: (capsule: AgentChatCrossMachineHandoffCapsule, destinationSessionId: string) => AgentChatEventEnvelope[];
    readTranscript: (managed: TManaged) => AgentChatEventEnvelope[];
    appendImportedEvents: (managed: TManaged, envelopes: AgentChatEventEnvelope[]) => Promise<void>;
    sendMessage: (args: AgentChatSendArgs, options: { awaitBackendDispatch: true }) => Promise<unknown>;
    emitEvent: (managed: TManaged, event: AgentChatEvent) => void;
  };
};

export function createCrossMachineHandoffDestination<TManaged extends { session: AgentChatSession }>(
  deps: CrossMachineHandoffDestinationDeps<TManaged>,
) {
  const { db, laneService, runGit, logger } = deps;

  /** The kv record at `key` when it is an object at version 1; each reader checks its own fields. */
  const readVersionedJson = <T extends { version: 1 }>(key: string): Partial<T> | null => {
    const value = db?.getJson<unknown>(key);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<T>;
    return record.version === 1 ? record : null;
  };

  const readLaneOrigin = (destinationLaneId: string): CrossMachineLaneOriginRecord | null => {
    const record = readVersionedJson<CrossMachineLaneOriginRecord>(laneOriginKey(destinationLaneId));
    if (
      !record
      || record.destinationLaneId !== destinationLaneId
      || typeof record.sourceMachineKey !== "string"
      || typeof record.sourceLaneId !== "string"
    ) return null;
    return record as CrossMachineLaneOriginRecord;
  };

  const readLaneImport = (importId: string): CrossMachineLaneImportRecord | null => {
    const record = readVersionedJson<CrossMachineLaneImportRecord>(laneImportKey(importId));
    if (!record || record.importId !== importId || typeof record.fingerprint !== "string") return null;
    if (record.state !== "importing" && record.state !== "complete" && record.state !== "failed") return null;
    return record as CrossMachineLaneImportRecord;
  };

  const persistLaneImport = (record: CrossMachineLaneImportRecord): void => {
    db?.setJson(laneImportKey(record.importId), record);
  };

  const readReturnReceipt = (handoffId: string): CrossMachineReturnReceipt | null => {
    const receipt = readVersionedJson<CrossMachineReturnReceipt>(returnReceiptKey(handoffId));
    if (
      !receipt
      || receipt.handoffId !== handoffId
      || typeof receipt.capsuleFingerprint !== "string"
      || typeof receipt.sessionId !== "string"
      || typeof receipt.laneId !== "string"
      || !(RETURN_STEPS as readonly string[]).includes(String(receipt.state))
    ) return null;
    return receipt as CrossMachineReturnReceipt;
  };

  const persistReturnReceipt = (receipt: CrossMachineReturnReceipt): void => {
    db?.setJson(returnReceiptKey(receipt.handoffId), receipt);
  };

  const readHandoffRecord = (handoffId: string): CrossMachineHandoffRecord | null => {
    const record = readVersionedJson<CrossMachineHandoffRecord>(handoffRecordKey(handoffId));
    if (
      !record
      || record.handoffId !== handoffId
      || typeof record.capsuleFingerprint !== "string"
      || !record.state
      || !HANDOFF_RECORD_STATES.has(record.state)
    ) return null;
    return {
      version: 1,
      handoffId,
      capsuleFingerprint: record.capsuleFingerprint,
      state: record.state,
      laneId: typeof record.laneId === "string" ? record.laneId : null,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
      lastError: typeof record.lastError === "string" ? record.lastError : null,
      forkMaterializedAt: typeof record.forkMaterializedAt === "string" ? record.forkMaterializedAt : null,
    };
  };

  const persistHandoffRecord = (record: CrossMachineHandoffRecord): void => {
    db?.setJson(handoffRecordKey(record.handoffId), record);
  };

  // ---------------------------------------------------------------------------
  // Lane setup for a batch's imported lanes

  /**
   * One per service instance: a setup claimed by a process that died is taken
   * over. Made on first use, so a brain that never imports a lane spends none.
   */
  let laneSetupRunnerIdValue: string | null = null;
  const laneSetupRunnerId = (): string => (laneSetupRunnerIdValue ??= randomUUID());

  const beginLaneSetup = (importId: string): { claimed: boolean; status: AgentChatCrossMachineLaneSetupStatus } => {
    const record = readLaneImport(importId);
    if (!record || record.state !== "complete") throw new Error("The batch lane import is not ready for setup.");
    if (record.setupStatus && record.setupStatus !== "running") {
      return { claimed: false, status: record.setupStatus };
    }
    if (record.setupStatus === "running" && record.setupRunnerId === laneSetupRunnerId()) {
      return { claimed: false, status: "running" };
    }
    persistLaneImport({
      ...record,
      setupStatus: "running",
      setupRunnerId: laneSetupRunnerId(),
      updatedAt: nowIso(),
    });
    return { claimed: true, status: "running" };
  };

  const finishLaneSetup = (
    importId: string,
    status: Exclude<AgentChatCrossMachineLaneSetupStatus, "running">,
    message: string | null = null,
  ): void => {
    const record = readLaneImport(importId);
    if (!record) throw new Error("The batch lane import record was not found.");
    persistLaneImport({
      ...record,
      setupStatus: status,
      setupRunnerId: null,
      setupMessage: message?.slice(0, 1_000) ?? null,
      updatedAt: nowIso(),
    });
  };

  /**
   * Starts the imported lane's environment setup once per import, without
   * holding the reply, and records how it ended on the import record (the
   * arriving chat's first prompt reads it). A second call for the same import
   * (a retry, a resend) reports the setup already under way or done.
   */
  const startLaneSetup = (importId: string, laneId: string): AgentChatCrossMachineLaneSetupStatus => {
    const setup = deps.runLaneSetup;
    try {
      if (!setup) {
        if (readLaneImport(importId)?.setupStatus !== "not_configured") finishLaneSetup(importId, "not_configured");
        return "not_configured";
      }
      const claim = beginLaneSetup(importId);
      if (!claim.claimed) return claim.status;
    } catch (error) {
      // The lane already landed; a setup bookkeeping failure must not undo
      // the import. It reports as failed so the arriving chat says so.
      logger.warn("agent_chat.cross_machine_lane_setup_claim_failed", {
        importId,
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
    void (async () => {
      let status: "completed" | "failed" = "completed";
      let message: string | null = null;
      try {
        await setup(laneId);
      } catch (error) {
        status = "failed";
        message = error instanceof Error ? error.message : String(error);
        // The lane stays usable; Settings or `lanes.applyTemplate` can run setup again.
        logger.warn("agent_chat.cross_machine_lane_setup_failed", { importId, laneId, error: message });
      }
      try {
        finishLaneSetup(importId, status, message);
      } catch (error) {
        logger.warn("agent_chat.cross_machine_lane_setup_record_failed", {
          importId,
          laneId,
          status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return "running";
  };

  /**
   * Setup runs only on a lane this import created. A lane that already
   * existed here (the original lane of a return, a lane reused on the same
   * branch, a primary checkout already at the commit) keeps its environment,
   * so the import records `not_needed` instead.
   */
  const settleLaneSetup = (
    importId: string,
    lane: Pick<LaneSummary, "id" | "laneType">,
    created: boolean,
  ): AgentChatCrossMachineLaneSetupStatus => {
    if (created && lane.laneType !== "primary") return startLaneSetup(importId, lane.id);
    try {
      if (readLaneImport(importId)?.setupStatus !== "not_needed") finishLaneSetup(importId, "not_needed");
    } catch (error) {
      // The lane already landed; the arriving chat still reads `not_needed`.
      logger.warn("agent_chat.cross_machine_lane_setup_record_failed", {
        importId,
        laneId: lane.id,
        status: "not_needed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.info("agent_chat.cross_machine_lane_setup_not_needed", { importId, laneId: lane.id });
    return "not_needed";
  };

  // ---------------------------------------------------------------------------
  // Lanes

  /**
   * Brings a lane that already exists here to the handed-off commit: a bundle
   * lands in its worktree (through the per-branch landing queue), otherwise a
   * clean lane is fast-forwarded to the commit. Never writes into a primary
   * checkout; one already at the commit with nothing to apply is reused as is.
   */
  const syncExistingLaneToHandoff = async (args: {
    lane: LaneSummary;
    branchRef: string;
    headSha: string;
    gitBundle: AgentChatCrossMachineGitBundle | undefined;
    handoffId: string;
    source: { laneName: string; machineName: string };
    /** The lane is bound to this handoff, before any change lands in it. */
    onLaneBound?: (laneId: string) => void;
  }): Promise<void> => {
    const { lane, branchRef, headSha } = args;
    if (args.gitBundle) {
      if (lane.laneType === "primary") throw new Error(primaryCheckoutRefusal(lane.name, branchRef));
      await landHandoffGitBundle({
        projectRoot: deps.projectRoot,
        capsule: { gitBundle: args.gitBundle, source: args.source },
        handoffId: args.handoffId,
        branchRef,
        existingLane: lane,
        fetchEnv: await deps.gitEnv(),
        importLane: async () => {
          throw new Error("An existing lane is reused here; ADE never imports another.");
        },
        deleteLane: async () => {},
        onLaneImported: (laneId) => args.onLaneBound?.(laneId),
      });
      return;
    }
    const status = await runGit(["status", "--porcelain=v1"], { cwd: lane.worktreePath, timeoutMs: 15_000 });
    if (status.exitCode !== 0 || status.stdout.trim()) {
      throw new Error(`Original lane '${lane.name}' has uncommitted changes and cannot be fast-forwarded.`);
    }
    const currentHead = await requireGitOutput(
      runGit,
      ["rev-parse", "HEAD"],
      lane.worktreePath,
      `Original lane '${lane.name}' does not have a readable commit.`,
    );
    if (currentHead === headSha) return;
    // A primary checkout already at the commit is reused as is; moving it
    // forward would write into the person's own working copy.
    if (lane.laneType === "primary") throw new Error(primaryCheckoutRefusal(lane.name, branchRef));
    await deps.fastForwardLane({ laneId: lane.id, expectedHead: headSha });
  };

  /** `rawPayload` is decoded here: every transport (sync command, run_ade_action) passes what it received. */
  const importLaneOnce = async (
    payload: ReturnType<typeof decodeCrossMachineLaneImportArgs>,
    importId: string,
  ): Promise<AgentChatCrossMachineLaneImportResult> => {
    const sourceMachineKey = payload.sourceMachineKey?.trim() || "";
    const rememberLaneOrigin = (destinationLaneId: string): void => {
      if (!sourceMachineKey || payload.returnToLaneId) return;
      db?.setJson(laneOriginKey(destinationLaneId), {
        version: 1,
        destinationLaneId,
        sourceMachineKey,
        sourceLaneId: payload.sourceLane.laneId,
        sourceParentLaneId: payload.sourceLane.parentLaneId,
      } satisfies CrossMachineLaneOriginRecord);
    };
    const branchRef = await requireGitBranch(runGit, payload.branchRef, deps.projectRoot);
    const headSha = payload.headSha.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(headSha)) throw new Error("The batch lane import has an invalid source commit.");
    if (payload.gitBundle) {
      validateHandoffGitBundle({ source: { headSha }, gitBundle: payload.gitBundle });
    }
    if (payload.sourceLane.parentLaneId && !payload.destinationParentLaneId) {
      throw new Error("The destination parent lane must arrive before this lane.");
    }
    const parentLane = payload.destinationParentLaneId
      ? await laneService.getSummary(payload.destinationParentLaneId, { includeStatus: false })
      : null;
    if (payload.destinationParentLaneId && (!parentLane || parentLane.archivedAt)) {
      throw new Error("The destination parent lane is unavailable or archived.");
    }
    const origin = await requireGitOutput(
      runGit,
      ["remote", "get-url", "origin"],
      deps.projectRoot,
      "The destination project does not have an origin remote.",
    );
    if (
      !isSameGitRepository(origin, payload.originUrl)
      || sanitizePortableGitRemote(payload.originUrl) !== payload.originUrl
    ) {
      throw new Error("The destination project points at a different Git repository than the batch lane import.");
    }

    const fingerprint = stableFingerprint(payload);
    const prior = readLaneImport(importId);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new Error("This batch lane import id is already bound to different lane contents.");
    }
    if (prior?.state === "complete" && prior.laneId) {
      const completedLane = await laneService.getSummary(prior.laneId, { includeStatus: false });
      if (!completedLane || completedLane.archivedAt) throw new Error("The lane imported by this batch was removed or archived.");
      rememberLaneOrigin(prior.laneId);
      return {
        importId,
        laneId: prior.laneId,
        reusedLane: prior.reusedLane,
        carriedChanges: prior.carriedChanges,
        snapshotSha: prior.snapshotSha,
        warnings: prior.warnings,
        setupStatus: settleLaneSetup(importId, completedLane, !prior.reusedLane && !payload.returnToLaneId),
      };
    }
    let record: CrossMachineLaneImportRecord = prior ?? {
      version: 1,
      importId,
      fingerprint,
      state: "importing",
      laneId: null,
      reusedLane: false,
      carriedChanges: Boolean(payload.gitBundle),
      snapshotSha: payload.gitBundle?.snapshotSha ?? null,
      warnings: [],
      setupStatus: "running",
      setupMessage: null,
      updatedAt: nowIso(),
      lastError: null,
    };
    record = { ...record, state: "importing", updatedAt: nowIso(), lastError: null };
    persistLaneImport(record);
    // Bound before the changes land, so a crash mid-apply retries into it.
    const bindLane = (laneId: string): void => {
      record = { ...record, laneId, updatedAt: nowIso() };
      persistLaneImport(record);
    };
    const source = { laneName: payload.sourceLane.name, machineName: payload.sourceMachineName };

    const warnings: string[] = [...record.warnings];
    try {
      if (payload.returnToLaneId) {
        const lane = await laneService.getSummary(payload.returnToLaneId, { includeStatus: true });
        if (!lane || lane.archivedAt) throw new Error("The original lane for this batch return is unavailable or archived.");
        if (lane.branchRef.replace(/^refs\/heads\//, "") !== branchRef) {
          throw new Error("The original lane for this batch return is on a different branch.");
        }
        await syncExistingLaneToHandoff({
          lane,
          branchRef,
          headSha,
          gitBundle: payload.gitBundle,
          handoffId: importId,
          source,
          onLaneBound: bindLane,
        });
        record = {
          ...record,
          state: "complete",
          laneId: lane.id,
          reusedLane: true,
          carriedChanges: Boolean(payload.gitBundle),
          snapshotSha: payload.gitBundle?.snapshotSha ?? null,
          updatedAt: nowIso(),
          lastError: null,
        };
        persistLaneImport(record);
        return {
          importId,
          laneId: lane.id,
          reusedLane: true,
          carriedChanges: record.carriedChanges,
          snapshotSha: record.snapshotSha,
          warnings: record.warnings,
          setupStatus: settleLaneSetup(importId, lane, false),
        };
      }
      const lanes = await laneService.list({ includeArchived: false, includeStatus: true });
      // A lane an earlier attempt bound keeps what that attempt recorded
      // (created or reused); otherwise a lane already on the branch is reused.
      let lane = record.laneId ? lanes.find((candidate) => candidate.id === record.laneId) ?? null : null;
      let reusedLane = lane ? record.reusedLane : false;
      if (!lane) {
        lane = lanes.find((candidate) => candidate.branchRef.replace(/^refs\/heads\//, "") === branchRef) ?? null;
        reusedLane = lane !== null;
        if (reusedLane !== record.reusedLane) {
          // Recorded before any change lands, so a retry after a crash still
          // knows this lane was not created here (lane setup keys on it).
          record = { ...record, reusedLane, updatedAt: nowIso() };
          persistLaneImport(record);
        }
      }
      if (lane && payload.gitBundle && lane.laneType === "primary") {
        throw new Error(primaryCheckoutRefusal(lane.name, branchRef));
      }
      if (reusedLane && lane && payload.destinationParentLaneId && lane.parentLaneId !== payload.destinationParentLaneId) {
        warnings.push(`Reused lane '${lane.name}' keeps its existing parent.`);
      }
      if (lane && !payload.gitBundle) {
        // Reused only when it is already exactly the source commit and clean:
        // nothing is written into it (a primary checkout included).
        const status = await runGit(["status", "--porcelain=v1"], { cwd: lane.worktreePath, timeoutMs: 15_000 });
        const currentHead = await runGit(["rev-parse", "HEAD"], { cwd: lane.worktreePath, timeoutMs: 8_000 });
        if (status.exitCode !== 0 || status.stdout.trim()) throw new Error(`Existing destination lane '${lane.name}' has uncommitted changes.`);
        if (currentHead.exitCode !== 0 || currentHead.stdout.trim() !== headSha) {
          throw new Error(`Existing destination lane '${lane.name}' is not at source commit ${headSha}.`);
        }
      }
      if (payload.gitBundle) {
        // Bundles land through the same per-branch queue (and primary-checkout
        // refusal) as a single move's changes, so two landings on one branch
        // never interleave their checks and rollbacks.
        lane = await landHandoffGitBundle({
          projectRoot: deps.projectRoot,
          capsule: { gitBundle: payload.gitBundle, source },
          handoffId: importId,
          branchRef,
          existingLane: lane,
          fetchEnv: await deps.gitEnv(),
          importLane: (input) => laneService.importBranch({
            ...input,
            parentLaneId: payload.destinationParentLaneId ?? null,
            // The bundle may carry commits the person never pushed.
            publishUpstream: false,
          }),
          deleteLane: async (laneId) => {
            await laneService.delete({ laneId, deleteBranch: false, force: true });
          },
          onLaneImported: bindLane,
        });
      } else if (!lane) {
        const remote = await runGit(["ls-remote", "--heads", "origin", `refs/heads/${branchRef}`], {
          cwd: deps.projectRoot,
          timeoutMs: 30_000,
          env: await deps.gitEnv(),
        });
        const remoteHead = remote.stdout.trim().split(/\s+/)[0]?.trim() || null;
        if (remote.exitCode !== 0 || remoteHead !== headSha) {
          throw new Error(`Origin no longer has '${branchRef}' at the source commit.`);
        }
        lane = await laneService.importBranch({
          branchRef,
          name: payload.sourceLane.name,
          description: `Received from ${payload.sourceMachineName}`,
          parentLaneId: payload.destinationParentLaneId ?? null,
          publishUpstream: false,
        });
        bindLane(lane.id);
      }
      record = {
        ...record,
        state: "complete",
        laneId: lane.id,
        reusedLane,
        carriedChanges: Boolean(payload.gitBundle),
        snapshotSha: payload.gitBundle?.snapshotSha ?? null,
        warnings: [...new Set(warnings)],
        updatedAt: nowIso(),
        lastError: null,
      };
      persistLaneImport(record);
      rememberLaneOrigin(lane.id);
      return {
        importId,
        laneId: lane.id,
        reusedLane,
        carriedChanges: record.carriedChanges,
        snapshotSha: record.snapshotSha,
        warnings: record.warnings,
        setupStatus: settleLaneSetup(importId, lane, !reusedLane),
      };
    } catch (error) {
      record = { ...record, state: "failed", updatedAt: nowIso(), lastError: error instanceof Error ? error.message : String(error) };
      persistLaneImport(record);
      logger.warn("agent_chat.cross_machine_lane_import_failed", {
        importId,
        laneId: record.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  /** A repeated delivery for an import id joins the first attempt, including while it is still validating. */
  const importLane = (rawPayload: unknown): Promise<AgentChatCrossMachineLaneImportResult> => {
    const payload = decodeCrossMachineLaneImportArgs(rawPayload);
    const importId = requireHandoffId(payload.importId);
    const inFlightKey = `${deps.projectRoot}\u0000${importId}`;
    const inFlight = laneImportsInFlight.get(inFlightKey);
    if (inFlight) return inFlight;

    const operation = importLaneOnce(payload, importId);
    let tracked: Promise<AgentChatCrossMachineLaneImportResult>;
    tracked = operation.finally(() => {
      if (laneImportsInFlight.get(inFlightKey) === tracked) laneImportsInFlight.delete(inFlightKey);
    });
    laneImportsInFlight.set(inFlightKey, tracked);
    return tracked;
  };

  // ---------------------------------------------------------------------------
  // Arrivals

  /** The first prompt of a chat a batch moved here: where it is now and what did not travel. */
  const buildBatchArrivalPrompt = (
    capsule: AgentChatCrossMachineHandoffCapsule,
    lanePath: string,
    setupStatus: CrossMachineLaneImportRecord["setupStatus"],
  ): string => {
    const setup = (() => {
      switch (setupStatus) {
        case "completed":
          return "Lane environment setup is completed.";
        case "failed":
          return "Lane environment setup failed; the lane is usable and setup can be retried.";
        case "not_configured":
          return "Lane environment setup is not configured on this machine.";
        case "not_needed":
          return "This lane already existed on this machine and was already set up, so lane environment setup did not run again.";
        default:
          return "Lane environment setup is still running in the background.";
      }
    })();
    const parentNotice = capsule.source.orchestrationParentSessionId && !capsule.parentLink
      ? "The original parent chat remains on the source machine. This chat arrived without a local parent link."
      : null;
    return [
      `ADE moved this chat from ${capsule.source.machineName} to ${localMachineName("this machine")}.`,
      `Its new worktree is ${lanePath}.`,
      "Processes from the source machine did not travel: dev apps, typechecks, terminals, background shells, and monitors must be started again here.",
      setup,
      "Ignored files such as .env, node_modules, and build output did not travel.",
      "Continue the task from where it stopped and rerun any check it was waiting on.",
      parentNotice,
      capsule.batchMove?.modeFallbackReason ? `ADE used a brief because: ${capsule.batchMove.modeFallbackReason}` : null,
      capsule.batchMove?.note ? `Batch note: ${capsule.batchMove.note}` : null,
      capsule.continuationPrompt !== CROSS_MACHINE_HANDOFF_DEFAULT_PROMPT
        ? `Continuation instruction: ${capsule.continuationPrompt}`
        : null,
      "",
      capsule.brief,
    ].filter((line): line is string => line != null).join("\n\n");
  };

  /** Recreates the chat's carried scheduled work (wakeups, crons, loops) on the chat here. */
  const recreateScheduledWork = async (
    capsule: AgentChatCrossMachineHandoffCapsule,
    destinationSessionId: string,
  ): Promise<void> => {
    // Most single moves carry none; they must not depend on the scheduler.
    if (!capsule.scheduledWork?.length) return;
    const scheduler = await deps.scheduledWork();
    if (!scheduler) throw new Error("Scheduled work is not ready yet. Try the handoff again in a moment.");
    for (const [index, item] of capsule.scheduledWork.entries()) {
      await scheduler.upsert({
        id: item.id?.trim() || crossMachineScheduledWorkId(capsule.handoffId, index),
        sessionId: destinationSessionId,
        kind: item.kind,
        prompt: item.prompt,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.cron ? { cron: item.cron } : {}),
        ...(item.runAt ? { fireAt: Date.parse(item.runAt) } : {}),
        ...(item.expiresAt ? { expiresAt: Date.parse(item.expiresAt) } : {}),
        ...(item.paused ? { status: "paused", pausedFlag: true } : {}),
      });
    }
  };

  /**
   * Appends the imported envelopes this chat does not hold yet, matched by
   * their source sequence under this handoff, so a resend never doubles them.
   */
  const appendMissingEvents = async (
    managed: TManaged,
    handoffId: string,
    sourceSessionId: string,
    envelopes: AgentChatEventEnvelope[],
  ): Promise<void> => {
    const importedSequences = new Set(deps.chat.readTranscript(managed).flatMap((envelope) =>
      envelope.provenance?.crossMachineHandoffId === handoffId
      && envelope.provenance.sourceSessionId === sourceSessionId
      && typeof envelope.provenance.sourceSequence === "number"
        ? [envelope.provenance.sourceSequence]
        : [],
    ));
    const missing = envelopes.filter((envelope) =>
      typeof envelope.provenance?.sourceSequence !== "number"
      || !importedSequences.has(envelope.provenance.sourceSequence),
    );
    if (missing.length) await deps.chat.appendImportedEvents(managed, missing);
  };

  // ---------------------------------------------------------------------------
  // Returns: a moved chat continuing its ORIGINAL chat here

  /**
   * Continues the original chat (the return address) with what the moved copy
   * did while away, in receipt-tracked steps: the lane reaches the returned
   * commit, the provider history is replaced (fork), the returned transcript
   * suffix is appended, the original's move lock is released with the return
   * prompt and notice, then the receipt completes. Any refusal before a step
   * commits is a definitive `CrossMachineHandoffReturnRefusedError`.
   */
  const acceptReturn = async (
    capsule: AgentChatCrossMachineHandoffCapsule,
    handoffId: string,
    fingerprint: string,
    priorRecord: CrossMachineHandoffRecord | null,
  ): Promise<AgentChatAcceptCrossMachineHandoffResult> => {
    const address = capsule.returnTo;
    const refuse = (reason: CrossMachineReturnRefusalReason, message: string): never => {
      logger.warn("agent_chat.cross_machine_return_refused", { handoffId, reason });
      throw new CrossMachineHandoffReturnRefusedError(reason, message);
    };
    if (!address) return refuse("return_address_invalid", "The return address is missing.");

    let receipt = readReturnReceipt(handoffId);
    if (receipt && receipt.capsuleFingerprint !== fingerprint) {
      return refuse("receipt_mismatch", "This return id is already bound to different handoff contents.");
    }
    if (receipt && (receipt.sessionId !== address.sessionId || receipt.laneId !== address.laneId)) {
      return refuse("receipt_mismatch", "This return id is already bound to a different original chat or lane.");
    }

    let transaction: CrossMachineHandoffRecord = priorRecord ?? {
      version: 1,
      handoffId,
      capsuleFingerprint: fingerprint,
      state: "preparing",
      laneId: null,
      sessionId: null,
      updatedAt: nowIso(),
      lastError: null,
    };
    persistHandoffRecord(transaction);
    const saveDestinationState = (
      state: CrossMachineHandoffRecord["state"],
      lastError: string | null = null,
    ): void => {
      transaction = {
        ...transaction,
        state,
        laneId: address.laneId,
        sessionId: address.sessionId,
        updatedAt: nowIso(),
        lastError,
      };
      persistHandoffRecord(transaction);
    };
    const receiptStep = (step: CrossMachineReturnStep): boolean =>
      Boolean(receipt && RETURN_STEPS.indexOf(receipt.state) >= RETURN_STEPS.indexOf(step));
    const saveReceipt = (state: CrossMachineReturnStep): void => {
      receipt = {
        version: 1,
        handoffId,
        capsuleFingerprint: fingerprint,
        sessionId: address.sessionId,
        laneId: address.laneId,
        state,
        updatedAt: nowIso(),
      };
      persistReturnReceipt(receipt);
    };
    const returned = (managed: TManaged): AgentChatAcceptCrossMachineHandoffResult => ({
      handoffId,
      laneId: address.laneId,
      session: managed.session,
      reusedLane: true,
      reusedSession: true,
      scheduledWorkIds: crossMachineScheduledWorkIds(capsule),
    });

    try {
      const localMachineKey = deps.localMachineKey();
      if (!localMachineKey || localMachineKey !== capsule.origin?.machineKey) {
        return refuse("return_address_invalid", "This machine does not match the saved origin machine.");
      }
      const originalRow = deps.chat.readChatRow(address.sessionId);
      if (!originalRow || originalRow.archivedAt) {
        return refuse("original_chat_missing", "The original chat is missing, archived, or is not owned by this project.");
      }
      const managed = deps.chat.tryManaged(address.sessionId);
      if (!managed) return refuse("original_chat_missing", "The original chat could not be loaded by this brain.");
      if (managed.session.laneId !== address.laneId || originalRow.laneId !== address.laneId) {
        return refuse("lane_mismatch", "The original chat no longer belongs to its recorded source lane.");
      }
      try {
        deps.chat.assertOwnedHere(address.sessionId, "accept cross-machine return");
      } catch (error) {
        return refuse("original_chat_missing", error instanceof Error ? error.message : "Another brain owns the original chat.");
      }
      const lane = await laneService.getSummary(address.laneId, { includeStatus: true });
      if (!lane || lane.archivedAt) {
        return refuse("original_lane_unavailable", "The original lane is unavailable or archived.");
      }
      const sourceBranch = capsule.source.branchRef.replace(/^refs\/heads\//, "");
      if (lane.branchRef.replace(/^refs\/heads\//, "") !== sourceBranch) {
        return refuse("lane_mismatch", "The returned work does not match the original lane's branch.");
      }

      const sourceMachineKey = capsule.source.machineKey?.trim() ?? "";
      const moveRecord = deps.chat.readMove(address.sessionId)?.record;
      const unlocked = receiptStep("unlocked");
      const alreadyReturned = receiptStep("transcript_appended")
        && moveRecord?.state === "returned"
        && moveRecord.handoffId === address.arrivalHandoffId;
      if (!unlocked && !alreadyReturned) {
        if (!moveRecord || moveRecord.state !== "continued" || moveRecord.resumedHere || moveRecord.handoffId !== address.arrivalHandoffId) {
          return refuse("move_not_continued", "The original chat is no longer continued on the machine that sent this return.");
        }
        if (
          !sourceMachineKey
          || moveRecord.targetMachineKey !== sourceMachineKey
          || moveRecord.targetSessionId !== capsule.source.sessionId
        ) return refuse("sender_mismatch", "The return came from a different machine or arrived chat than the original move.");
      }

      if (receiptStep("complete")) {
        saveDestinationState("complete");
        return returned(managed);
      }

      let destinationOrigin: string;
      let branchRef: string;
      try {
        destinationOrigin = await requireGitOutput(
          runGit,
          ["remote", "get-url", "origin"],
          deps.projectRoot,
          "The original project does not have a readable origin remote.",
        );
        branchRef = await requireGitBranch(runGit, capsule.source.branchRef, lane.worktreePath);
      } catch (error) {
        return refuse("lane_blocked", error instanceof Error ? error.message : String(error));
      }
      if (!isSameGitRepository(destinationOrigin, capsule.source.originUrl)) {
        return refuse("lane_mismatch", "The original project now points at a different Git repository.");
      }

      if (capsule.mode === "fork" && !receiptStep("provider_replaced")) {
        const targetDescriptor = getModelById(capsule.target.targetModelId)
          ?? resolveModelAlias(capsule.target.targetModelId);
        if (
          !capsule.forkTransport
          || !targetDescriptor
          || resolveProviderGroupForModel(targetDescriptor) !== managed.session.provider
          || capsule.source.provider !== managed.session.provider
          || capsule.forkTransport.provider !== managed.session.provider
        ) {
          return refuse("provider_mismatch", "The returned provider history cannot resume the original chat's provider.");
        }
      }

      if (!receiptStep("lane_ready")) {
        // The returned work never lands in this machine's primary checkout:
        // a bundle or a fast-forward would rewrite the person's own copy. One
        // already at the returned commit with nothing to apply is reused.
        if (lane.laneType === "primary") {
          let writes = Boolean(capsule.gitBundle);
          if (!writes) {
            const primaryHead = await runGit(["rev-parse", "HEAD"], { cwd: lane.worktreePath, timeoutMs: 8_000 });
            writes = primaryHead.exitCode !== 0 || primaryHead.stdout.trim() !== capsule.source.headSha;
          }
          if (writes) {
            return refuse(
              "original_lane_primary",
              `The original chat's lane is this machine's primary checkout ('${lane.name}'), and ADE never writes moved work into it`,
            );
          }
        }
        const syncLane = (): Promise<void> => syncExistingLaneToHandoff({
          lane,
          branchRef,
          headSha: capsule.source.headSha,
          gitBundle: capsule.gitBundle,
          handoffId,
          source: { laneName: capsule.source.laneName, machineName: capsule.source.machineName },
        });
        try {
          if (capsule.batchMove) {
            const laneImport = readLaneImport(capsule.batchMove.laneImportId);
            if (
              laneImport?.state !== "complete"
              || laneImport.laneId !== lane.id
              || laneImport.carriedChanges !== capsule.batchMove.carriedChanges
              || laneImport.snapshotSha !== capsule.batchMove.snapshotSha
            ) {
              return refuse("lane_blocked", "The original batch lane has not completed its return step.");
            }
            if (capsule.gitBundle) {
              // The lane item landed this bundle first. Reapplying is safe and
              // verifies nobody changed the lane between the lane and chat items.
              await syncLane();
            } else {
              const status = await runGit(["status", "--porcelain=v1"], { cwd: lane.worktreePath, timeoutMs: 15_000 });
              const head = await requireGitOutput(runGit, ["rev-parse", "HEAD"], lane.worktreePath, "The original batch lane commit could not be read.");
              if (status.exitCode !== 0 || status.stdout.trim() || head !== capsule.source.headSha) {
                return refuse("lane_blocked", "The original batch lane changed after its return step completed.");
              }
            }
          } else {
            await syncLane();
          }
        } catch (error) {
          if (error instanceof CrossMachineHandoffReturnRefusedError) throw error;
          return refuse("lane_blocked", error instanceof Error ? error.message : String(error));
        }
        saveDestinationState("lane_ready");
        saveReceipt("lane_ready");
      }

      if (!receiptStep("provider_replaced")) {
        if (capsule.mode === "fork") {
          await deps.chat.materializeFork({
            capsule,
            handoffId,
            destinationLanePath: lane.worktreePath,
            managed,
          });
          deps.chat.persist(managed);
        }
        saveDestinationState("chat_ready");
        saveReceipt("provider_replaced");
      }

      if (!receiptStep("transcript_appended")) {
        if (capsule.mode === "fork") {
          await appendMissingEvents(
            managed,
            handoffId,
            capsule.source.sessionId,
            deps.chat.parseTranscriptEnvelopes(capsule, address.sessionId),
          );
          deps.chat.persist(managed);
        }
        saveDestinationState("dispatched");
        saveReceipt("transcript_appended");
      }

      if (!receiptStep("unlocked")) {
        const latestMove = deps.chat.readMove(address.sessionId);
        if (
          latestMove?.record.handoffId === address.arrivalHandoffId
          && latestMove.record.state === "continued"
          && !latestMove.record.resumedHere
        ) {
          deps.chat.writeMove(address.sessionId, {
            ...latestMove,
            record: {
              ...latestMove.record,
              state: "returned",
              checkpoint: "marked",
              targetLaneId: null,
              targetSessionId: null,
              continuedOn: null,
              reason: null,
              updatedAt: nowIso(),
            },
          });
        }
        await recreateScheduledWork(capsule, address.sessionId);

        const returnPrompt = capsule.mode === "brief"
          ? [
              `This chat is back from ${capsule.source.machineName}. Continue the original work from this brief.`,
              "## Return brief",
              capsule.brief,
              "## User continuation instruction",
              capsule.continuationPrompt,
            ].join("\n\n")
          : capsule.continuationPrompt !== CROSS_MACHINE_HANDOFF_DEFAULT_PROMPT
            ? capsule.continuationPrompt.trim()
            : "";
        if (returnPrompt) {
          const alreadyPrompted = deps.chat.readTranscript(managed).some((envelope) =>
            envelope.event.type === "user_message"
            && envelope.event.metadata?.crossMachineReturnHandoffId === handoffId,
          );
          if (!alreadyPrompted) {
            await deps.chat.sendMessage({
              sessionId: address.sessionId,
              text: returnPrompt,
              displayText: returnPrompt,
              metadata: {
                kind: "cross_machine_handoff_return",
                crossMachineReturnHandoffId: handoffId,
                crossMachineHandoffId: handoffId,
              },
              reasoningEffort: managed.session.reasoningEffort,
              executionMode: managed.session.executionMode ?? null,
              interactionMode: managed.session.interactionMode ?? null,
            }, { awaitBackendDispatch: true });
          }
        }

        const hasReturnNotice = deps.chat.readTranscript(managed).some((envelope) => {
          if (envelope.event.type !== "system_notice" || envelope.event.status !== "cross_machine_handoff_returned") return false;
          const detail = envelope.event.detail as Record<string, unknown> | null | undefined;
          const returnDetail = detail?.crossMachineHandoffReturn as Record<string, unknown> | null | undefined;
          return returnDetail?.handoffId === handoffId;
        });
        if (!hasReturnNotice) {
          deps.chat.emitEvent(managed, {
            type: "system_notice",
            noticeKind: "info",
            status: "cross_machine_handoff_returned",
            message: `Back from ${capsule.source.machineName}`,
            detail: { crossMachineHandoffReturn: { handoffId, sourceMachineName: capsule.source.machineName } },
          });
          deps.chat.persist(managed);
        }
        saveDestinationState("dispatched");
        saveReceipt("unlocked");
      }

      saveDestinationState("complete");
      saveReceipt("complete");
      return returned(managed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (transaction.state !== "complete" && transaction.state !== "dispatched") {
        saveDestinationState("failed", reason);
      }
      if (!(error instanceof CrossMachineHandoffReturnRefusedError)) {
        logger.warn("agent_chat.cross_machine_return_accept_failed", {
          handoffId,
          state: transaction.state,
          error: reason,
        });
      }
      throw error;
    }
  };

  return {
    readHandoffRecord,
    persistHandoffRecord,
    readLaneOrigin,
    readLaneImport,
    importLane,
    buildBatchArrivalPrompt,
    recreateScheduledWork,
    appendMissingEvents,
    acceptReturn,
  };
}
