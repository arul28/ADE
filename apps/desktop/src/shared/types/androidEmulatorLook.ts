/**
 * The Android emulator contract, P1 look: the body colour and the 3D render.
 * Re-exported from `androidEmulator.ts`; import from there.
 */

import type { OpenProjectBinding } from "./core";
import type { AndroidLaneArgs, AndroidLaneDeviceStatus } from "./androidEmulator";

type Pin = OpenProjectBinding | null | undefined;

/* ──────────────────────────────────────────────────────────────────────────
   P1 LOOK (android-look): the body colour and the 3D render.

   The catalog itself is `shared/androidDeviceCatalog.ts`. A render is drawn
   by a desktop window's 3D view (the brain has no GPU): `requestRender` asks
   every viewer, the first to `renderAck` draws, posts each image to
   `attachRenderProof` (filed to the asking chat's proof drawer), then calls
   `renderComplete`. The same seam as `ade apple render`.
   ────────────────────────────────────────────────────────────────────────── */

export type AndroidSetDeviceColorArgs = AndroidLaneArgs & {
  /** A colour id of the AVD's catalog entry. */
  colorId: string;
};

export const ANDROID_RENDER_ANGLE_IDS = ["front", "three-quarter-left", "three-quarter-right", "back", "current"] as const;
export type AndroidRenderAngleId = (typeof ANDROID_RENDER_ANGLE_IDS)[number];
export const ANDROID_RENDER_BACKGROUNDS = ["transparent", "studio", "dusk"] as const;
export type AndroidRenderBackground = (typeof ANDROID_RENDER_BACKGROUNDS)[number];

export type AndroidRenderRequestSpec = {
  angles: AndroidRenderAngleId[];
  background: AndroidRenderBackground;
  /** A soft contact shadow under the device. */
  shadow: boolean;
  /** Also a turntable video (WebM). */
  video: boolean;
  /** Also one PNG with every still, labelled. */
  contactSheet?: boolean;
};

export type AndroidRenderRequestArgs = AndroidLaneArgs & {
  /** The asking chat, where the proof is filed. Set by the runtime for an agent. */
  chatSessionId?: string | null;
  /** False: write the files but file no proof (a `--machine` caller files them itself). */
  proof?: boolean;
  /** An `AndroidRenderRequestSpec`; the brain checks it (`normalizeAndroidRenderSpec`). */
  request: unknown;
};

export type AndroidRenderRequestResult = {
  filed: number;
  /** The image and video files, on the machine that owns the device. */
  paths: string[];
  proofArtifactIds: string[];
  error: string | null;
};

/** Sent to every viewer of the project; a live 3D pane for the lane takes it. */
export type AndroidRenderRequestEvent = {
  type: "android.render.request";
  laneId: string;
  requestId: string;
  request: AndroidRenderRequestSpec;
};

export type AndroidRenderAckArgs = { requestId: string };
export type AndroidRenderCompleteArgs = { requestId: string; error?: string | null };

export type AndroidAttachRenderProofArgs = AndroidLaneArgs & {
  /** The request this image belongs to; null for a render the user made in the sheet. */
  requestId?: string | null;
  /** `data:image/png;base64,…` or `data:video/webm;base64,…`. */
  dataUrl: string;
  title?: string | null;
};

export type AndroidRenderProofResult = {
  path: string;
  proofArtifactId: string | null;
};

export type AndroidEmulatorLookServiceApi = {
  /** Record a new body colour on the lane's AVD (`ade.color`). */
  setDeviceColor(args: AndroidSetDeviceColorArgs): Promise<AndroidLaneDeviceStatus>;
  requestRender(args: AndroidRenderRequestArgs): Promise<AndroidRenderRequestResult>;
  renderAck(args: AndroidRenderAckArgs): Promise<{ ok: boolean }>;
  renderComplete(args: AndroidRenderCompleteArgs): Promise<{ ok: boolean }>;
  attachRenderProof(args: AndroidAttachRenderProofArgs): Promise<AndroidRenderProofResult>;
};

export type AndroidEmulatorLookPreloadApi = {
  setDeviceColor(args: AndroidSetDeviceColorArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  renderAck(args: AndroidRenderAckArgs, pin?: Pin): Promise<{ ok: boolean }>;
  renderComplete(args: AndroidRenderCompleteArgs, pin?: Pin): Promise<{ ok: boolean }>;
  attachRenderProof(args: AndroidAttachRenderProofArgs, pin?: Pin): Promise<AndroidRenderProofResult>;
};
