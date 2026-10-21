import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeScenePngDataUrl, decodeSceneWebmDataUrl } from "../scenes/sceneSnapshot";
import {
  APPLE_DEVICE_POSES,
  APPLE_DEVICE_POSE_TARGETS,
  APPLE_DUO_COVER_SCREEN_ID,
  APPLE_DUO_INNER_SCREEN_ID,
  type AppleAddDuoSkillResult,
  type AppleDevicePose,
  type AppleDevicePosture,
  type AppleDuoAppStoreScreenshotsResult,
  type AppleDuoModelResult,
  type AppleRenderRequestArgs,
  type AppleRenderRequestResult,
  type AppleSetPostureArgs,
  type AppleSetPostureResult,
  type IosSimulatorEventPayload,
  type IosSimulatorScreenshot,
  type IosSimulatorScreenshotArgs,
} from "../../../shared/types";

/**
 * The iPhone Duo's own surface: folding and reading its pose, the panel a
 * screenshot should capture, Apple's 3D model and agent skill from the local
 * Xcode, the App Store Duo set, and the broker that hands `ade apple render`
 * to an open Apple pane. Everything else about the device is the simulator
 * service's; this module gets what it needs from it as deps.
 */

type Scope = { laneId?: string | null; chatSessionId?: string | null; projectRoot?: string | null };
type RunCommand = (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

export type AppleDuoServiceDeps<Runtime extends { key: string | null }> = {
  assertDarwin: () => void;
  run: RunCommand;
  helperSend: (command: Record<string, unknown> & { type: string; udid?: string }) => Promise<Record<string, unknown>>;
  resolveRuntime: (scope?: Scope) => Runtime;
  resolveControlDeviceUdid: (deviceUdid: string | null | undefined, runtime: Runtime) => Promise<string>;
  resolveScopedRootForSession: (scope: { projectRoot?: string | null; laneId?: string | null }, runtime: Runtime) => Promise<string>;
  enqueueControl: <T>(action: string, runControl: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  fileScreenshotAsProof: (
    shot: Pick<IosSimulatorScreenshot, "deviceUdid" | "filePath" | "capturedAt" | "width" | "height">,
    arg: IosSimulatorScreenshotArgs,
    runtime: Runtime,
    render?: { kind: "screenshot" | "video_recording"; mimeType: string },
  ) => string | null;
  emit: (payload: IosSimulatorEventPayload) => void;
  logger: { warn: (event: string, fields?: Record<string, unknown>) => void };
  readPngSize: (filePath: string) => { width: number; height: number } | null;
  nowIso: () => string;
  /** Where screenshots are cached under a lane root. */
  screenshotSegments: readonly string[];
};

/** Both Duo App Store screenshots fold the simulator twice and wait for each panel. */
export const APPLE_DUO_APP_STORE_SHOTS_TIMEOUT_MS = 60_000;
/**
 * How long a fold may take to land on its panel before the read-back is
 * reported as is: an interactive fold answers within its control slot; the
 * App Store set can afford to wait longer for each panel.
 */
const FOLD_SETTLE_MS = 5_000;
const FOLD_CONTROL_TIMEOUT_MS = 10_000;
const APP_STORE_FOLD_SETTLE_MS = 8_000;
/** The guest elects its panel a moment after the hinge moves: read back after this. */
const FOLD_FIRST_READ_MS = 600;
/** A Duo still coming up can answer "no hinge": how long that answer is trusted. */
const NOT_FOLDABLE_RECHECK_MS = 10_000;
/** iOS animates into the new panel's layout after it switches. */
const LAYOUT_SETTLE_MS = 1_200;

/** A helper `posture-get` reply or `posture-changed` event, as ADE's type. */
export function parseHelperPosture(payload: Record<string, unknown>): AppleDevicePosture {
  const supported = payload.supported !== false && (payload.supported === true || typeof payload.angle === "number");
  return {
    supported,
    angle: typeof payload.angle === "number" ? payload.angle : null,
    orientation: typeof payload.orientation === "string" ? payload.orientation : null,
    tableMode: typeof payload.tableMode === "boolean" ? payload.tableMode : null,
    activeScreenId: typeof payload.activeScreenId === "number" ? payload.activeScreenId : null,
  };
}

/** The panel a fold to this pose or angle lands on, when it is known. */
function expectedScreenFor(target: { pose?: AppleDevicePose | null; angle?: number | null }): { angle: number; screenId: number | null } | null {
  if (target.pose) return APPLE_DEVICE_POSE_TARGETS[target.pose];
  if (typeof target.angle !== "number") return null;
  // Only the ends are certain: in between, the guest picks by its own rules.
  const screenId = target.angle === 0 ? APPLE_DUO_COVER_SCREEN_ID : target.angle === 180 ? APPLE_DUO_INNER_SCREEN_ID : null;
  return { angle: target.angle, screenId };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAppleDevicePose(value: string): value is AppleDevicePose {
  return (APPLE_DEVICE_POSES as readonly string[]).includes(value);
}

/**
 * Write into a lane's folder without following a link swapped in under it:
 * ADE holds the external-drive permission, so a followed link could land the
 * bytes anywhere it can write.
 */
async function writeNoFollow(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

export function createAppleDuoService<Runtime extends { key: string | null }>(deps: AppleDuoServiceDeps<Runtime>) {
  const readPosture = async (deviceUdid: string): Promise<AppleDevicePosture> =>
    parseHelperPosture(await deps.helperSend({ type: "posture-get", udid: deviceUdid }));

  /**
   * Fold, then read the pose back once it has settled, so the answer is what
   * happened. The hinge sweeps and the guest elects its panel a moment later;
   * a pose with a known panel waits (up to `settleMs`) until the guest has
   * switched to it, or the answer names the panel it is leaving.
   */
  const foldAndSettle = async (
    deviceUdid: string,
    target: { pose?: AppleDevicePose | null; angle?: number | null },
    settleMs = FOLD_SETTLE_MS,
  ): Promise<AppleSetPostureResult> => {
    const payload = await deps.helperSend({
      type: "posture",
      udid: deviceUdid,
      ...(target.pose ? { pose: target.pose } : { angle: target.angle }),
    });
    const applied = payload.applied === true;
    const expected = expectedScreenFor(target);
    await sleep(FOLD_FIRST_READ_MS);
    let posture = await readPosture(deviceUdid);
    const deadline = Date.now() + settleMs;
    while (applied && expected?.screenId != null && posture.activeScreenId !== expected.screenId && Date.now() < deadline) {
      await sleep(200);
      posture = await readPosture(deviceUdid);
    }
    return { applied, posture };
  };

  /**
   * Fold the lane's iPhone Duo to a preset or an angle. Answers
   * `applied: false, supported: false` for a device without a hinge rather
   * than throwing: "this is not a foldable" is a state, not a failure.
   */
  const setPosture = async (postureArgs: AppleSetPostureArgs): Promise<AppleSetPostureResult> => {
    deps.assertDarwin();
    const requested = typeof postureArgs.pose === "string" ? postureArgs.pose.trim().toLowerCase() : null;
    const angle = typeof postureArgs.angle === "number" && Number.isFinite(postureArgs.angle) ? postureArgs.angle : null;
    if (requested && !isAppleDevicePose(requested)) {
      throw new Error(`pose must be ${APPLE_DEVICE_POSES.join(", ")}.`);
    }
    const pose = requested && isAppleDevicePose(requested) ? requested : null;
    if (!pose && (angle === null || angle < 0 || angle > 180)) {
      throw new Error("Give a pose, or an angle between 0 and 180 degrees.");
    }
    const runtime = deps.resolveRuntime(postureArgs);
    const deviceUdid = await deps.resolveControlDeviceUdid(postureArgs.deviceUdid, runtime);
    return deps.enqueueControl(
      "posture",
      () => foldAndSettle(deviceUdid, { pose, angle }),
      FOLD_CONTROL_TIMEOUT_MS,
    );
  };

  const getPosture = async (postureArgs: Pick<AppleSetPostureArgs, "laneId" | "chatSessionId" | "deviceUdid"> = {}): Promise<AppleDevicePosture> => {
    deps.assertDarwin();
    const runtime = deps.resolveRuntime(postureArgs);
    const deviceUdid = await deps.resolveControlDeviceUdid(postureArgs.deviceUdid, runtime);
    return readPosture(deviceUdid);
  };

  /**
   * `--display=<id>` for a foldable's live panel; nothing for every other
   * device. `simctl io screenshot` without it captures the inner panel, which
   * is black while the phone is closed. Whether a device folds is asked once
   * and kept; the live panel is read fresh each time.
   */
  /** "Not a foldable" answers, by when they were given: re-asked after 10 s, as the helper does. */
  const notFoldableAt = new Map<string, number>();
  const screenshotDisplayArgs = async (udid: string): Promise<string[]> => {
    const no = notFoldableAt.get(udid);
    if (no !== undefined && Date.now() - no < NOT_FOLDABLE_RECHECK_MS) return [];
    const posture = await readPosture(udid).catch((cause: unknown) => {
      deps.logger.warn("apple.screenshot_posture_unreadable", { udid, error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    });
    if (!posture) return [];
    if (posture.supported) notFoldableAt.delete(udid);
    else notFoldableAt.set(udid, Date.now());
    return posture.supported && typeof posture.activeScreenId === "number" ? [`--display=${posture.activeScreenId}`] : [];
  };

  /**
   * Apple's Duo model from this machine's Xcode, for the 3D view and renders.
   * Read once per Xcode path and kept: it is ~6 MB and does not change under
   * a running Xcode.
   */
  let duoModelCache: { path: string; base64: string } | null = null;
  const getDuoModel = async (): Promise<AppleDuoModelResult> => {
    deps.assertDarwin();
    const developer = await deps.run("xcode-select", ["-p"], { timeoutMs: 10_000 })
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    if (!developer) return { base64: null, path: null };
    const modelPath = path.join(
      path.dirname(developer),
      "SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz",
    );
    if (duoModelCache?.path === modelPath) return { base64: duoModelCache.base64, path: modelPath };
    const bytes = await fs.promises.readFile(modelPath).catch(() => null);
    if (!bytes) return { base64: null, path: modelPath };
    duoModelCache = { path: modelPath, base64: bytes.toString("base64") };
    return { base64: duoModelCache.base64, path: modelPath };
  };

  /**
   * Apple's `app-resizability` agent skill (Xcode 27's `xcrun agent skills
   * export`), copied into the lane's `.agents/skills`, where every ADE agent
   * in the lane finds it. It is the skill Apple points at for the iPhone Duo;
   * an ADE agent following it moved a legacy UIKit app to the scene life
   * cycle and size-driven layout that refilled each panel on fold. A lane
   * that already has the skill keeps its copy (it may be edited).
   */
  const addDuoSkill = async (skillArgs: Scope = {}): Promise<AppleAddDuoSkillResult> => {
    deps.assertDarwin();
    const runtime = deps.resolveRuntime(skillArgs);
    const root = await deps.resolveScopedRootForSession({ projectRoot: skillArgs.projectRoot, laneId: skillArgs.laneId }, runtime);
    const skill = "app-resizability" as const;
    const target = path.join(root, ".agents", "skills", skill);
    if (fs.existsSync(path.join(target, "SKILL.md"))) return { skill, path: target, added: false };
    const exportDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-apple-skills-"));
    try {
      try {
        await deps.run("xcrun", ["agent", "skills", "export", "--output-dir", exportDir], { timeoutMs: 60_000 });
      } catch (cause) {
        deps.logger.warn("apple.duo_skill_export_failed", { error: cause instanceof Error ? cause.message : String(cause) });
        throw new Error(
          "Xcode could not export its agent skills. Apple's app-resizability skill needs Xcode 27 or later.",
          { cause },
        );
      }
      const source = path.join(exportDir, skill);
      if (!fs.existsSync(path.join(source, "SKILL.md"))) {
        throw new Error("This Mac's Xcode does not include Apple's app-resizability skill.");
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.cp(source, target, { recursive: true, errorOnExist: false, force: false });
      return { skill, path: target, added: true };
    } finally {
      await fs.promises.rm(exportDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  /**
   * The App Store Connect iPhone Duo set: the cover closed (1398×2034) and the
   * inner display open (2853×2007), each captured from its own panel, filed
   * as proof. Folds the simulator to take them and puts the hinge back.
   */
  const duoAppStoreScreenshots = async (
    shotArgs: Pick<AppleSetPostureArgs, "laneId" | "chatSessionId" | "deviceUdid"> & { projectRoot?: string | null } = {},
  ): Promise<AppleDuoAppStoreScreenshotsResult> => {
    deps.assertDarwin();
    const runtime = deps.resolveRuntime(shotArgs);
    const deviceUdid = await deps.resolveControlDeviceUdid(shotArgs.deviceUdid, runtime);
    const before = await readPosture(deviceUdid);
    if (!before.supported) throw new Error("App Store Duo screenshots need an iPhone Duo simulator.");
    const root = await deps.resolveScopedRootForSession({ projectRoot: shotArgs.projectRoot, laneId: shotArgs.laneId }, runtime);
    const directory = path.join(root, ...deps.screenshotSegments);
    await fs.promises.mkdir(directory, { recursive: true });
    const shots: AppleDuoAppStoreScreenshotsResult["shots"] = [];
    const take = async (display: "cover" | "inner", pose: AppleDevicePose) => {
      const screenId = APPLE_DEVICE_POSE_TARGETS[pose].screenId;
      await foldAndSettle(deviceUdid, { pose }, APP_STORE_FOLD_SETTLE_MS);
      await sleep(LAYOUT_SETTLE_MS);
      const filePath = path.join(directory, `app-store-duo-${display}-${randomUUID().slice(0, 8)}.png`);
      // `simctl io` hands the write to CoreSimulatorService, which cannot raise
      // macOS's external-drive prompt (a project on another drive fails with
      // "Operation not permitted"): capture into the temp folder, then ADE
      // writes the file.
      const capturePath = path.join(os.tmpdir(), `ade-duo-shot-${randomUUID().slice(0, 8)}.png`);
      try {
        await deps.run("xcrun", ["simctl", "io", deviceUdid, "screenshot", `--display=${screenId}`, capturePath], { timeoutMs: 30_000 });
        await writeNoFollow(filePath, await fs.promises.readFile(capturePath));
      } finally {
        await fs.promises.rm(capturePath, { force: true }).catch(() => {});
      }
      const size = deps.readPngSize(filePath);
      const shot = { deviceUdid, filePath, capturedAt: deps.nowIso(), width: size?.width ?? 0, height: size?.height ?? 0 };
      const proofArtifactId = deps.fileScreenshotAsProof(shot, {
        ...shotArgs,
        caption: `App Store · iPhone Duo ${display} display ${shot.width}×${shot.height}`,
      }, runtime);
      shots.push({ display, width: shot.width, height: shot.height, filePath, proofArtifactId });
    };
    return deps.enqueueControl("posture", async () => {
      try {
        await take("cover", "closed");
        await take("inner", "open");
      } finally {
        if (before.angle !== null) {
          await deps.helperSend({ type: "posture", udid: deviceUdid, angle: before.angle }).catch((cause: unknown) => {
            deps.logger.warn("apple.duo_hinge_restore_failed", {
              udid: deviceUdid,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          });
        }
      }
      return { shots };
    }, APPLE_DUO_APP_STORE_SHOTS_TIMEOUT_MS);
  };

  /**
   * `ade apple render`: renders need a mounted 3D view, so the request goes
   * to the Apple pane open for the lane (on any desktop pinned to this
   * machine), which acks within 5 s and reports when it has filed the proof.
   */
  const pendingRenders = new Map<string, {
    /** True for the first pane to take it; every later one stands down. */
    ack: () => boolean;
    complete: (result: AppleRenderRequestResult) => void;
  }>();
  const requestRender = async (renderArgs: AppleRenderRequestArgs): Promise<AppleRenderRequestResult> => {
    deps.assertDarwin();
    const runtime = deps.resolveRuntime(renderArgs);
    const request = renderArgs?.request;
    if (!request || !Array.isArray(request.angles) || request.angles.length === 0) {
      throw new Error("A render needs at least one angle.");
    }
    const requestId = randomUUID();
    let acked = false;
    const result = new Promise<AppleRenderRequestResult>((resolve, reject) => {
      const ackTimer = setTimeout(() => {
        if (acked) return;
        pendingRenders.delete(requestId);
        reject(new Error(
          "No Apple Development pane is open for this lane. Open it in ADE (3D view available), then render again.",
        ));
      }, 5_000);
      const doneTimer = setTimeout(() => {
        pendingRenders.delete(requestId);
        reject(new Error("The render did not finish within 4 minutes."));
      }, 240_000);
      (doneTimer as unknown as { unref?: () => void }).unref?.();
      pendingRenders.set(requestId, {
        ack: () => {
          if (acked) return false;
          acked = true;
          clearTimeout(ackTimer);
          return true;
        },
        complete: (value) => {
          clearTimeout(ackTimer);
          clearTimeout(doneTimer);
          pendingRenders.delete(requestId);
          resolve(value);
        },
      });
    });
    deps.emit({ type: "apple.render.request", laneId: runtime.key ?? null, requestId, request });
    return result;
  };
  const renderAck = async (ackArgs: { requestId?: string }): Promise<{ ok: boolean }> => {
    const pending = typeof ackArgs?.requestId === "string" ? pendingRenders.get(ackArgs.requestId) : undefined;
    return { ok: pending ? pending.ack() : false };
  };
  const renderComplete = async (doneArgs: { requestId?: string; filed?: number; error?: string | null }): Promise<{ ok: boolean }> => {
    const pending = typeof doneArgs?.requestId === "string" ? pendingRenders.get(doneArgs.requestId) : undefined;
    pending?.complete({
      filed: typeof doneArgs.filed === "number" ? doneArgs.filed : 0,
      error: typeof doneArgs.error === "string" ? doneArgs.error : null,
    });
    return { ok: Boolean(pending) };
  };

  /**
   * File one 3D render (a PNG still or the WebM turntable) to the chat's and
   * lane's proof drawer on THIS machine, the one that owns the device. The
   * render is drawn by whichever window shows the pane, which may be another
   * machine; its bytes come here so the proof lands where the chat lives.
   */
  const attachRenderProof = async (proofArgs: Scope & { dataUrl?: string | null; title?: string | null }): Promise<{ proofArtifactId: string | null }> => {
    deps.assertDarwin();
    const runtime = deps.resolveRuntime(proofArgs);
    const png = decodeScenePngDataUrl(proofArgs.dataUrl ?? null);
    const webm = png ? null : decodeSceneWebmDataUrl(proofArgs.dataUrl ?? null);
    const bytes = png ?? webm;
    if (!bytes) throw new Error("A render proof must be a PNG or WebM data URL.");
    const root = await deps.resolveScopedRootForSession({ projectRoot: proofArgs.projectRoot, laneId: proofArgs.laneId }, runtime);
    const directory = path.join(root, ...deps.screenshotSegments);
    await fs.promises.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `render-${randomUUID().slice(0, 8)}.${webm ? "webm" : "png"}`);
    await writeNoFollow(filePath, bytes);
    const size = png ? deps.readPngSize(filePath) : null;
    const title = (typeof proofArgs.title === "string" ? proofArgs.title.trim() : "") || "3D render";
    const proofArtifactId = deps.fileScreenshotAsProof(
      { deviceUdid: "", filePath, capturedAt: deps.nowIso(), width: size?.width ?? 0, height: size?.height ?? 0 },
      { ...proofArgs, caption: title },
      runtime,
      webm ? { kind: "video_recording", mimeType: "video/webm" } : { kind: "screenshot", mimeType: "image/png" },
    );
    return { proofArtifactId };
  };

  return {
    attachRenderProof,
    readPosture,
    screenshotDisplayArgs,
    setPosture,
    getPosture,
    getDuoModel,
    addDuoSkill,
    duoAppStoreScreenshots,
    requestRender,
    renderAck,
    renderComplete,
  };
}

export type AppleDuoService = ReturnType<typeof createAppleDuoService>;
