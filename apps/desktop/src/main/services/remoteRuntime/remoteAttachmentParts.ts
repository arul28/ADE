import { randomUUID } from "node:crypto";
import { createLinkMeter, type LinkMeter } from "./remoteLinkMeter";
import {
  isRemoteOutcomeUnknownError,
  isRemoteRuntimeConnectionError,
  isRuntimeTransportTimeoutError,
} from "../../../shared/runtimeErrors";

/**
 * Sends a paste to another machine in parts (`chat.saveTempAttachmentPart`).
 *
 * Why parts: one `saveTempAttachment` request is the whole picture. On a slow
 * link it holds the uplink for a minute, every key waits behind it, and a drop
 * loses it all. In parts, a key waits behind at most the parts in flight, and
 * a drop costs only the parts that were out.
 *
 * - Part size and parts in flight come from the machine's upload meter
 *   (`remoteLinkMeter.ts`), as for pictures: each part is about
 *   `PART_TARGET_MS` of the measured upload rate, and enough parts are out to
 *   cover the round trip, so the uplink stays full and a key waits behind
 *   about one round trip plus one part.
 * - Each part says where it starts, so the machine places it whatever order
 *   it arrives in, and a part sent again is answered, not added twice.
 * - The machine answers how many bytes it holds from the start. When every
 *   part is out and it holds less (it restarted), the rest goes again.
 */
const PART_TARGET_MS = 250;

/** The upload meter for one machine; kept per machine so the next paste starts at the known rate. */
export function createAttachmentUploadMeter(now: () => number = Date.now): LinkMeter {
  return createLinkMeter({
    targetMs: PART_TARGET_MS,
    minBytes: 16 * 1024,
    startBytes: 16 * 1024,
    maxBytes: 1024 * 1024,
    inFlightMin: 2,
    inFlightMax: 8,
    startInFlight: 4,
    latencySamples: 8,
    now,
  });
}
/** Below this, one `saveTempAttachment` call is as good. */
export const ATTACHMENT_PARTS_MIN_BYTES = 128 * 1024;
/** Waits before each new try of one part after a failure; then the upload fails. */
const PART_RETRY_DELAYS_MS = [500, 1_500, 3_000, 6_000, 10_000] as const;
/** A machine that keeps losing the upload is not going to keep it. */
const MAX_RESTARTS = 3;

export type AttachmentPartCall = (args: {
  uploadId: string;
  offset: number;
  totalBytes: number;
  data: string;
  filename: string;
}) => Promise<unknown>;

function isTransientPartError(error: unknown): boolean {
  return isRemoteRuntimeConnectionError(error)
    || isRuntimeTransportTimeoutError(error)
    || isRemoteOutcomeUnknownError(error);
}

function readPartAnswer(value: unknown, totalBytes: number): { received: number; path: string | null } {
  const record = value && typeof value === "object" ? value as { received?: unknown; path?: unknown } : null;
  const received = Number(record?.received);
  if (!record || !Number.isSafeInteger(received) || received < 0 || received > totalBytes) {
    throw new Error("The machine sent an unreadable answer to an attachment part.");
  }
  const path = typeof record.path === "string" && record.path.trim() ? record.path : null;
  return { received, path };
}

export async function sendAttachmentInParts(args: {
  bytes: Buffer;
  filename: string;
  call: AttachmentPartCall;
  /** The machine's upload meter; a new one when absent. */
  meter?: LinkMeter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  uploadId?: string;
}): Promise<{ path: string }> {
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = args.now ?? Date.now;
  const meter = args.meter ?? createAttachmentUploadMeter(now);
  const uploadId = args.uploadId ?? randomUUID();
  const totalBytes = args.bytes.length;
  if (totalBytes === 0) throw new Error("The attachment is empty.");
  let path: string | null = null;
  /** What the machine last said it holds from the start. */
  let held = 0;

  /** Sends one part, again after a lost or slow connection. */
  const sendPart = async (offset: number, length: number): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      const stamp = meter.stamp();
      try {
        const answer = readPartAnswer(await args.call({
          uploadId,
          offset,
          totalBytes,
          data: args.bytes.subarray(offset, offset + length).toString("base64"),
          filename: args.filename,
        }), totalBytes);
        // The latest answer: the machine's count only grows, unless it lost
        // the upload (it restarted), and then the latest is the truth.
        held = answer.received;
        if (answer.path) path = answer.path;
        meter.delivered(length, stamp);
        return;
      } catch (error) {
        if (!isTransientPartError(error) || attempt >= PART_RETRY_DELAYS_MS.length) throw error;
        meter.slowDown();
        await sleep(PART_RETRY_DELAYS_MS[attempt]!);
      }
    }
  };

  for (let restarts = 0; ; restarts += 1) {
    let cursor = held;
    let failure: { error: unknown } | null = null;
    const running = new Set<Promise<void>>();
    while (!failure && !path && cursor < totalBytes) {
      await meter.acquire();
      if (failure || path) {
        meter.release();
        break;
      }
      const offset = cursor;
      const length = Math.min(meter.chunkBytes(), totalBytes - offset);
      cursor += length;
      const part: Promise<void> = sendPart(offset, length)
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => {
          meter.release();
          running.delete(part);
        });
      running.add(part);
    }
    await Promise.all([...running]);
    if (failure) throw (failure as { error: unknown }).error;
    if (path) return { path };
    if (held >= totalBytes) throw new Error("The machine took every part but staged no file.");
    // Every part went out, and the machine holds less: it lost some (it
    // restarted). Send again from what it holds.
    if (restarts >= MAX_RESTARTS) throw new Error("The machine lost the attachment upload more than once.");
  }
}
