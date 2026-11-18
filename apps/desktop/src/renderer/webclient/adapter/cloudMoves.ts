import { cloudCatalogOf } from "../../../shared/adeCloud";
import type { CloudApiClient } from "../../../shared/cloudApiClient";
import { cloudLaneJobStageIds, type CloudLaneJobPhase, type CloudLaneJobSnapshot, type CloudLaneJobStage, type CloudLaneJobStageId } from "../../../shared/cloudLaneLife";
import { cloudTier, isCloudTierId, type CloudTierId } from "../../../shared/cloudTiers";
import type { CloudMoveRecord } from "../../../../../account-directory/src/cloud/contract";

/**
 * ADE Web's moves of a lane's computer to the other kind (Standard ↔ Full):
 * ADE's server runs them (`POST /cloud/instances/:id/move`, `moves.ts`), so
 * the web needs no computer of the person's. Each move reads as the desktop's
 * lane job (`CloudLaneJobSnapshot`), so the same cards show it. A size change
 * in place still runs in the desktop app.
 *
 * Followed by a read every few seconds while one runs, and none otherwise.
 */

const POLL_MS = 4_000;
const RESIZE_ON_DESKTOP = "Changing the size in place needs the ADE desktop app. Moving to the other kind works here.";

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
  return ids.map((id, index) => {
    // The server saves the chats right before the copy: its own step, not one this card follows.
    if (id === "save") return { id, status: "skipped", detail: null, error: null, startedAt: null, endedAt: null };
    let status: CloudLaneJobStage["status"] = index < active ? "done" : index === active ? "running" : "pending";
    if (finished) status = id === "remove" && record.sourceDeleted === false ? "warning" : "done";
    if (!finished && index === active && record.state === "failed") status = "failed";
    if (!finished && index === active && record.state === "cancelled") status = "skipped";
    return {
      id,
      status,
      detail: index === active && isLive(record) ? record.message : id === "remove" && status === "warning" ? "The old computer is still there. Delete it from its card." : null,
      error: status === "failed" ? record.error ?? record.message : null,
      startedAt: index <= active ? iso(record.createdAt) : null,
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

export function laneJobOfMove(record: CloudMoveRecord, laneName?: string | null): CloudLaneJobSnapshot {
  const toSizeId: CloudTierId = record.sizeId ?? (record.to === "full" ? "large" : "small");
  return {
    jobId: record.moveId,
    kind: "move",
    timing: "now",
    instanceId: record.state === "done" && record.targetInstanceId ? record.targetInstanceId : record.sourceInstanceId,
    fromInstanceId: record.sourceInstanceId,
    machineKey: (record.state === "done" ? record.targetMachineKey : record.sourceMachineKey) ?? null,
    laneId: null,
    laneName: laneName ?? record.sourceName,
    projectOrigin: null,
    fromSizeId: null,
    toSizeId,
    phase: phaseOf(record),
    stages: stagesOf(record),
    error: record.state === "failed" ? record.error ?? record.message : null,
    requestedByChat: null,
    startedAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    endedAt: isLive(record) ? null : iso(record.updatedAt),
  };
}

export function createWebCloudMoves(api: () => CloudApiClient | null) {
  const listeners = new Set<(job: CloudLaneJobSnapshot) => void>();
  /** The moves this tab follows, with the last record of each. */
  const followed = new Map<string, CloudMoveRecord>();
  /** Cards the person closed: they leave every view of this tab. */
  const dismissed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (record: CloudMoveRecord) => {
    followed.set(record.moveId, record);
    if (dismissed.has(record.moveId)) return;
    const job = laneJobOfMove(record);
    for (const listener of listeners) listener(job);
  };

  const schedule = () => {
    if (timer || listeners.size === 0 || ![...followed.values()].some(isLive)) return;
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

  const need = () => {
    const client = api();
    if (!client) throw new Error("Sign in to ADE to change your ADE Cloud lanes.");
    return client;
  };

  return {
    async changeTier(raw: unknown): Promise<CloudLaneJobSnapshot> {
      const args = raw && typeof raw === "object" ? raw as { instanceId?: unknown; sizeId?: unknown; timing?: unknown } : {};
      const instanceId = typeof args.instanceId === "string" ? args.instanceId.trim() : "";
      if (!instanceId) throw new Error("Name the computer.");
      if (!isCloudTierId(args.sizeId)) throw new Error("Pick a size.");
      const client = need();
      const [computer, account] = await Promise.all([client.computer(instanceId), client.account()]);
      const tier = cloudTier(cloudCatalogOf(account), args.sizeId);
      if (!tier) throw new Error("ADE Cloud doesn't offer that size now.");
      if ((computer.type === "vm" ? "vm" : "default") === tier.type) throw new Error(RESIZE_ON_DESKTOP);
      const record = await client.startMove(instanceId, {
        moveId: crypto.randomUUID(),
        to: tier.type === "vm" ? "full" : "standard",
        sizeId: tier.id,
        origin: "person",
        timing: args.timing === "now" ? "now" : "idle",
      });
      publish(record);
      schedule();
      return laneJobOfMove(record);
    },
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
      // A move that ended without moving: the same move again, with a new id.
      const record = await need().startMove(old.sourceInstanceId, {
        moveId: crypto.randomUUID(),
        to: old.to,
        ...(old.sizeId ? { sizeId: old.sizeId } : {}),
        origin: "person",
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
        if (listeners.size === 0 && timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}
