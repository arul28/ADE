import { cloudCatalogOf, type CloudCatalog } from "../../../shared/adeCloud";
import type { CloudApiClient } from "../../../shared/cloudApiClient";
import {
  CLOUD_LANE_SAVE_WARNING_DETAIL,
  cloudLaneJobStageIds,
  cloudTierRequestIdsOf,
  type CloudLaneJobPhase,
  type CloudLaneJobSnapshot,
  type CloudLaneJobStage,
  type CloudLaneJobStageId,
} from "../../../shared/cloudLaneLife";
import { cloudTier, isCloudTierId, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import type { CloudInstance, CloudMoveRecord } from "../../../../../account-directory/src/cloud/contract";
import { webTierRequestOf, type WebTierRequestInput, type WebTierRequestTeller } from "./cloudLaneLifeWeb";

/**
 * ADE Web's moves of a lane's computer to the other kind (Standard ↔ Full):
 * ADE's server runs them (`POST /cloud/instances/:id/move`, `moves.ts`), so
 * the web needs no computer of the person's. Each move reads as the desktop's
 * lane job (`CloudLaneJobSnapshot`), so the same cards show it. A size change
 * of the same kind goes to `resizeInPlace` (`cloudLaneLifeWeb.ts`).
 *
 * A move an agent's size request started tells that chat how it ended, from
 * this tab (`createWebTierRequestTeller`), as the tab's resizes do. The
 * request and the timing ride on the server's record, so any tab that
 * follows the move (a reload too) reads them.
 *
 * Followed by a read every few seconds while one runs and a view shows it
 * (or its asking chat waits to hear how it ends), and none otherwise.
 */

const POLL_MS = 4_000;

export type WebCloudResizeInPlace = (args: {
  computer: CloudInstance;
  tier: CloudTier;
  catalog: CloudCatalog;
  timing: "idle" | "now";
  diskGb?: unknown;
  /** An agent's size request the person confirmed: its chat is told how the change ended. */
  request?: WebTierRequestInput;
}) => CloudLaneJobSnapshot;

const iso = (ms: number) => new Date(ms).toISOString();
const isLive = (record: CloudMoveRecord) => record.state !== "done" && record.state !== "failed" && record.state !== "cancelled";

/** The step a move is on, as the desktop's move steps name it. */
function activeStageOf(record: CloudMoveRecord): CloudLaneJobStageId {
  switch (record.state) {
    case "making":
    case "joining":
    case "needs_approval":
      return "computer";
    case "copying":
      return "copy";
    default:
      return "remove";
  }
}

function stagesOf(record: CloudMoveRecord): CloudLaneJobStage[] {
  const ids = cloudLaneJobStageIds("move");
  const at = new Date(record.updatedAt).toISOString();
  const finished = record.state === "done";
  const active = ids.indexOf(activeStageOf(record));
  // `copying` reads from the new computer's sign-in on; the copy itself waits for the save (`copyStarted`).
  const waitingOnSave = record.state === "copying" && record.copyStarted === false;
  return ids.map((id, index) => {
    // The server saves the chats while it makes the new computer (`saveState`). An older server
    // says nothing of its save, which runs right before the copy: not a step this card follows.
    if (id === "save") {
      const status: CloudLaneJobStage["status"] = record.saveState ?? "skipped";
      return { id, status, detail: status === "warning" ? CLOUD_LANE_SAVE_WARNING_DETAIL : null, error: null, startedAt: null, endedAt: null };
    }
    let status: CloudLaneJobStage["status"] = index < active ? "done" : index === active ? (waitingOnSave ? "pending" : "running") : "pending";
    if (finished) status = id === "remove" && record.sourceDeleted === false ? "warning" : "done";
    if (!finished && index === active && record.state === "failed") status = "failed";
    if (!finished && index === active && record.state === "cancelled") status = "skipped";
    return {
      id,
      status,
      detail: index === active && isLive(record) && !waitingOnSave ? record.message : id === "remove" && status === "warning" ? "The old computer is still there. Delete it from its card." : null,
      error: status === "failed" ? record.error ?? record.message : null,
      startedAt: status === "pending" ? null : index <= active ? iso(record.createdAt) : null,
      endedAt: status === "done" || status === "failed" || status === "warning" ? at : null,
    };
  });
}

function phaseOf(record: CloudMoveRecord): CloudLaneJobPhase {
  if (record.state === "done") return "online";
  if (record.state === "failed") return "failed";
  if (record.state === "cancelled") return "cancelled";
  return "running";
}

/** A move as a lane job; its record names the timing and the size request it answers (an older server, neither: "now", none). */
export function laneJobOfMove(record: CloudMoveRecord): CloudLaneJobSnapshot {
  const toSizeId: CloudTierId = record.sizeId ?? (record.to === "full" ? "large" : "small");
  const { requestId, requestedByChat } = cloudTierRequestIdsOf(record);
  return {
    jobId: record.moveId,
    kind: "move",
    timing: record.timing === "idle" ? "idle" : "now",
    instanceId: record.state === "done" && record.targetInstanceId ? record.targetInstanceId : record.sourceInstanceId,
    fromInstanceId: record.sourceInstanceId,
    machineKey: (record.state === "done" ? record.targetMachineKey : record.sourceMachineKey) ?? null,
    laneId: null,
    laneName: record.sourceName,
    projectOrigin: null,
    fromSizeId: null,
    toSizeId,
    phase: phaseOf(record),
    stages: stagesOf(record),
    error: record.state === "failed" ? record.error ?? record.message : null,
    requestedByChat,
    requestId,
    startedAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    endedAt: isLive(record) ? null : iso(record.updatedAt),
  };
}

export function createWebCloudMoves(api: () => CloudApiClient | null, options: {
  resizeInPlace: WebCloudResizeInPlace;
  /** A size change in place runs for this computer. */
  resizing: (instanceId: string) => boolean;
  /** A move that answers an agent's size request tells that chat how it ended, from this tab. */
  teller: WebTierRequestTeller;
}) {
  const listeners = new Set<(job: CloudLaneJobSnapshot) => void>();
  /** The moves this tab follows, with the last record of each. */
  const followed = new Map<string, CloudMoveRecord>();
  /** Cards the person closed: they leave every view of this tab. */
  const dismissed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (record: CloudMoveRecord) => {
    followed.set(record.moveId, record);
    const job = laneJobOfMove(record);
    // The chat hears how it ended even when the person closed its card.
    options.teller.note(webTierRequestOf(record), job, record.sourceMachineKey ?? null);
    if (dismissed.has(record.moveId)) return;
    for (const listener of listeners) listener(job);
  };

  /** A view shows the moves, or a move's asking chat (its record names it) waits to hear how it ends. */
  const wanted = () => listeners.size > 0 || [...followed.values()].some((record) => isLive(record) && webTierRequestOf(record) != null);

  const schedule = () => {
    if (timer || !wanted() || ![...followed.values()].some(isLive)) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, POLL_MS);
  };

  const poll = async () => {
    const client = api();
    if (!client) return;
    for (const record of [...followed.values()].filter(isLive)) {
      const next = await client.move(record.moveId).catch(() => null);
      if (next && next.updatedAt !== record.updatedAt) publish(next);
    }
    schedule();
  };

  const moving = (instanceId: string): boolean =>
    [...followed.values()].some((record) => isLive(record) && record.sourceInstanceId === instanceId);

  const need = () => {
    const client = api();
    if (!client) throw new Error("Sign in to ADE to change your ADE Cloud lanes.");
    return client;
  };

  return {
    async changeTier(raw: unknown): Promise<CloudLaneJobSnapshot> {
      const args = raw && typeof raw === "object"
        ? raw as { instanceId?: unknown; sizeId?: unknown; timing?: unknown; diskGb?: unknown } & WebTierRequestInput
        : {};
      const instanceId = typeof args.instanceId === "string" ? args.instanceId.trim() : "";
      if (!instanceId) throw new Error("Name the computer.");
      if (!isCloudTierId(args.sizeId)) throw new Error("Pick a size.");
      const client = need();
      if (options.resizing(instanceId) || moving(instanceId)) {
        throw new Error("A change is already running for this lane.");
      }
      const [computer, account] = await Promise.all([client.computer(instanceId), client.account()]);
      const catalog = cloudCatalogOf(account);
      const tier = cloudTier(catalog, args.sizeId);
      if (!tier) throw new Error("ADE Cloud doesn't offer that size now.");
      if ((computer.type === "vm" ? "vm" : "default") === tier.type) {
        return options.resizeInPlace({
          computer,
          tier,
          catalog,
          timing: args.timing === "now" ? "now" : "idle",
          diskGb: args.diskGb,
          request: { requestId: args.requestId, requestedByChat: args.requestedByChat, requestedByChatPin: args.requestedByChatPin },
        });
      }
      const request = webTierRequestOf(args);
      const record = await client.startMove(instanceId, {
        moveId: crypto.randomUUID(),
        to: tier.type === "vm" ? "full" : "standard",
        sizeId: tier.id,
        origin: "person",
        timing: args.timing === "now" ? "now" : "idle",
        // The server keeps the request on the move's record, so any tab that follows it tells the chat.
        ...(request ? { requestId: request.requestId, requestedByChat: request.chatSessionId, requestedByChatPin: request.pin } : {}),
      });
      publish(record);
      schedule();
      return laneJobOfMove(record);
    },
    /** A move of this computer runs (as this tab last read it). */
    moving,
    async listJobs(): Promise<CloudLaneJobSnapshot[]> {
      const moves = await api()?.moves().catch(() => null);
      for (const record of moves ?? []) followed.set(record.moveId, record);
      schedule();
      return (moves ?? []).filter((record) => !dismissed.has(record.moveId)).map((record) => laneJobOfMove(record));
    },
    async cancelJob(raw: unknown): Promise<CloudLaneJobSnapshot | null> {
      const jobId = raw && typeof raw === "object" ? (raw as { jobId?: unknown }).jobId : null;
      if (typeof jobId !== "string" || !followed.has(jobId)) return null;
      const record = await need().cancelMove(jobId);
      publish(record);
      schedule();
      return laneJobOfMove(record);
    },
    async retryJob(raw: unknown): Promise<CloudLaneJobSnapshot | null> {
      const jobId = raw && typeof raw === "object" ? (raw as { jobId?: unknown }).jobId : null;
      const old = typeof jobId === "string" ? followed.get(jobId) : null;
      if (!old || isLive(old) || old.state === "done") return old ? laneJobOfMove(old) : null;
      // A Retry from a card that still shows an older failure: one change of a computer at a time.
      if (options.resizing(old.sourceInstanceId) || moving(old.sourceInstanceId)) throw new Error("A change is already running for this lane.");
      // A move that ended without moving: the same move again, with a new id (the same timing and request).
      const request = webTierRequestOf(old);
      const record = await need().startMove(old.sourceInstanceId, {
        moveId: crypto.randomUUID(),
        to: old.to,
        ...(old.sizeId ? { sizeId: old.sizeId } : {}),
        origin: "person",
        ...(old.timing ? { timing: old.timing } : {}),
        ...(request ? { requestId: request.requestId, requestedByChat: request.chatSessionId, requestedByChatPin: request.pin } : {}),
      });
      dismissed.add(old.moveId);
      publish(record);
      schedule();
      return laneJobOfMove(record);
    },
    async dismissJob(raw: unknown): Promise<CloudLaneJobSnapshot | null> {
      const jobId = raw && typeof raw === "object" ? (raw as { jobId?: unknown }).jobId : null;
      if (typeof jobId !== "string") return null;
      dismissed.add(jobId);
      const record = followed.get(jobId);
      if (!record) return null;
      const now = new Date().toISOString();
      const job = { ...laneJobOfMove(record), updatedAt: now, dismissedAt: now };
      for (const listener of listeners) listener(job);
      return job;
    },
    onLaneJob(cb: (job: CloudLaneJobSnapshot) => void): () => void {
      listeners.add(cb);
      schedule();
      return () => {
        listeners.delete(cb);
        if (!wanted() && timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}
