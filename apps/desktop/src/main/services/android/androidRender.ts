import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_RENDER_ANGLE_IDS,
  ANDROID_RENDER_BACKGROUNDS,
  type AndroidAttachRenderProofArgs,
  type AndroidEmulatorEvent,
  type AndroidRenderProofResult,
  type AndroidRenderRequestArgs,
  type AndroidRenderRequestResult,
  type AndroidRenderRequestSpec,
} from "../../../shared/types/androidEmulator";
import { fileAndroidCaptureAsProof, type AndroidArtifactFiler } from "./androidProof";

/*
 * `ade android render` (P1 look). The brain has no GPU, so a render is drawn
 * by a desktop window's 3D view, as for `ade apple render`:
 * 1. `requestRender` sends `android.render.request` to every viewer.
 * 2. The first window that `renderAck`s draws; every later one stands down.
 * 3. It posts each image to `attachRenderProof`: the bytes are written here,
 *    on the machine that owns the device, and filed to the asking chat's
 *    proof drawer (unless the caller asked for `proof: false`).
 * 4. `renderComplete` answers the request with the files.
 *
 * The chat and the proof flag stay here, keyed by the request id: a window
 * never names the chat a proof goes to.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** A live pane acks at once; a window on another machine hears it over its event pump. */
const RENDER_ACK_TIMEOUT_MS = 7_500;
/** Under the action's 4 minute budget (ANDROID_EMULATOR_LIFECYCLE_TIMEOUT_MS), so this answer arrives first. */
const RENDER_DONE_TIMEOUT_MS = 225_000;
/** A 6-angle still set at 2048 px is far under this; a 6 s turntable WebM can be ~10 MB. */
const RENDER_MAX_BYTES = 64 * 1024 * 1024;

type PendingRender = {
  laneId: string;
  chatSessionId: string | null;
  proof: boolean;
  acked: boolean;
  paths: string[];
  proofArtifactIds: string[];
  ackTimer: ReturnType<typeof setTimeout>;
  doneTimer: ReturnType<typeof setTimeout>;
  resolve: (result: AndroidRenderRequestResult) => void;
  reject: (error: Error) => void;
};

export type AndroidRenderBrokerDeps = {
  emit: (event: AndroidEmulatorEvent) => void;
  /** The folder the files go in: `<project>/.ade/android/renders`. */
  rendersDir: string;
  artifactFiler?: AndroidArtifactFiler | null;
  /** The lane's folder, for the proof row. */
  resolveLaneWorktreePath?: (laneId: string) => string | null;
  onFileError?: (error: unknown) => void;
};

/** The spec a caller sent, checked: known angles only, at least one, no duplicates. */
export function normalizeAndroidRenderSpec(value: unknown): AndroidRenderRequestSpec {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const angles = (Array.isArray(raw.angles) ? raw.angles : [])
    .filter((angle): angle is AndroidRenderRequestSpec["angles"][number] =>
      typeof angle === "string" && (ANDROID_RENDER_ANGLE_IDS as readonly string[]).includes(angle));
  const unique = [...new Set(angles)];
  if (unique.length === 0) throw new Error(`A render needs at least one angle: ${ANDROID_RENDER_ANGLE_IDS.join(", ")}.`);
  const background = typeof raw.background === "string" && (ANDROID_RENDER_BACKGROUNDS as readonly string[]).includes(raw.background)
    ? raw.background as AndroidRenderRequestSpec["background"]
    : "transparent";
  return { angles: unique, background, shadow: raw.shadow === true, video: raw.video === true, contactSheet: raw.contactSheet === true };
}

/** `data:image/png;base64,…` or `data:video/webm;base64,…` → its bytes and kind; null for anything else. */
function decodeRenderDataUrl(dataUrl: unknown): { bytes: Buffer; kind: "png" | "webm" } | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:(image\/png|video\/webm)(?:;[^,;]*)*;base64,([A-Za-z0-9+/=\s]+)$/u.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0 || bytes.length > RENDER_MAX_BYTES) return null;
  const kind = match[1] === "image/png" ? "png" : "webm";
  // The bytes must be what the header says: a PNG signature, or WebM's EBML magic.
  if (kind === "png" && !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (kind === "webm" && !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return null;
  return { bytes, kind };
}

export function createAndroidRenderBroker(deps: AndroidRenderBrokerDeps) {
  const pending = new Map<string, PendingRender>();

  const finish = (requestId: string, result: AndroidRenderRequestResult | Error) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.ackTimer);
    clearTimeout(entry.doneTimer);
    if (result instanceof Error) entry.reject(result);
    else entry.resolve(result);
  };

  return {
    requestRender(args: AndroidRenderRequestArgs & { laneId: string }): Promise<AndroidRenderRequestResult> {
      const request = normalizeAndroidRenderSpec(args.request);
      const requestId = randomUUID();
      const result = new Promise<AndroidRenderRequestResult>((resolve, reject) => {
        const ackTimer = setTimeout(() => {
          const entry = pending.get(requestId);
          if (!entry || entry.acked) return;
          finish(requestId, new Error(
            "No ADE desktop window took this render. A desktop window's 3D view draws renders: open the lane's Android Development tool in ADE on a desktop, then render again.",
          ));
        }, RENDER_ACK_TIMEOUT_MS);
        const doneTimer = setTimeout(() => finish(requestId, new Error("The render did not finish within 3 minutes 45 seconds.")), RENDER_DONE_TIMEOUT_MS);
        (doneTimer as unknown as { unref?: () => void }).unref?.();
        pending.set(requestId, {
          laneId: args.laneId,
          chatSessionId: typeof args.chatSessionId === "string" && args.chatSessionId.trim() ? args.chatSessionId.trim() : null,
          proof: args.proof !== false,
          acked: false,
          paths: [],
          proofArtifactIds: [],
          ackTimer,
          doneTimer,
          resolve,
          reject,
        });
      });
      deps.emit({ type: "android.render.request", laneId: args.laneId, requestId, request });
      return result;
    },

    /** True for the first window to take the request; every later one stands down. */
    renderAck(requestId: unknown): { ok: boolean } {
      const entry = typeof requestId === "string" ? pending.get(requestId) : undefined;
      if (!entry || entry.acked) return { ok: false };
      entry.acked = true;
      clearTimeout(entry.ackTimer);
      return { ok: true };
    },

    renderComplete(requestId: unknown, error: unknown): { ok: boolean } {
      const entry = typeof requestId === "string" ? pending.get(requestId) : undefined;
      if (!entry) return { ok: false };
      finish(requestId as string, {
        filed: entry.paths.length,
        paths: [...entry.paths],
        proofArtifactIds: [...entry.proofArtifactIds],
        error: typeof error === "string" && error.trim() ? error.trim() : null,
      });
      return { ok: true };
    },

    /**
     * Writes one image or video and files it. With a request id the file
     * belongs to that request (its lane, chat and proof flag); without one it
     * is a render the user made in the sheet, filed to the lane.
     */
    async attachRenderProof(args: AndroidAttachRenderProofArgs & { laneId: string }): Promise<AndroidRenderProofResult> {
      const requestId = typeof args.requestId === "string" && args.requestId ? args.requestId : null;
      const entry = requestId ? pending.get(requestId) : undefined;
      if (requestId && !entry) throw new Error("That render request is over.");
      if (entry && entry.laneId !== args.laneId) throw new Error("That render request is for another lane.");
      const decoded = decodeRenderDataUrl(args.dataUrl);
      if (!decoded) throw new Error("A render must be a PNG or WebM data URL under 64 MB.");
      await fs.promises.mkdir(deps.rendersDir, { recursive: true });
      const filePath = path.join(deps.rendersDir, `render-${randomUUID().slice(0, 8)}.${decoded.kind}`);
      // `wx`: never through a file (or link) that is already there.
      await fs.promises.writeFile(filePath, decoded.bytes, { flag: "wx" });
      const title = (typeof args.title === "string" ? args.title.trim() : "") || "3D render";
      const proof = entry ? entry.proof : true;
      const proofArtifactId = proof
        ? fileAndroidCaptureAsProof(deps.artifactFiler, {
          laneId: args.laneId,
          chatSessionId: entry?.chatSessionId ?? null,
          kind: decoded.kind === "png" ? "screenshot" : "video_recording",
          path: filePath,
          mimeType: decoded.kind === "png" ? "image/png" : "video/webm",
          title,
          description: decoded.kind === "png" ? "A 3D render of the lane's Android device." : "A turntable of the lane's Android device.",
          toolName: "android_render",
          source: "ade-capture",
          callerRoot: deps.resolveLaneWorktreePath?.(args.laneId) ?? null,
        }, deps.onFileError)
        : null;
      if (entry) {
        entry.paths.push(filePath);
        if (proofArtifactId) entry.proofArtifactIds.push(proofArtifactId);
      }
      return { path: filePath, proofArtifactId };
    },

    dispose() {
      for (const requestId of [...pending.keys()]) finish(requestId, new Error("The Android service closed."));
    },
  };
}
