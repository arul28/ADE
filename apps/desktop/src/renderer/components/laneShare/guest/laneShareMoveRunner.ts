import type { OpenProjectBinding } from "../../../../shared/types";
import type { LaneShareRights } from "../../../../shared/laneShareRights";
import {
  isLaneShareMoveId,
  LANE_SHARE_MOVE_FINAL_STAGES,
  newLaneShareMoveId,
  type LaneShareMoveStage,
  type LaneShareMoveView,
} from "../../../../shared/laneShareMove";
import { parseCodedErrorMessage } from "../../../../shared/codedError";
import type { LaneShareGuestConnection } from "./laneShareGuestConnection";

/**
 * The guest's side of a lane share move. The guest client has no database
 * and never writes a file: it carries the payload and the bundle chunks
 * between the owner's machine (through the guest connection) and one of the
 * guest's own machines (through that machine's own runtime actions, by its
 * pin). Each side checks every step again; this code only orders them.
 *
 * - `receiveMoveHere` (`to_guest`): the guest pressed Accept.
 * - `sendMoveToOwner` (`to_owner`): the guest moves a chat of its own machine.
 */

const POLL_MS = 1_000;
/** About 10 chunks a second at most: 384 KiB each, well under the host's envelope limit. */
const CHUNK_GAP_MS = 100;
const ACCEPT_WAIT_MS = 15 * 60_000;
const LAND_WAIT_MS = 10 * 60_000;

export type LaneShareMoveProgress = { label: string; done?: number; total?: number };

type Ctx = {
  connection: LaneShareGuestConnection;
  pin: OpenProjectBinding;
  onProgress: (progress: LaneShareMoveProgress) => void;
  signal: AbortSignal;
};

function move<T>(pin: OpenProjectBinding, action: Parameters<typeof window.ade.laneShare.move>[0], args: Record<string, unknown>): Promise<T> {
  return window.ade.laneShare.move<T>(action, args, pin);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("The move was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("The move was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function hostMove(ctx: Ctx, moveId: string): Promise<LaneShareMoveView & { received?: number }> {
  const view = await ctx.connection.moveStep<LaneShareMoveView & { received?: number }>("status", { moveId });
  if (!view || view.moveId !== moveId) throw new Error("The owner's computer answered for another move.");
  return view;
}

/** Waits until the host's move reaches one of `stages`, or ends. */
async function waitForHostStage(ctx: Ctx, moveId: string, stages: ReadonlySet<LaneShareMoveStage>, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const view = await hostMove(ctx, moveId);
    if (stages.has(view.stage)) return view;
    if (LANE_SHARE_MOVE_FINAL_STAGES.has(view.stage)) {
      throw new Error(view.error ?? (view.stage === "declined" ? "The owner declined the move." : `The move ${view.stage === "expired" ? "expired" : "ended"}.`));
    }
    if (Date.now() > until) throw new Error("The move took too long. Start it again.");
    await sleep(POLL_MS, ctx.signal);
  }
}

export function moveErrorText(error: unknown): string {
  return parseCodedErrorMessage(error).message || "The move failed.";
}

/**
 * Direction A, on the guest: checks the chosen machine, sends Accept, then
 * carries the work to that machine and lands it there in a new lane.
 */
export async function receiveMoveHere(ctx: Ctx & {
  move: LaneShareMoveView;
  repoKey: string;
  modelHint: string | null;
  fromName: string | null;
  shareBack: { receiverEmail: string; rights: LaneShareRights; confirmHighRisk: boolean; endsAt: number | null } | null;
}): Promise<{ laneName: string | null }> {
  const { connection, pin, onProgress, signal } = ctx;
  const moveId = ctx.move.moveId;
  const grantId = ctx.move.grantId;
  if (!isLaneShareMoveId(moveId)) throw new Error("That move id is not valid.");
  onProgress({ label: "Checking the chosen computer…" });
  // Repository, GitHub access and a signed-in model, before anything moves.
  await move(pin, "moveReceivePrepare", { moveId, grantId, repoKey: ctx.repoKey, modelHint: ctx.modelHint, expiresAt: ctx.move.expiresAt });
  let accepted = false;
  try {
    await connection.moveStep("accept", { moveId });
    accepted = true;
    onProgress({ label: "The owner's computer is packing the work…" });
    await waitForHostStage(ctx, moveId, new Set(["ready"]), LAND_WAIT_MS);
    const { payload } = await connection.moveStep<{ payload: unknown }>("payload", { moveId });
    await move(pin, "moveReceiveBegin", { moveId, grantId, payload });
    const bundle = (payload as { bundle?: { chunkCount?: unknown } | null } | null)?.bundle;
    const total = typeof bundle?.chunkCount === "number" ? bundle.chunkCount : 0;
    for (let index = 0; index < total; index += 1) {
      if (signal.aborted) throw new Error("The move was cancelled.");
      onProgress({ label: "Copying the work…", done: index, total });
      const chunk = await connection.moveStep<{ index: number; data: string }>("chunk", { moveId, index });
      if (chunk?.index !== index) throw new Error("A part of the move arrived out of order. Move again.");
      await move(pin, "moveReceiveChunk", { moveId, grantId, index, data: chunk.data });
      await sleep(CHUNK_GAP_MS, signal);
    }
    onProgress({ label: "Making the new lane…" });
    await move(pin, "moveReceiveLand", { moveId, grantId, fromName: ctx.fromName, shareBack: ctx.shareBack });
    const until = Date.now() + LAND_WAIT_MS;
    for (;;) {
      const status = await move<{ stage: LaneShareMoveStage; error: string | null; result: { laneName: string | null; shareBackGrantId: string | null } | null }>(
        pin,
        "moveReceiveStatus",
        { moveId, grantId },
      );
      if (status.stage === "done") {
        await connection.moveStep("landed", {
          moveId,
          laneName: status.result?.laneName ?? null,
          shareBackGrantId: status.result?.shareBackGrantId ?? null,
        }).catch(() => undefined);
        return { laneName: status.result?.laneName ?? null };
      }
      if (LANE_SHARE_MOVE_FINAL_STAGES.has(status.stage)) throw new Error(status.error ?? "The move failed on this computer.");
      if (Date.now() > until) throw new Error("Making the new lane took too long.");
      await sleep(POLL_MS, signal);
    }
  } catch (error) {
    const message = moveErrorText(error);
    await move(pin, "moveReceiveCancel", { moveId, grantId }).catch(() => undefined);
    if (accepted) await connection.moveStep("failed", { moveId, message }).catch(() => undefined);
    throw new Error(message);
  }
}

/**
 * Direction B, on the guest: packs a chat of the guest's own machine, offers
 * it to the owner, and once the owner accepts, sends it in chunks.
 */
export async function sendMoveToOwner(ctx: Ctx & {
  grantId: string;
  sessionId: string;
  ownerName: string | null;
}): Promise<{ laneName: string | null }> {
  const { connection, pin, onProgress, signal } = ctx;
  const moveId = newLaneShareMoveId();
  let offered = false;
  let landed = false;
  try {
    onProgress({ label: "Packing the work on your computer…" });
    await move(pin, "movePackStart", { moveId, grantId: ctx.grantId, sessionId: ctx.sessionId });
    type PackedPayload = { laneName: string; branchName: string; repoKey: string; title: string | null; bundle: { chunkCount: number } | null };
    const payload: PackedPayload = await (async () => {
      for (const until = Date.now() + LAND_WAIT_MS; ;) {
        const status = await move<{ stage: LaneShareMoveStage; error: string | null; payload: PackedPayload | null }>(pin, "movePackStatus", { moveId });
        if (status.stage === "ready" && status.payload) return status.payload;
        if (LANE_SHARE_MOVE_FINAL_STAGES.has(status.stage)) throw new Error(status.error ?? "Packing the work failed.");
        if (Date.now() > until) throw new Error("Packing the work took too long.");
        await sleep(POLL_MS, signal);
      }
    })();
    await connection.moveStep("offer", {
      moveId,
      laneName: payload.laneName,
      branchName: payload.branchName,
      repoKey: payload.repoKey,
      chatTitle: payload.title,
    });
    offered = true;
    onProgress({ label: `Waiting for ${ctx.ownerName ?? "the owner"} to accept…` });
    await waitForHostStage(ctx, moveId, new Set(["accepted"]), ACCEPT_WAIT_MS);
    await connection.moveStep("begin", { moveId, payload });
    const total = payload.bundle?.chunkCount ?? 0;
    for (let index = 0; index < total; index += 1) {
      if (signal.aborted) throw new Error("The move was cancelled.");
      onProgress({ label: "Copying the work…", done: index, total });
      const chunk = await move<{ index: number; data: string }>(pin, "movePackChunk", { moveId, index });
      if (chunk?.index !== index) throw new Error("A part of the move was read out of order. Move again.");
      await connection.moveStep("put", { moveId, index, data: chunk.data });
      await sleep(CHUNK_GAP_MS, signal);
    }
    await connection.moveStep("finish", { moveId });
    onProgress({ label: `Making the new lane on ${ctx.ownerName ?? "the owner"}'s computer…` });
    const view = await waitForHostStage(ctx, moveId, new Set(["done"]), LAND_WAIT_MS);
    landed = true;
    return { laneName: view.result?.laneName ?? null };
  } catch (error) {
    const message = moveErrorText(error);
    if (offered && !landed) await connection.moveStep("cancel", { moveId }).catch(() => undefined);
    throw new Error(message);
  } finally {
    await move(pin, "movePackRelease", { moveId, landed, toName: ctx.ownerName }).catch(() => undefined);
  }
}
