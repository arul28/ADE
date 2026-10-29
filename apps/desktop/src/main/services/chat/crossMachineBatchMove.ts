/**
 * Batch moves: several Work chats and the lanes they live on, moved to one
 * machine, each chat after its parent chat. Driven from the source brain by the
 * orchestrator (crossMachineHandoffOrchestrator.ts), which owns each chat's
 * own move; a batch record only orders those moves and imports the lanes
 * they need first.
 *
 * - Lanes arrive before any chat on them; a chat arrives after its parent
 *   chat when both are selected.
 * - A lane import's payload is kept in the outbox before it is sent, so a
 *   retry resends exactly what may already be there; the destination dedupes
 *   by import id. A chat item's move is an ordinary move under a batch-derived
 *   handoff id, with its own capsule outbox.
 * - A failed or unknown item is never replayed on its own: only `retryBatch`
 *   (the person asking) retries it.
 * - An agent batch that includes any chat unrelated to the requesting chat
 *   waits for one approval on the requesting chat.
 */
import { randomUUID } from "node:crypto";
import { crossMachineDestinationSessionId } from "../../../shared/deterministicChatSessionId";
import {
  crossMachineMoveRelation,
  decodeCrossMachineLaneImportResult,
  isCrossMachineHandoffActive,
} from "../../../shared/crossMachineHandoff";
import { crossMachineMoveLock, MovedAwayChatError } from "../../../shared/crossMachineMoveLock";
import type {
  AgentChatCrossMachineArrival,
  AgentChatCrossMachineBatchMoveApproval,
  AgentChatCrossMachineBatchMoveArgs,
  AgentChatCrossMachineBatchMoveChatItem,
  AgentChatCrossMachineBatchMoveContext,
  AgentChatCrossMachineBatchMoveItem,
  AgentChatCrossMachineBatchMoveItemState,
  AgentChatCrossMachineBatchMoveLaneItem,
  AgentChatCrossMachineBatchMoveRecord,
  AgentChatCrossMachineDestinationPreflightResult,
  AgentChatCrossMachineHandoffOrigin,
  AgentChatCrossMachineHandoffRecord,
  AgentChatCrossMachineHandoffState,
  AgentChatCrossMachineLaneImportArgs,
  AgentChatCrossMachineLaneSetupStatus,
  AgentChatStartCrossMachineHandoffArgs,
  AgentChatSpawnKind,
} from "../../../shared/types";
import type {
  CrossMachineHandoffMachine,
  CrossMachineHandoffOutbox,
  CrossMachineHandoffPersisted,
  CrossMachineHandoffSource,
  CrossMachineHandoffTransport,
  CrossMachineMovableSource,
  CrossMachineMoveCaller,
  CrossMachineSourceInspection,
} from "./crossMachineHandoffOrchestrator";

export type CrossMachineBatchChat = {
  sessionId: string;
  laneId: string;
  parentSessionId: string | null;
  spawnKind: AgentChatSpawnKind;
  isWorkChat: boolean;
  turnActive: boolean;
  awaitingInput: boolean;
  permissionLevel: string | null;
  provider: string;
  model: string;
  modelId?: string | null;
  title: string | null;
  crossMachineOrigin?: AgentChatCrossMachineHandoffOrigin | null;
  crossMachineArrival?: AgentChatCrossMachineArrival | null;
};

export type CrossMachineBatchLane = {
  laneId: string;
  name: string;
  branchRef: string;
  originMachineKey?: string | null;
  originLaneId?: string | null;
};

/** Who started a batch: the person, or an agent from its own chat. */
export type CrossMachineBatchMoveCaller = {
  requestedBy: "user" | "agent";
  requestingSessionId?: string | null;
};

/** The batch approval card's words; the host only emits it. The buttons live above the composer. */
export type CrossMachineBatchMoveApprovalCard = {
  cardId: string;
  batchId: string;
  live: boolean;
  title: string;
  subtitle: string | null;
  rows: Array<{ text: string; detail: string | null }>;
  fallbackText: string;
};

/** What the source runtime provides for batches; a runtime without it refuses them. */
export type CrossMachineBatchMoveDeps = {
  readBatch: (batchId: string) => AgentChatCrossMachineBatchMoveRecord | null;
  /** Null drops the record. */
  writeBatch: (batchId: string, value: AgentChatCrossMachineBatchMoveRecord | null) => void;
  /** Every batch record (a full storage scan): the startup sweep only. */
  listBatches: () => AgentChatCrossMachineBatchMoveRecord[];
  /** Batches that may still have work to run, from an in-memory index. */
  listOpenBatches: () => AgentChatCrossMachineBatchMoveRecord[];
  listBatchChats: () => Promise<CrossMachineBatchChat[]>;
  listBatchLanes: () => Promise<CrossMachineBatchLane[]>;
  inspectBatchLane: (laneId: string) => Promise<CrossMachineSourceInspection>;
  prepareBatchLane: (args: {
    importId: string;
    lane: CrossMachineBatchLane;
    returnToLaneId?: string;
    includeChanges: boolean;
  }) => Promise<AgentChatCrossMachineLaneImportArgs>;
  validateBatchLane: (payload: AgentChatCrossMachineLaneImportArgs) => Promise<void>;
  interruptBatchChat: (sessionId: string) => Promise<void>;
  /** The record of an agent batch's request on its requesting chat, live or settled. */
  showBatchApprovalCard: (sessionId: string, card: CrossMachineBatchMoveApprovalCard) => void;
};

/** What the batch engine uses of the single-move orchestrator. */
export type CrossMachineBatchMoveHook = {
  getSource: (sessionId: string) => CrossMachineHandoffSource | null;
  readPersisted: (sessionId: string) => CrossMachineHandoffPersisted | null;
  inspectSource: (sessionId: string) => Promise<CrossMachineSourceInspection>;
  outbox: CrossMachineHandoffOutbox;
  logger: {
    info(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
  };
  now: () => string;
  nowMs: () => number;
  laterThan: (previous: string) => string;
  requireTransport: () => CrossMachineHandoffTransport;
  resolveMachine: (selector: string) => Promise<CrossMachineHandoffMachine>;
  callPreflight: (
    transport: CrossMachineHandoffTransport,
    input: { machine: string; originUrl: string; args: Record<string, unknown> },
  ) => Promise<AgentChatCrossMachineDestinationPreflightResult>;
  /** Sends one lane import to the destination; its answer, unwrapped from the transport envelope. */
  importLane: (
    transport: CrossMachineHandoffTransport,
    machine: string,
    payload: AgentChatCrossMachineLaneImportArgs,
  ) => Promise<unknown>;
  isLostAnswer: (transport: CrossMachineHandoffTransport, error: unknown) => boolean;
  /** The inspection's branch, commit and origin, or the refusal naming `label` (orchestrator's `requireMovable`). */
  requireMovable: (
    inspection: CrossMachineSourceInspection,
    options: { includeChanges: boolean; label: string },
  ) => CrossMachineMovableSource;
  /** The person denied an agent's move of this chat within the cooldown. */
  declinedRecently: (sessionId: string) => boolean;
  noteDeclined: (sessionId: string, atMs: number) => void;
  mayHaveLanded: (record: AgentChatCrossMachineHandoffRecord | null | undefined) => boolean;
  start: (
    args: AgentChatStartCrossMachineHandoffArgs,
    caller: CrossMachineMoveCaller,
    batchOptions: { handoffId: string; batchMove: AgentChatCrossMachineBatchMoveContext; approvedByPerson: boolean },
  ) => Promise<AgentChatCrossMachineHandoffRecord>;
  run: (sessionId: string) => Promise<void>;
  retry: (sessionId: string) => Promise<AgentChatCrossMachineHandoffRecord>;
  onTurnSettled: (sessionId: string) => void;
};

/** Settled batch records are kept this long for `--status`, then pruned at startup. */
const SETTLED_BATCH_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Transcript card id of a batch's approval record (one per batch). */
const BATCH_APPROVAL_CARD_PREFIX = "cross-machine-batch-move-approval:";

/** Item states that end a branch: its dependents are blocked, and only a retry runs it again. */
const BATCH_ITEM_FAILURE_STATES: ReadonlySet<AgentChatCrossMachineBatchMoveItemState> = new Set([
  "cancelled",
  "failed",
  "unknown",
  "blocked",
]);

/** Item states that still have something to do. */
const BATCH_ITEM_WAITING_STATES: ReadonlySet<AgentChatCrossMachineBatchMoveItemState> = new Set([
  "pending",
  "sending",
  "awaiting_approval",
]);

type BatchItemPatch = {
  state?: AgentChatCrossMachineBatchMoveItemState;
  error?: string | null;
  destinationLaneId?: string | null;
  destinationSessionId?: string | null;
  carriedChanges?: boolean;
  snapshotSha?: string | null;
  laneSetupStatus?: AgentChatCrossMachineLaneSetupStatus;
  warning?: string | null;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const laneItemId = (laneId: string): string => `lane:${laneId}`;
const chatItemId = (sessionId: string): string => `chat:${sessionId}`;

/** The batch item state a chat item takes from its move's state. */
function batchItemStateForMove(state: AgentChatCrossMachineHandoffState): AgentChatCrossMachineBatchMoveItemState {
  switch (state) {
    case "continued":
    case "cancelled":
    case "failed":
    case "unknown":
    case "awaiting_approval":
      return state;
    default:
      return "pending";
  }
}

/** The chats an agent batch asks the person about, as every client shows them. */
export function crossMachineBatchMoveApproval(
  record: AgentChatCrossMachineBatchMoveRecord,
): AgentChatCrossMachineBatchMoveApproval {
  return {
    batchId: record.batchId,
    machineName: record.machineName,
    laneCount: record.items.filter((item) => item.kind === "lane").length,
    chats: record.items
      .filter((item): item is AgentChatCrossMachineBatchMoveChatItem => item.kind === "chat")
      .map((item) => ({ sessionId: item.sourceSessionId, title: item.sourceChatTitle?.trim() || null })),
  };
}

function crossMachineBatchMoveApprovalCard(
  record: AgentChatCrossMachineBatchMoveRecord,
  live: boolean,
): CrossMachineBatchMoveApprovalCard {
  const { chats, laneCount = 0 } = crossMachineBatchMoveApproval(record);
  const titles = chats.map((chat) => chat.title ?? chat.sessionId);
  const list = titles.map((title) => `• ${title}`).join("\n");
  const count = chats.length;
  const noun = count === 1 ? "chat" : "chats";
  const laneDetail = laneCount > 0 ? ` This batch also imports ${laneCount} ${laneCount === 1 ? "lane" : "lanes"}.` : "";
  const title = live
    ? `An agent wants to move ${count} ${noun} to ${record.machineName}`
    : "Batch move request answered";
  const subtitle = live
    ? `Approve or deny the whole batch above the composer. Each chat keeps its own permission level.${laneDetail}`
    : null;
  const fallbackText = live
    ? `${title}. Each chat keeps its own permission level.${laneDetail}\n${list}\nApprove or deny the whole batch above the composer.`
    : "The batch move request was answered.";
  return {
    cardId: `${BATCH_APPROVAL_CARD_PREFIX}${record.batchId}`,
    batchId: record.batchId,
    live,
    title,
    subtitle,
    rows: live ? chats.map((chat) => ({ text: chat.title ?? chat.sessionId, detail: chat.sessionId })) : [],
    fallbackText,
  };
}

/**
 * `items` in an order where each one comes after its parent, when the parent
 * is also in `items`. Throws `cycleMessage` when the parents form a cycle.
 */
function orderParentsFirst<T>(
  items: readonly T[],
  id: (item: T) => string,
  parentId: (item: T) => string | null,
  cycleMessage: string,
): T[] {
  const selected = new Set(items.map(id));
  const remaining = new Set(selected);
  const ordered: T[] = [];
  while (remaining.size) {
    const ready = items.filter((item) => {
      if (!remaining.has(id(item))) return false;
      const parent = parentId(item);
      return !parent || !selected.has(parent) || !remaining.has(parent);
    });
    if (!ready.length) throw new Error(cycleMessage);
    for (const item of ready) {
      ordered.push(item);
      remaining.delete(id(item));
    }
  }
  return ordered;
}

/** Nothing left to run: finished, declined, or every item at rest. */
export function isCrossMachineBatchSettled(batch: AgentChatCrossMachineBatchMoveRecord): boolean {
  return batch.state === "completed"
    || batch.state === "cancelled"
    || (batch.state === "partial" && !batch.items.some((item) => BATCH_ITEM_WAITING_STATES.has(item.state)));
}

export function createCrossMachineBatchMoves({ batch: deps, moves }: {
  batch: CrossMachineBatchMoveDeps;
  moves: CrossMachineBatchMoveHook;
}) {
  const batchRuns = new Map<string, Promise<void>>();
  const batchRunAgain = new Set<string>();

  const writeBatch = (
    batchId: string,
    record: AgentChatCrossMachineBatchMoveRecord,
  ): AgentChatCrossMachineBatchMoveRecord => {
    const next = { ...record, updatedAt: moves.laterThan(record.updatedAt) };
    deps.writeBatch(batchId, next);
    return next;
  };

  const updateBatchItem = (
    batchId: string,
    itemId: string,
    patch: BatchItemPatch,
  ): AgentChatCrossMachineBatchMoveRecord | null => {
    const record = deps.readBatch(batchId);
    if (!record) return null;
    const items = record.items.map((item) => item.id === itemId
      // The patch only sets fields of the item's own kind (the callers patch
      // a lane item with lane fields and a chat item with chat fields).
      ? { ...item, ...patch, updatedAt: moves.laterThan(item.updatedAt) } as AgentChatCrossMachineBatchMoveItem
      : item);
    return writeBatch(batchId, { ...record, items });
  };

  const warnBatchItemFailure = (batchId: string, itemId: string, operation: string, error: unknown): void => {
    moves.logger.warn("agent_chat.cross_machine_batch_item_recovered_error", {
      batchId,
      itemId,
      operation,
      error: errorText(error),
    });
  };

  /** A chat item takes its move's state (or `pending` when its move is gone). */
  const syncItemFromMove = (
    batchId: string,
    item: AgentChatCrossMachineBatchMoveChatItem,
    record: AgentChatCrossMachineHandoffRecord | null,
  ): void => {
    if (!record) {
      updateBatchItem(batchId, item.id, { state: "pending" });
      return;
    }
    updateBatchItem(batchId, item.id, {
      state: batchItemStateForMove(record.state),
      destinationLaneId: record.targetLaneId,
      destinationSessionId: record.targetSessionId ?? crossMachineDestinationSessionId(item.handoffId),
      error: record.reason,
    });
  };

  /** The chat's move, while it is still this item's move. */
  const itemMove = (item: AgentChatCrossMachineBatchMoveChatItem): AgentChatCrossMachineHandoffRecord | null => {
    const current = moves.readPersisted(item.sourceSessionId);
    return current && current.record.handoffId === item.handoffId ? current.record : null;
  };

  const dependenciesReady = (
    record: AgentChatCrossMachineBatchMoveRecord,
    item: AgentChatCrossMachineBatchMoveItem,
  ): "ready" | "waiting" | "blocked" => {
    const byId = new Map(record.items.map((candidate) => [candidate.id, candidate]));
    for (const dependencyId of item.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency || BATCH_ITEM_FAILURE_STATES.has(dependency.state)) return "blocked";
      if (dependency.state !== "continued") return "waiting";
    }
    return "ready";
  };

  const findLaneItem = (
    record: AgentChatCrossMachineBatchMoveRecord,
    laneId: string,
  ): AgentChatCrossMachineBatchMoveLaneItem | null => {
    const item = record.items.find((candidate) => candidate.id === laneItemId(laneId));
    return item?.kind === "lane" ? item : null;
  };

  const start = async (
    input: AgentChatCrossMachineBatchMoveArgs,
    caller: CrossMachineBatchMoveCaller,
  ): Promise<AgentChatCrossMachineBatchMoveRecord> => {
    const selector = input.machine?.trim();
    if (!selector) throw new Error("A destination machine is required.");
    const note = input.note?.trim() || null;
    if (note && note.length > 4_000) throw new Error("Keep the batch continuation note under 4,000 characters.");
    if (input.allWorkOnThisMachine === true && (input.sessionIds?.length ?? 0) > 0) {
      throw new Error("Choose --all or explicit chat ids, not both.");
    }
    const selectedIds = (input.sessionIds ?? []).map((id) => id.trim()).filter(Boolean);
    if (!input.allWorkOnThisMachine && selectedIds.length === 0) {
      throw new Error("Choose --all or at least one Work chat id.");
    }

    const allChats = await deps.listBatchChats();
    // A chat that already continues on another machine (and the person has
    // not chosen "Work here instead") is the other machine's now: moving it
    // again would leave two live copies. `--all` and descendants skip it; a
    // chat named explicitly is refused with the destination it continues on.
    const movedAway = (sessionId: string) => crossMachineMoveLock(moves.readPersisted(sessionId)?.record);
    for (const id of selectedIds) {
      const lock = movedAway(id);
      if (lock) throw new MovedAwayChatError(id, lock);
    }
    const eligible = allChats.filter((chat) => chat.isWorkChat && !movedAway(chat.sessionId));
    if (input.allWorkOnThisMachine === true && eligible.length === 0) {
      throw new Error("There are no active Work chats on this project to move.");
    }
    const bySession = new Map(eligible.map((chat) => [chat.sessionId, chat]));
    const lineageBySession = new Map(allChats.map((chat) => [chat.sessionId, chat]));
    const selected = new Set(input.allWorkOnThisMachine
      ? eligible.map((chat) => chat.sessionId)
      : selectedIds);
    const missing = [...selected].filter((id) => !bySession.has(id));
    if (missing.length) throw new Error(`These chats are not active Work chats on this project: ${missing.join(", ")}.`);

    if (input.includeDescendants !== false) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const chat of eligible) {
          if (chat.parentSessionId && selected.has(chat.parentSessionId) && !selected.has(chat.sessionId)) {
            selected.add(chat.sessionId);
            changed = true;
          }
        }
      }
    }
    const orderedChats = orderParentsFirst(
      eligible.filter((chat) => selected.has(chat.sessionId)),
      (chat) => chat.sessionId,
      (chat) => chat.parentSessionId,
      "The selected chat tree contains a parent cycle and can't be moved.",
    );
    for (const chat of orderedChats) {
      if (chat.awaitingInput) throw new Error(`Resolve the pending approval or question in '${chat.title ?? chat.sessionId}' before moving the batch.`);
    }
    const requestedBy = caller.requestedBy === "user" ? "user" : "agent";
    const requestingSessionId = caller.requestingSessionId?.trim() || null;
    if (requestedBy === "agent") {
      for (const chat of orderedChats) {
        if (moves.declinedRecently(chat.sessionId)) {
          throw new Error(
            `The person just declined moving '${chat.title ?? chat.sessionId}'. Don't ask again for a couple of minutes; ask them in the chat if it matters.`,
          );
        }
      }
    }

    const lanes = await deps.listBatchLanes();
    const lanesById = new Map(lanes.map((lane) => [lane.laneId, lane]));
    const selectedLaneIds = new Set<string>();
    for (const chat of orderedChats) {
      if (!lanesById.has(chat.laneId)) throw new Error(`The source lane '${chat.laneId}' could not be loaded.`);
      selectedLaneIds.add(chat.laneId);
    }
    const orderedLanes = lanes.filter((lane) => selectedLaneIds.has(lane.laneId));

    const machine = await moves.resolveMachine(selector);
    const transport = moves.requireTransport();
    const includeChanges = input.includeChanges !== false;
    const requestedMode = input.mode === "brief" ? "brief" : "fork";
    const laneInspections = new Map<string, { movable: CrossMachineMovableSource; hasChanges: boolean }>();
    for (const lane of orderedLanes) {
      const inspection = await deps.inspectBatchLane(lane.laneId);
      const movable = moves.requireMovable(inspection, { includeChanges, label: `Lane '${lane.name}'` });
      laneInspections.set(lane.laneId, { movable, hasChanges: inspection.changes !== null });
    }

    const batchId = randomUUID();
    const laneImportId = (laneId: string): string => `${batchId}:lane:${laneId}`;
    const chosenModes = new Map<string, { mode: "brief" | "fork"; fallbackReason: string | null }>();
    // The origin already refused to continue this chat's original there: it
    // moves as a new chat (prepare omits the return), so it is no return here.
    const returnRefusedThere = (sessionId: string): boolean =>
      moves.readPersisted(sessionId)?.record.returnRefused?.machineKey === machine.machineKey;
    for (const chat of orderedChats) {
      const origin = chat.crossMachineOrigin?.machineKey === machine.machineKey && !returnRefusedThere(chat.sessionId)
        ? chat.crossMachineOrigin
        : null;
      if (origin && (!chat.crossMachineArrival || chat.crossMachineArrival.originSessionId !== origin.sessionId)) {
        throw new Error(`Chat '${chat.title ?? chat.sessionId}' is missing its original transcript boundary and cannot return safely.`);
      }
      const inspection = await moves.inspectSource(chat.sessionId);
      const { originUrl, branchRef, headSha } = moves.requireMovable(inspection, {
        includeChanges,
        label: `Chat '${chat.title ?? chat.sessionId}'`,
      });
      const targetModelId = chat.modelId?.trim() || chat.model.trim();
      if (!targetModelId) throw new Error(`Chat '${chat.title ?? chat.sessionId}' has no model to continue with.`);
      const hasBundle = includeChanges && inspection.changes !== null;
      let mode: "brief" | "fork" = requestedMode;
      let fallbackReason: string | null = null;
      const makePreflightArgs = (candidateMode: "brief" | "fork") => ({
        targetModelId,
        sourceBranchRef: branchRef,
        sourceHeadSha: headSha,
        mode: candidateMode,
        sourceProvider: chat.provider,
        requireBatchMoveSupport: true,
        batchLaneImportId: laneImportId(chat.laneId),
        ...(origin ? { returnToLaneId: origin.laneId } : {}),
        ...(hasBundle ? { hasGitBundle: true } : {}),
      });
      let preflight = await moves.callPreflight(transport, {
        machine: machine.machineKey,
        originUrl,
        args: makePreflightArgs(mode),
      });
      if (preflight.batchMoveSupport !== 1) {
        throw new Error(`${machine.name} needs an ADE update to preserve batch lane trees, chat parents, scheduled work, and arrival instructions.`);
      }
      if (hasBundle && preflight.gitBundleSupport !== true) {
        throw new Error(`${machine.name} needs an ADE update to take uncommitted changes. Update it, or move without them.`);
      }
      if (mode === "fork" && preflight.forkHandoffSupport?.supported === false) {
        fallbackReason = preflight.forkHandoffSupport.reason ?? "This provider cannot move its full history between machines.";
        mode = "brief";
        preflight = await moves.callPreflight(transport, {
          machine: machine.machineKey,
          originUrl,
          args: makePreflightArgs(mode),
        });
      } else if (mode === "fork" && preflight.forkHandoffSupport?.supported !== true) {
        throw new Error(`${machine.name} needs an ADE update to check whether this chat can move as a fork.`);
      }
      if (preflight.blockingErrors.length) {
        throw new Error(`Chat '${chat.title ?? chat.sessionId}': ${preflight.blockingErrors.join(" ")}`);
      }
      chosenModes.set(chat.sessionId, { mode, fallbackReason });
    }

    const modelForLanePreflight = orderedChats[0]?.modelId?.trim() || orderedChats[0]?.model.trim();
    if (!modelForLanePreflight) throw new Error("The batch has no chat model to use for lane preflight.");
    const chattedLaneIds = new Set(orderedChats.map((chat) => chat.laneId));
    for (const lane of orderedLanes) {
      if (chattedLaneIds.has(lane.laneId)) continue;
      const inspected = laneInspections.get(lane.laneId);
      if (!inspected) throw new Error(`The source lane '${lane.name}' was not inspected.`);
      const { movable } = inspected;
      const hasBundle = includeChanges && inspected.hasChanges;
      const preflight = await moves.callPreflight(transport, {
        machine: machine.machineKey,
        originUrl: movable.originUrl,
        args: {
          targetModelId: modelForLanePreflight,
          sourceBranchRef: movable.branchRef,
          sourceHeadSha: movable.headSha,
          mode: "brief",
          requireBatchMoveSupport: true,
          batchLaneImportId: laneImportId(lane.laneId),
          ...(lane.originMachineKey === machine.machineKey && lane.originLaneId
            ? { returnToLaneId: lane.originLaneId }
            : {}),
          ...(hasBundle ? { hasGitBundle: true } : {}),
        },
      });
      if (preflight.batchMoveSupport !== 1) {
        throw new Error(`${machine.name} needs an ADE update to preserve the selected lane tree.`);
      }
      if (hasBundle && preflight.gitBundleSupport !== true) {
        throw new Error(`${machine.name} needs an ADE update to take changes from lane '${lane.name}'.`);
      }
      if (preflight.blockingErrors.length) {
        throw new Error(`Lane '${lane.name}': ${preflight.blockingErrors.join(" ")}`);
      }
    }

    const returnLaneBySourceLane = new Map<string, string>();
    for (const lane of orderedLanes) {
      if (lane.originMachineKey === machine.machineKey && lane.originLaneId) {
        returnLaneBySourceLane.set(lane.laneId, lane.originLaneId);
        continue;
      }
      const laneChats = orderedChats.filter((chat) => chat.laneId === lane.laneId);
      const originalLaneIds = laneChats.map((chat) => {
        if (
          chat.crossMachineOrigin?.machineKey !== machine.machineKey
          || chat.crossMachineArrival?.originSessionId !== chat.crossMachineOrigin.sessionId
          || returnRefusedThere(chat.sessionId)
        ) return null;
        return chat.crossMachineOrigin.laneId;
      });
      const uniqueOriginalLanes = new Set(originalLaneIds.filter((id): id is string => id !== null));
      const [onlyOriginalLane] = uniqueOriginalLanes;
      if (laneChats.length && originalLaneIds.every(Boolean) && uniqueOriginalLanes.size === 1 && onlyOriginalLane) {
        returnLaneBySourceLane.set(lane.laneId, onlyOriginalLane);
      }
    }
    const laneItems: AgentChatCrossMachineBatchMoveLaneItem[] = orderedLanes.map((lane) => {
      const returnLaneId = returnLaneBySourceLane.get(lane.laneId);
      return {
        id: laneItemId(lane.laneId),
        kind: "lane",
        state: "pending",
        dependsOn: [],
        sourceLaneId: lane.laneId,
        importId: laneImportId(lane.laneId),
        ...(returnLaneId ? { returnToLaneId: returnLaneId } : {}),
        updatedAt: moves.now(),
      };
    });
    const orderedChatIds = new Set(orderedChats.map((chat) => chat.sessionId));
    const chatItems: AgentChatCrossMachineBatchMoveChatItem[] = orderedChats.map((chat) => {
      const requestedFor = requestedBy !== "agent"
        ? undefined
        : crossMachineMoveRelation(
            requestingSessionId,
            chat.sessionId,
            (sessionId) => lineageBySession.get(sessionId)?.parentSessionId,
          );
      const mode = chosenModes.get(chat.sessionId) ?? { mode: requestedMode, fallbackReason: null };
      const dependsOn = [laneItemId(chat.laneId)];
      if (chat.parentSessionId && orderedChatIds.has(chat.parentSessionId)) dependsOn.push(chatItemId(chat.parentSessionId));
      return {
        id: chatItemId(chat.sessionId),
        kind: "chat",
        state: "pending",
        dependsOn,
        sourceLaneId: chat.laneId,
        sourceSessionId: chat.sessionId,
        sourceChatTitle: chat.title,
        handoffId: `${batchId}:chat:${chat.sessionId}`,
        mode: mode.mode,
        requestedFor,
        modeFallbackReason: mode.fallbackReason,
        updatedAt: moves.now(),
      };
    });
    const needsBatchApproval = requestedBy === "agent"
      && chatItems.some((item) => item.requestedFor === "other");
    if (needsBatchApproval && !requestingSessionId) {
      throw new Error("An agent batch that includes another chat must be started from an ADE chat so the person can review it.");
    }
    for (const chat of allChats) {
      if (orderedChatIds.has(chat.sessionId) || !chat.parentSessionId || !orderedChatIds.has(chat.parentSessionId)) continue;
      moves.logger.warn("agent_chat.cross_machine_batch_parent_left_on_source", {
        batchId,
        parentSessionId: chat.parentSessionId,
        childSessionId: chat.sessionId,
      });
    }
    const requestedAt = moves.now();
    const record: AgentChatCrossMachineBatchMoveRecord = {
      batchId,
      state: needsBatchApproval ? "awaiting_approval" : "pending",
      machineKey: machine.machineKey,
      machineName: machine.name,
      requestedBy,
      requestingSessionId,
      ...(requestedBy === "agent" ? { approvedByPerson: false } : {}),
      requestedAt,
      updatedAt: requestedAt,
      includeChanges,
      whenBusy: input.whenBusy === "interrupt" ? "interrupt" : "wait",
      note,
      items: [...laneItems, ...chatItems],
    };
    writeBatch(batchId, record);
    if (needsBatchApproval && requestingSessionId) {
      deps.showBatchApprovalCard(requestingSessionId, crossMachineBatchMoveApprovalCard(record, true));
    } else {
      void runBatch(batchId);
    }
    return record;
  };

  const importLaneItem = async (
    batchId: string,
    item: AgentChatCrossMachineBatchMoveLaneItem,
    batch: AgentChatCrossMachineBatchMoveRecord,
  ): Promise<void> => {
    const lane = (await deps.listBatchLanes()).find((candidate) => candidate.laneId === item.sourceLaneId);
    if (!lane) throw new Error("Batch lane import is unavailable on this runtime.");
    const transport = moves.requireTransport();
    const importId = item.importId;
    let stored = moves.outbox.readLane(importId);
    if (stored && !stored.sent) {
      // Nothing left this machine with it: prepare it again from the lane as
      // it is now, so a lane that changed since cannot fail this item forever.
      moves.outbox.removeLane(importId);
      stored = null;
    }
    let payload: AgentChatCrossMachineLaneImportArgs;
    if (stored) {
      // It may already be there: resend exactly what was sent. The
      // destination answers from its record for this import id.
      payload = stored.payload;
    } else {
      payload = await deps.prepareBatchLane({
        importId,
        lane,
        ...(item.returnToLaneId ? { returnToLaneId: item.returnToLaneId } : {}),
        includeChanges: batch.includeChanges,
      });
      await deps.validateBatchLane(payload);
    }
    updateBatchItem(batchId, item.id, { state: "sending", error: null });
    // Durable before the request leaves: from here on a retry resends it.
    moves.outbox.writeLane(importId, { payload, sent: true });
    let answer: unknown;
    try {
      answer = await moves.importLane(transport, batch.machineKey, payload);
    } catch (error) {
      warnBatchItemFailure(batchId, item.id, "lane_import_transport", error);
      updateBatchItem(batchId, item.id, {
        state: moves.isLostAnswer(transport, error) ? "unknown" : "failed",
        error: errorText(error),
      });
      return;
    }
    let returned: ReturnType<typeof decodeCrossMachineLaneImportResult>;
    try {
      returned = decodeCrossMachineLaneImportResult(answer);
      if (returned.importId !== importId) throw new Error("The destination answered for a different lane import.");
    } catch (error) {
      // It answered, but not in a shape ADE can read: the lane may be there.
      // Keep the payload; a retry resends it and the destination reconciles.
      warnBatchItemFailure(batchId, item.id, "lane_import_response", error);
      updateBatchItem(batchId, item.id, {
        state: "unknown",
        error: `${batch.machineName} answered without readable lane import details (${errorText(error)}). Retry the batch to check again.`,
      });
      return;
    }
    updateBatchItem(batchId, item.id, {
      state: "continued",
      destinationLaneId: returned.laneId,
      carriedChanges: returned.carriedChanges,
      snapshotSha: returned.snapshotSha,
      ...(returned.setupStatus ? { laneSetupStatus: returned.setupStatus } : {}),
      warning: returned.warnings.join(" ") || null,
      error: null,
    });
    moves.outbox.removeLane(importId);
  };

  const moveChatItem = async (
    batchId: string,
    item: AgentChatCrossMachineBatchMoveChatItem,
    batch: AgentChatCrossMachineBatchMoveRecord,
  ): Promise<void> => {
    const sourceSessionId = item.sourceSessionId;
    const move = moves.readPersisted(sourceSessionId);
    if (move && move.record.handoffId === item.handoffId) {
      // A failed or unknown move is never replayed from here (a lost answer
      // must not resend on its own): the item takes its state, and only an
      // explicit `retryBatch` retries it.
      if (move.record.state === "sending") {
        await moves.run(sourceSessionId);
      } else if (move.record.state === "pending" && !moves.getSource(sourceSessionId)?.turnActive) {
        moves.onTurnSettled(sourceSessionId);
      }
      syncItemFromMove(batchId, item, itemMove(item));
      return;
    }

    // The chat moved (or is moving, or may have landed) on its own since the
    // batch was made. Starting this item would make a second copy there or
    // overwrite that move, so the batch leaves it.
    if (move && (crossMachineMoveLock(move.record) || isCrossMachineHandoffActive(move.record) || moves.mayHaveLanded(move.record))) {
      updateBatchItem(batchId, item.id, {
        state: "failed",
        error: crossMachineMoveLock(move.record)
          ? `This chat already continues on ${move.record.targetMachineName} from a separate move, so the batch left it.`
          : `This chat has a separate move to ${move.record.targetMachineName}, so the batch left it. Finish or dismiss that move, then retry the batch.`,
      });
      return;
    }
    if (!moves.getSource(sourceSessionId)) {
      updateBatchItem(batchId, item.id, { state: "failed", error: "The source chat could not be loaded." });
      return;
    }
    try {
      await startChatItemMove(batchId, item, batch);
    } catch (error) {
      warnBatchItemFailure(batchId, item.id, "chat_move_start", error);
      updateBatchItem(batchId, item.id, { state: "failed", error: errorText(error) });
    }
  };

  const startChatItemMove = async (
    batchId: string,
    item: AgentChatCrossMachineBatchMoveChatItem,
    batch: AgentChatCrossMachineBatchMoveRecord,
  ): Promise<void> => {
    const sourceSessionId = item.sourceSessionId;
    const laneItem = findLaneItem(batch, item.sourceLaneId);
    const lane = (await deps.listBatchLanes()).find((candidate) => candidate.laneId === item.sourceLaneId);
    if (!laneItem?.destinationLaneId || !lane) throw new Error("The destination lane was not imported before its chat.");
    const parentChatItem = item.dependsOn
      .map((id) => batch.items.find((candidate) => candidate.id === id))
      .find((candidate): candidate is AgentChatCrossMachineBatchMoveChatItem => candidate?.kind === "chat");
    const sourceChats = await deps.listBatchChats();
    const selectedChat = sourceChats.find((chat) => chat.sessionId === sourceSessionId);
    if (!selectedChat) throw new Error("The selected chat is no longer available for a batch move.");
    const batchMove: AgentChatCrossMachineBatchMoveContext = {
      batchId,
      laneImportId: laneItem.importId,
      destinationLaneId: laneItem.destinationLaneId,
      carriedChanges: laneItem.carriedChanges === true,
      snapshotSha: laneItem.snapshotSha ?? null,
      ...(batch.note ? { note: batch.note } : {}),
      ...(item.modeFallbackReason ? { modeFallbackReason: item.modeFallbackReason } : {}),
      // Older destinations read the key.
      sourceLane: { laneId: lane.laneId, parentLaneId: null, name: lane.name },
      ...(parentChatItem?.destinationSessionId
        ? {
            parentLink: {
              destinationParentSessionId: parentChatItem.destinationSessionId,
              spawnKind: selectedChat.spawnKind,
            },
          }
        : {}),
    };
    const record = await moves.start({
      sourceSessionId,
      machine: batch.machineKey,
      targetModelId: selectedChat.modelId?.trim() || selectedChat.model,
      mode: item.mode,
      includeChanges: batch.includeChanges,
      whenTurnEnds: true,
    }, {
      requestedBy: batch.requestedBy,
      ...(item.requestedFor ? { requestedFor: item.requestedFor } : {}),
      ...(batch.requestingSessionId ? { requestedBySessionId: batch.requestingSessionId } : {}),
    }, {
      handoffId: item.handoffId,
      approvedByPerson: batch.approvedByPerson === true,
      batchMove,
    });
    if (record.state === "sending") await moves.run(sourceSessionId);
    const current = itemMove(item);
    if (current) syncItemFromMove(batchId, item, current);
  };

  const runBatchOnce = async (batchId: string): Promise<void> => {
    const initialBatch = deps.readBatch(batchId);
    if (!initialBatch || initialBatch.state === "completed" || initialBatch.state === "cancelled" || initialBatch.state === "awaiting_approval") return;
    let batch = writeBatch(batchId, { ...initialBatch, state: "running" });
    if (batch.whenBusy === "interrupt") {
      for (const snapshot of batch.items) {
        const item = deps.readBatch(batchId)?.items.find((candidate) => candidate.id === snapshot.id);
        if (item?.kind !== "chat" || item.state !== "pending") continue;
        if (!moves.getSource(item.sourceSessionId)?.turnActive) continue;
        try {
          await deps.interruptBatchChat(item.sourceSessionId);
        } catch (error) {
          warnBatchItemFailure(batchId, item.id, "chat_interrupt", error);
          updateBatchItem(batchId, item.id, { state: "failed", error: errorText(error) });
        }
      }
    }
    for (const snapshot of batch.items) {
      const refreshedBatch = deps.readBatch(batchId);
      if (refreshedBatch) batch = refreshedBatch;
      const item = batch.items.find((candidate) => candidate.id === snapshot.id);
      if (!item || item.state === "continued" || BATCH_ITEM_FAILURE_STATES.has(item.state)) continue;
      const dependencyState = dependenciesReady(batch, item);
      if (dependencyState === "blocked") {
        updateBatchItem(batchId, item.id, { state: "blocked", error: "A required parent lane or chat did not arrive." });
        continue;
      }
      if (dependencyState === "waiting") continue;
      if (item.kind === "chat") {
        await moveChatItem(batchId, item, batch);
        continue;
      }
      try {
        await importLaneItem(batchId, item, batch);
      } catch (error) {
        warnBatchItemFailure(batchId, item.id, "lane_import_prepare", error);
        updateBatchItem(batchId, item.id, { state: "failed", error: errorText(error) });
      }
    }
    const latest = deps.readBatch(batchId);
    if (!latest) return;
    const hasWaiting = latest.items.some((item) => BATCH_ITEM_WAITING_STATES.has(item.state));
    const hasFailures = latest.items.some((item) => BATCH_ITEM_FAILURE_STATES.has(item.state));
    const state = latest.items.every((item) => item.state === "continued")
      ? "completed"
      : !hasWaiting && hasFailures ? "partial" : "pending";
    writeBatch(batchId, { ...latest, state });
  };

  const runBatch = (batchId: string): Promise<void> => {
    const existing = batchRuns.get(batchId);
    if (existing) {
      batchRunAgain.add(batchId);
      return existing;
    }
    const task = runBatchOnce(batchId).finally(() => {
      batchRuns.delete(batchId);
      if (batchRunAgain.delete(batchId)) void runBatch(batchId);
    });
    batchRuns.set(batchId, task);
    return task;
  };

  /** A chat's move run ended: every open batch holding that chat takes its next step. */
  const wakeForSession = (sessionId: string): void => {
    for (const batch of deps.listOpenBatches()) {
      if (batch.state === "completed" || batch.state === "cancelled" || batch.state === "awaiting_approval") continue;
      if (batch.items.some((item) => item.kind === "chat" && item.sourceSessionId === sessionId)) {
        void runBatch(batch.batchId);
      }
    }
  };

  /** Drop an old settled batch record and any lane payload it left behind. */
  const pruneBatch = (batch: AgentChatCrossMachineBatchMoveRecord): void => {
    for (const item of batch.items) {
      if (item.kind === "lane") moves.outbox.removeLane(item.importId);
    }
    deps.writeBatch(batch.batchId, null);
    moves.logger.info("agent_chat.cross_machine_batch_pruned", { batchId: batch.batchId, state: batch.state });
  };

  const get = (batchId: string): AgentChatCrossMachineBatchMoveRecord | null => deps.readBatch(batchId);

  const resolveApproval = (
    batchId: string,
    approve: boolean,
  ): AgentChatCrossMachineBatchMoveRecord => {
    const batch = deps.readBatch(batchId);
    if (!batch || batch.requestedBy !== "agent" || !batch.requestingSessionId) {
      throw new Error("That batch move is no longer waiting for approval.");
    }
    if (batch.state !== "awaiting_approval") return batch;
    deps.showBatchApprovalCard(batch.requestingSessionId, crossMachineBatchMoveApprovalCard(batch, false));
    if (!approve) {
      const deniedAt = moves.nowMs();
      for (const item of batch.items) {
        if (item.kind === "chat") moves.noteDeclined(item.sourceSessionId, deniedAt);
      }
      return writeBatch(batchId, {
        ...batch,
        state: "cancelled",
        items: batch.items.map((item) => item.state === "continued"
          ? item
          : { ...item, state: "cancelled", error: "The person declined the batch move." }),
      });
    }
    const approved = writeBatch(batchId, { ...batch, state: "pending", approvedByPerson: true });
    void runBatch(batchId);
    return approved;
  };

  const retry = async (batchId: string): Promise<AgentChatCrossMachineBatchMoveRecord> => {
    const batch = deps.readBatch(batchId);
    if (!batch) throw new Error("Batch move not found.");
    if (batch.state === "awaiting_approval") throw new Error("This batch is waiting for the person's approval.");
    if (batch.state === "cancelled") throw new Error("The person declined this batch move.");
    if (batch.state === "completed") return batch;
    // Reset all failed branches together. runBatch walks the durable dependency
    // order, so a child cannot be retried until its parent has arrived.
    for (const item of batch.items) {
      if (item.state === "failed" || item.state === "unknown" || item.state === "blocked") {
        updateBatchItem(batchId, item.id, { state: "pending", error: null });
      }
    }
    // The person asked to retry: only here may a failed or unknown chat move
    // be retried (same handoff id and, once sent, the same capsule).
    for (const item of batch.items) {
      if (item.kind !== "chat" || (item.state !== "failed" && item.state !== "unknown")) continue;
      const move = itemMove(item);
      if (!move || (move.state !== "failed" && move.state !== "unknown")) continue;
      try {
        await moves.retry(item.sourceSessionId);
      } catch (error) {
        warnBatchItemFailure(batchId, item.id, "chat_move_retry", error);
        updateBatchItem(batchId, item.id, { state: move.state, error: errorText(error) });
      }
    }
    const next = deps.readBatch(batchId) ?? batch;
    writeBatch(batchId, { ...next, state: "pending" });
    void runBatch(batchId);
    return deps.readBatch(batchId) ?? next;
  };

  /**
   * After a restart: per-chat outboxes keep each move idempotent, and batch
   * records only order those moves, so the same remaining items resume in
   * order. Old settled records are pruned.
   */
  const sweep = (): void => {
    const pruneBefore = moves.nowMs() - SETTLED_BATCH_RETENTION_MS;
    for (const batch of deps.listBatches()) {
      if (isCrossMachineBatchSettled(batch)) {
        const updatedMs = Date.parse(batch.updatedAt);
        if (Number.isFinite(updatedMs) && updatedMs < pruneBefore) pruneBatch(batch);
        continue;
      }
      if (batch.state !== "awaiting_approval") void runBatch(batch.batchId);
    }
  };

  return { start, get, retry, resolveApproval, wakeForSession, sweep };
}

export type CrossMachineBatchMoves = ReturnType<typeof createCrossMachineBatchMoves>;
