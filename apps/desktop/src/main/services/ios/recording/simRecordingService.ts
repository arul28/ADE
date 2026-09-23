import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ADE_ACCENT_COLOR } from "../../../../shared/themeTokens";
import { APPLE_DEVICE_ALREADY_RECORDING_CODE, type AppleInputSource } from "../../../../shared/types/iosSimulator";
import type { SimHelperTransport } from "../simHelperClient";

/**
 * Recording for the Apple device environment.
 *
 * The interesting half of this file is not "write an MP4" — the helper does
 * that (`native/ADESimHelper/Sources/ADESimHelperCore/RecordingSession.swift`).
 * It is the **auto-record contract** from `docs/plans/apple-device-env.md` §5,
 * which exists so an agent's verification video is a by-product of driving the
 * device rather than something it has to remember to ask for:
 *
 * 1. The first AGENT input on a device with no running recording starts one,
 *    tagged `auto`, owned by the calling chat. A person driving the pane never
 *    starts one (round 3, A2) — see `noteInput`'s `source`.
 * 2. It stops at the end of that chat's turn, or after ten minutes, whichever
 *    comes first.
 * 3. `record-start` while an auto recording runs **converts** it — no restart,
 *    no gap, no cap — so "let me record that" never costs the first minute.
 * 4. Every recording that stops is filed into the proof drawer at once (round
 *    3, A3), attributed to the chat that owns it, captioned
 *    "Simulator recording · {device} · {duration}". There is no pin step.
 * 5. An agent may delete a recording it owns, but not one filed as proof
 *    (`APPLE_RECORDING_PINNED`); another chat's are refused with the ordinary
 *    cooperative-guard error. The user's own delete row passes `allowProof`
 *    and removes the drawer entry with the file.
 * 6. There is **no auto-delete**, ever. `totalBytes()` is what the storage
 *    warning reads; nothing here acts on it.
 *
 * Files live at `<projectRoot>/.ade/artifacts/apple-recordings/<laneId>/<id>.mp4`
 * with an `<id>.json` sidecar holding the `SimRecording`. The sidecar is the
 * database: a directory that survives a crash mid-recording still lists, and
 * lane delete is `rm -rf` of one directory rather than a migration.
 */

export type SimRecording = {
  id: string;
  laneId: string;
  udid: string;
  chatSessionId: string | null;
  path: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  bytes: number | null;
  mode: "auto" | "manual";
  proof: boolean;
  label: string | null;
  overlays: boolean;
  /**
   * The proof-drawer artifact this recording was filed as, once it stopped.
   *
   * Round 3 made every finished recording proof (see `stopActive`), so this is
   * the handle "Open in proof" opens and the row `remove` deletes alongside the
   * file. Null means the filing failed or there was no drawer to file into —
   * the video is still on disk, which is why that is a warning and not a throw.
   */
  proofArtifactId?: string | null;
};

export type { AppleInputSource };

export interface SimRecordingService {
  /** Auto-record start + overlay events. Called from every injected-input path. */
  noteInput(input: {
    laneId: string;
    udid: string;
    chatSessionId: string | null;
    kind: "tap" | "type" | "drag" | "select" | "open-url";
    x?: number;
    y?: number;
    text?: string;
    /**
     * Who drove the device. Only `agent` may START a recording.
     *
     * Round 2 auto-started on ANY injected input, so a person tapping their own
     * simulator in the pane silently began writing an MP4 — three of them sat
     * in `.ade/artifacts` after one live test with nothing on screen saying so.
     * A human driving the pane is not producing verification evidence; an agent
     * driving it headlessly is, which is the whole point of the auto-record
     * contract. Human input during an agent's recording is still overlaid,
     * because it is on the screen being recorded.
     */
    source?: AppleInputSource;
  }): Promise<void>;
  start(args: {
    laneId: string;
    udid: string;
    chatSessionId: string | null;
    overlays?: boolean;
    label?: string;
  }): Promise<SimRecording>;
  stop(args: {
    laneId: string;
    keep?: boolean;
    discard?: boolean;
    chatSessionId: string | null;
    /**
     * The lane's device. When this service has no recording for the lane but
     * the helper is still writing one on this device, the stop reaches the
     * helper anyway. Without it a recording the service lost track of could
     * not be stopped by any ADE command.
     */
    udid?: string | null;
  }): Promise<SimRecording | null>;
  /**
   * Stop whatever records this device, in any lane. Called before the device
   * powers off, is deleted, or moves to another lane. A recording that
   * outlives its device keeps the helper's slot for that device, and every
   * later `record-start` on it is refused.
   */
  stopDevice(args: { udid: string; reason: "device-off" | "released" }): Promise<SimRecording | null>;
  list(args: { laneId: string }): Promise<SimRecording[]>;
  remove(args: {
    laneId: string;
    id: string;
    chatSessionId: string | null;
    force?: boolean;
    /**
     * The person asked, from the drawer's ⋯ menu.
     *
     * Every stopped recording is proof now (A3), so the old blanket "pinned
     * recordings cannot be deleted" would mean nothing is ever deletable. The
     * protection still holds for agents — which is who it was written for —
     * and this flag, set only by the desktop's own delete row, is the user
     * saying they want the video and its drawer row gone.
     */
    allowProof?: boolean;
  }): Promise<void>;
  /**
   * The recording running on a lane right now, or null.
   *
   * Synchronous and in-memory: `getStatus` carries it (round 5 §S4) so one
   * status read tells an agent whether something is already recording. An
   * agent that does not know cannot decide whether its `record-start`
   * converts an auto recording to manual — and therefore whether the stop is
   * now its own job.
   */
  active(args: { laneId: string }): SimRecording | null;
  /** proof-bundle: pins the active recording, or the latest from this chat. */
  pinActiveOrLatest(args: { laneId: string; chatSessionId: string | null }): Promise<SimRecording | null>;
  /** Stops auto recordings owned by that chat. */
  onTurnEnded(chatSessionId: string): Promise<void>;
  /**
   * Bytes on disk, for the Diagnostics storage warning
   * (`apple.recordingsWarnBytes`). A number, never an action: nothing in ADE
   * deletes a recording the user did not ask it to.
   */
  totalBytes(args?: { laneId?: string }): Promise<number>;
  /**
   * The helper process died. Every recording it was writing died with it, so
   * the in-memory entries are dropped and their sidecars marked ended.
   *
   * Without this the lane kept an "active" recording no helper held: the pane
   * showed it running forever, the next agent input noted overlays against
   * it instead of starting a new one, and `record-stop` sent a stop to a
   * helper that had never heard of it. Returns the recordings it ended.
   */
  helperExited(): SimRecording[];
  /** Stop everything and drop timers. Called on shutdown. */
  dispose(): void;
}

export const APPLE_RECORDING_PINNED_CODE = "APPLE_RECORDING_PINNED" as const;
export const APPLE_OWNED_BY_OTHER_SESSION_CODE = "APPLE_OWNED_BY_OTHER_SESSION" as const;
export const APPLE_HELPER_UNAVAILABLE_CODE = "APPLE_HELPER_UNAVAILABLE" as const;

/** How long an auto recording may run before it stops itself. */
export const AUTO_RECORDING_MAX_MS = 10 * 60 * 1000;

/**
 * The accent used for tap rings.
 *
 * ADE's own, not a made-up blue: `shared/themeTokens.ts` mirrors the
 * renderer's `--color-accent` precisely so the compositor — which runs in a
 * process with no stylesheet — draws the same purple the rest of the app does.
 */
export const DEFAULT_ACCENT_COLOR = ADE_ACCENT_COLOR;

/**
 * Refusal to touch pinned proof.
 *
 * Its own class rather than a flag on a generic error because the CLI and the
 * drawer both branch on `code`, and because "the delete you asked for did not
 * happen" needs to survive a `catch (error) { log(String(error)) }`.
 */
export class AppleRecordingPinnedError extends Error {
  readonly code = APPLE_RECORDING_PINNED_CODE;
  readonly recordingId: string;

  constructor(recordingId: string) {
    super(
      `${APPLE_RECORDING_PINNED_CODE}: recording ${recordingId} is pinned as proof and cannot be deleted.`,
    );
    this.name = "AppleRecordingPinnedError";
    this.recordingId = recordingId;
  }
}

/**
 * The existing cooperative-guard shape, spelled for recordings.
 *
 * Deliberately a local class rather than an import of
 * `IosSimulatorOwnedBySessionError`: `iosSimulatorService` imports this module,
 * so importing it back would be a cycle. The message convention is the one
 * that file documents — state the fact and the code, and stop; the CLI adds the
 * "now run…" hint from `code`.
 */
export class AppleRecordingOwnedBySessionError extends Error {
  readonly code = APPLE_OWNED_BY_OTHER_SESSION_CODE;
  readonly currentChatSessionId: string | null;
  readonly laneId: string;

  constructor(args: { laneId: string; owner: string | null; startedAt: string | null }) {
    const age = describeAge(args.startedAt);
    super(
      [
        `${APPLE_OWNED_BY_OTHER_SESSION_CODE}: the recording on lane ${args.laneId} is owned by chat session ${args.owner ?? "unknown"}`,
        age ? ` (started ${age})` : "",
        ".",
      ].join(""),
    );
    this.name = "AppleRecordingOwnedBySessionError";
    this.currentChatSessionId = args.owner;
    this.laneId = args.laneId;
  }
}

export { APPLE_DEVICE_ALREADY_RECORDING_CODE };

/**
 * Another lane's recording holds this device.
 *
 * The helper records per device and this service records per lane, so the
 * helper's refusal alone cannot say who holds the device. This error names
 * the lane, so that the caller can stop the recording there.
 */
export class AppleDeviceAlreadyRecordingError extends Error {
  readonly code = APPLE_DEVICE_ALREADY_RECORDING_CODE;
  readonly laneId: string;
  readonly udid: string;

  constructor(args: { laneId: string; udid: string }) {
    super(`${APPLE_DEVICE_ALREADY_RECORDING_CODE}: lane ${args.laneId} is recording device ${args.udid}.`);
    this.name = "AppleDeviceAlreadyRecordingError";
    this.laneId = args.laneId;
    this.udid = args.udid;
  }
}

/** The helper's error code, when the error came from the helper. */
function helperErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export class AppleRecordingUnavailableError extends Error {
  readonly code = APPLE_HELPER_UNAVAILABLE_CODE;

  constructor(message: string) {
    super(`${APPLE_HELPER_UNAVAILABLE_CODE}: ${message}`);
    this.name = "AppleRecordingUnavailableError";
  }
}

function describeAge(iso: string | null): string | null {
  if (!iso) return null;
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** The directory a lane's recordings live in. Lane delete removes it whole. */
export function appleRecordingsDirectory(projectRoot: string, laneId: string): string {
  return path.join(projectRoot, ".ade", "artifacts", "apple-recordings", laneId);
}

/** Minimal shape of the proof-drawer filer, so tests need no database. */
export type AppleRecordingArtifactFiler = {
  ingest(request: {
    backend: { name: string; style?: string | null; toolName?: string | null };
    inputs: Array<Record<string, unknown>>;
    owners?: Array<{ kind: string; id: string }>;
    callerRoot?: string | null;
  }): unknown;
  /** Deleting the video deletes its drawer row too. Optional so tests can omit it. */
  deleteArtifacts?(args: { artifactIds: string[] }): unknown;
};

/**
 * The artifact id an `ingest` returned, or null.
 *
 * Read defensively rather than typed against the broker: this module is
 * imported by the brain and by tests that pass a two-line fake filer, and a
 * hard dependency on the broker's result shape would make both of those carry
 * the whole `computerUseArtifacts` type surface.
 */
/** The owners a finished recording is filed under: its chat, and its lane. */
function recordingOwners(record: { chatSessionId?: string | null; laneId?: string | null }): Array<{ kind: "chat_session" | "lane"; id: string }> {
  return [
    ...(record.chatSessionId ? [{ kind: "chat_session" as const, id: record.chatSessionId }] : []),
    ...(record.laneId ? [{ kind: "lane" as const, id: record.laneId }] : []),
  ];
}

export function readArtifactId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const artifacts = (result as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
  const first = artifacts[0];
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  for (const key of ["artifactId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export type SimRecordingServiceDeps = {
  /** The helper. Absent means recording is unavailable, not broken. */
  transport?: SimHelperTransport | null;
  projectRoot?: string | null;
  /**
   * Read one of the `apple.recordingOverlays.*` settings. Unit 2E adds the
   * keys; until then — and whenever the read fails — overlays are ON, because
   * the failure mode of the other default is an agent silently producing
   * undecorated proof.
   */
  readOverlaySetting?: (key: "apple.recordingOverlays.tapRings" | "apple.recordingOverlays.keyBadges") => boolean | undefined;
  /** Theme primary, for the tap ring. */
  accentColor?: () => string | null | undefined;
  /** The proof drawer. Absent means a stopped recording is still kept locally. */
  artifactFiler?: AppleRecordingArtifactFiler | null;
  /** Device name for the proof caption. Falls back to the udid's first eight. */
  resolveDeviceName?: (udid: string) => string | null | undefined;
  fps?: number;
  logger?: {
    warn?: (event: string, data?: Record<string, unknown>) => void;
    info?: (event: string, data?: Record<string, unknown>) => void;
  } | null;
};

/**
 * The instances the chat turn lifecycle talks to.
 *
 * A module-level handle rather than another constructor argument threaded
 * through `main.ts` → `agentChatService` → the provider layer, because the
 * turn-end hook is *one* fire-and-forget call and the alternative is five files
 * of wiring for it. Only a service with a real helper transport claims a slot,
 * so unit 2A's inert fallback (`createSimRecordingService()` with no deps)
 * cannot shadow a wired one.
 *
 * A set, not a single slot: one service is built per open project, and a chat
 * session id resolves to at most one of them. Overwriting the handle meant only
 * the newest project's recorder ever heard a turn end, so auto-recordings in
 * every other project ran to the ten-minute cap. Notifying all is safe — each
 * `onTurnEnded` no-ops for a session it does not own.
 */
const turnEndTargets = new Set<SimRecordingService>();

/** Called by `createSimRecordingService`; exported for tests. */
export function setActiveSimRecordingService(service: SimRecordingService | null): void {
  if (service) turnEndTargets.add(service);
  else turnEndTargets.clear();
}

/**
 * Tell recording that a chat turn finished.
 *
 * Fire-and-forget and error-safe by construction: a chat turn must settle
 * whether or not a video got written, so this returns void and swallows
 * everything. This is the only function the chat lifecycle imports.
 */
export function notifySimRecordingTurnEnded(chatSessionId: string | null | undefined): void {
  if (!chatSessionId) return;
  for (const target of turnEndTargets) {
    try {
      void target.onTurnEnded(chatSessionId).catch(() => {});
    } catch {
      // Unreachable in practice; kept so a future synchronous throw cannot
      // escape into the turn-settle path.
    }
  }
}

type ActiveRecording = {
  record: SimRecording;
  /** Fires the ten-minute cap. Null once converted to manual. */
  capTimer: ReturnType<typeof setTimeout> | null;
  /** Serialises stop against a concurrent turn-end and cap expiry. */
  stopping: Promise<SimRecording | null> | null;
};

export function createSimRecordingService(deps: SimRecordingServiceDeps = {}): SimRecordingService {
  const active = new Map<string, ActiveRecording>();
  let disposed = false;

  const warn = (event: string, data?: Record<string, unknown>): void => {
    try {
      deps.logger?.warn?.(event, data);
    } catch {
      // A logger that throws must not take a recording with it.
    }
  };

  const requireRoot = (): string => {
    const root = deps.projectRoot;
    if (!root) {
      throw new AppleRecordingUnavailableError("No project root is bound, so recordings have nowhere to live.");
    }
    return root;
  };

  const requireTransport = (): SimHelperTransport => {
    if (!deps.transport) {
      throw new AppleRecordingUnavailableError("The Apple device helper is not running.");
    }
    return deps.transport;
  };

  const laneDir = (laneId: string): string => appleRecordingsDirectory(requireRoot(), laneId);
  const sidecarPath = (laneId: string, id: string): string => path.join(laneDir(laneId), `${id}.json`);
  const moviePath = (laneId: string, id: string): string => path.join(laneDir(laneId), `${id}.mp4`);

  const writeSidecar = (record: SimRecording): void => {
    const file = sidecarPath(record.laneId, record.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  };

  const readSidecar = (laneId: string, id: string): SimRecording | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(sidecarPath(laneId, id), "utf8")) as SimRecording;
      return parsed && typeof parsed.id === "string" ? parsed : null;
    } catch {
      // A half-written sidecar is a record we cannot describe, which is the
      // same thing as a record that is not there.
      return null;
    }
  };

  const overlaysEnabled = (): boolean => {
    try {
      const rings = deps.readOverlaySetting?.("apple.recordingOverlays.tapRings");
      const badges = deps.readOverlaySetting?.("apple.recordingOverlays.keyBadges");
      // Either decoration switched on is a reason to composite; the helper is
      // told which by the per-event calls below, not by this flag.
      return rings !== false || badges !== false;
    } catch {
      return true;
    }
  };

  const ringsEnabled = (): boolean => {
    try {
      return deps.readOverlaySetting?.("apple.recordingOverlays.tapRings") !== false;
    } catch {
      return true;
    }
  };

  const badgesEnabled = (): boolean => {
    try {
      return deps.readOverlaySetting?.("apple.recordingOverlays.keyBadges") !== false;
    } catch {
      return true;
    }
  };

  const accent = (): string => {
    try {
      const value = deps.accentColor?.();
      return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ACCENT_COLOR;
    } catch {
      return DEFAULT_ACCENT_COLOR;
    }
  };

  const assertOwner = (entry: ActiveRecording, chatSessionId: string | null): void => {
    const owner = entry.record.chatSessionId;
    // A null caller is the desktop user acting through the UI, who outranks
    // the cooperative guard — the guard exists to keep two agents apart.
    if (!owner || !chatSessionId || owner === chatSessionId) return;
    throw new AppleRecordingOwnedBySessionError({
      laneId: entry.record.laneId,
      owner,
      startedAt: entry.record.startedAt,
    });
  };

  const armCap = (laneId: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      void stopActive(laneId, { reason: "cap" }).catch((error: unknown) => {
        warn("apple.recording.cap_stop_failed", { laneId, error: String(error) });
      });
    }, AUTO_RECORDING_MAX_MS);
    // A ten-minute timer must not be the reason Electron refuses to quit.
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  };

  const beginRecording = async (args: {
    laneId: string;
    udid: string;
    chatSessionId: string | null;
    mode: "auto" | "manual";
    overlays?: boolean;
    label?: string | null;
  }): Promise<SimRecording> => {
    const transport = requireTransport();
    const id = randomUUID();
    const target = moviePath(args.laneId, id);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const overlays = args.overlays ?? overlaysEnabled();
    const sendStart = () => transport.send({
      type: "record-start",
      udid: args.udid,
      path: target,
      overlays,
      fps: deps.fps ?? 30,
      accentColor: accent(),
    });
    try {
      await sendStart();
    } catch (error) {
      if (helperErrorCode(error) !== "already-recording") throw error;
      // The helper holds a recording on this device. If one of this service's
      // lanes owns it, that is a real conflict, and the caller must hear
      // which lane. If none does, the recording is an orphan: this service
      // lost it (a `record-start` that timed out after the helper began, or a
      // `record-stop` whose reply never arrived). Finish the orphan so that
      // its video is not lost, then start again.
      for (const [laneId, entry] of active) {
        if (entry.record.udid === args.udid) {
          throw new AppleDeviceAlreadyRecordingError({ laneId, udid: args.udid });
        }
      }
      await reclaimHelperRecording(args.udid, "orphan-on-start");
      await sendStart();
    }

    const record: SimRecording = {
      id,
      laneId: args.laneId,
      udid: args.udid,
      chatSessionId: args.chatSessionId,
      path: target,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      bytes: null,
      mode: args.mode,
      proof: false,
      label: args.label ?? null,
      overlays,
    };
    writeSidecar(record);
    active.set(args.laneId, {
      record,
      capTimer: args.mode === "auto" ? armCap(args.laneId) : null,
      stopping: null,
    });
    return record;
  };

  /**
   * Stop whatever is recording on a lane.
   *
   * Idempotent and re-entrant on purpose: the ten-minute cap, the turn-end
   * hook and an explicit `record-stop` can all land at once, and only one of
   * them may talk to the helper.
   */
  const stopActive = async (
    laneId: string,
    options: { reason: "requested" | "turn-end" | "cap" | "device-off" | "released"; discard?: boolean },
  ): Promise<SimRecording | null> => {
    const entry = active.get(laneId);
    if (!entry) return null;
    if (entry.stopping) return entry.stopping;

    const run = (async (): Promise<SimRecording | null> => {
      if (entry.capTimer) clearTimeout(entry.capTimer);
      entry.capTimer = null;
      active.delete(laneId);

      let durationMs: number | null = null;
      let bytes: number | null = null;
      try {
        const reply = await requireTransport().send({ type: "record-stop", udid: entry.record.udid });
        durationMs = typeof reply.durationMs === "number" ? reply.durationMs : null;
        bytes = typeof reply.bytes === "number" ? reply.bytes : null;
      } catch (error) {
        // The helper may have died with the file half-written. The sidecar
        // still gets an end time so the drawer can show what happened rather
        // than a recording that appears to be running forever.
        warn("apple.recording.stop_failed", { laneId, reason: options.reason, error: String(error) });
      }

      if (bytes === null) {
        try {
          bytes = fs.statSync(entry.record.path).size;
        } catch {
          bytes = null;
        }
      }

      const finished: SimRecording = {
        ...entry.record,
        endedAt: new Date().toISOString(),
        durationMs,
        bytes,
      };

      if (options.discard) {
        removeFiles(finished);
        return null;
      }
      // Every recording that stops is proof (round 3, A3). Round 2 wrote the
      // file and waited for someone to press "Pin to proof"; nobody ever did,
      // because nothing on screen said the file existed. Filing it here means
      // the drawer is the one place recordings live, and the row below the
      // viewport is a receipt rather than a call to action.
      const filed = fileAsProof(finished);
      writeSidecar(filed);
      return filed;
    })();

    entry.stopping = run;
    return run;
  };

  /** "0:23" / "1:04:02" — the caption's duration part. */
  const captionDuration = (record: SimRecording): string => {
    const total = Math.max(0, Math.round((record.durationMs ?? 0) / 1000));
    const seconds = String(total % 60).padStart(2, "0");
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
      : `${minutes}:${seconds}`;
  };

  const deviceLabel = (udid: string): string => {
    try {
      const name = deps.resolveDeviceName?.(udid);
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      // A name lookup that fails is a cosmetic loss, not a failed recording.
    }
    return udid.slice(0, 8);
  };

  /**
   * File a finished recording into the proof drawer and mark it proof.
   *
   * Returns the record to persist either way: a drawer that refused the file
   * must not cost the user the video, so the failure path keeps the sidecar
   * (with `proofArtifactId: null`) rather than throwing out of `stopActive`.
   */
  const fileAsProof = (record: SimRecording): SimRecording => {
    const caption = `Simulator recording · ${deviceLabel(record.udid)} · ${captionDuration(record)}`;
    let artifactId: string | null = null;
    try {
      const result = deps.artifactFiler?.ingest({
        backend: { name: "apple-device", style: "local_fallback", toolName: "apple_record" },
        // Same rule as the screenshot path: own it by LANE as well as by chat,
        // so an agent-started recording with no chat session still belongs to
        // the lane instead of to nobody. An artifact with an empty owner list
        // is returned by no `ade proof list` scope, project-wide included.
        ...(recordingOwners(record).length ? { owners: recordingOwners(record) } : {}),
        ...(deps.projectRoot ? { callerRoot: deps.projectRoot } : {}),
        inputs: [
          {
            kind: "video_recording",
            title: record.label ?? caption,
            description: "Screen recording of the lane's Apple device, with input overlays.",
            path: record.path,
            mimeType: "video/mp4",
            metadata: {
              laneId: record.laneId,
              udid: record.udid,
              durationMs: record.durationMs,
              overlays: record.overlays,
              mode: record.mode,
              recordingId: record.id,
            },
          },
        ],
      });
      artifactId = readArtifactId(result);
    } catch (error) {
      warn("apple.recording.proof_file_failed", { id: record.id, error: String(error) });
    }
    return { ...record, proof: true, proofArtifactId: artifactId };
  };

  const removeFiles = (record: SimRecording): void => {
    if (record.proofArtifactId) {
      try {
        // The broker's delete may be async; the video bytes come off disk first,
        // and a rejected drawer delete must not surface as a recorder failure.
        void Promise.resolve(deps.artifactFiler?.deleteArtifacts?.({ artifactIds: [record.proofArtifactId] }))
          .catch((error: unknown) => {
            warn("apple.recording.proof_delete_failed", { id: record.id, error: String(error) });
          });
      } catch (error) {
        // The bytes are what the user asked to be rid of. A drawer row left
        // pointing at a deleted file is the broken-artifact sweeper's problem.
        warn("apple.recording.proof_delete_failed", { id: record.id, error: String(error) });
      }
    }
    for (const file of [record.path, sidecarPath(record.laneId, record.id)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        warn("apple.recording.remove_failed", { file, error: String(error) });
      }
    }
  };

  /**
   * The record for a movie the helper finished but this service had lost.
   *
   * The helper replies with the movie path, and the path names the lane and
   * the id (`apple-recordings/<laneId>/<id>.mp4`). If the sidecar from the
   * start is still there, it keeps the owner and the label. If not, the
   * record is rebuilt from the path. A path outside this project's recordings
   * directory is not this service's to file, so it stays where it is.
   */
  const orphanRecord = (
    moviePathFromHelper: string,
    udid: string,
    durationMs: number | null,
    bytes: number | null,
  ): SimRecording | null => {
    const root = path.join(requireRoot(), ".ade", "artifacts", "apple-recordings");
    const relative = path.relative(root, moviePathFromHelper);
    const parts = relative.split(/[\\/]/);
    if (relative.startsWith("..") || path.isAbsolute(relative) || parts.length !== 2 || !parts[1]!.endsWith(".mp4")) {
      warn("apple.recording.orphan_outside_project", { udid, path: moviePathFromHelper });
      return null;
    }
    const laneId = parts[0]!;
    const id = parts[1]!.slice(0, -".mp4".length);
    let size = bytes;
    if (size === null) {
      try {
        size = fs.statSync(moviePathFromHelper).size;
      } catch {
        size = null;
      }
    }
    const endedAt = new Date().toISOString();
    const known = readSidecar(laneId, id);
    if (known) return { ...known, endedAt, durationMs, bytes: size };
    return {
      id,
      laneId,
      udid,
      chatSessionId: null,
      path: moviePathFromHelper,
      startedAt: new Date(Date.now() - (durationMs ?? 0)).toISOString(),
      endedAt,
      durationMs,
      bytes: size,
      mode: "auto",
      proof: false,
      label: null,
      overlays: overlaysEnabled(),
    };
  };

  /**
   * Stop the recording the helper has on a device, whether or not this
   * service knows about it.
   *
   * The helper records per device and is the only one that knows what is
   * recording. This service's per-lane map is a copy, and a copy can drift:
   * a `record-start` can time out after the helper began, and a `record-stop`
   * reply can fail after the service forgot the entry. Before this, a drifted
   * recording could be stopped by no ADE command, survived a stream restart
   * and a power cycle, and made every later `record-start` on the device fail
   * with "This device is already recording." Only killing the helper
   * process cleared it.
   *
   * Returns null when the helper had nothing on the device.
   */
  const reclaimHelperRecording = async (
    udid: string,
    reason: "orphan-on-start" | "orphan-on-stop" | "device-off" | "released",
  ): Promise<SimRecording | null> => {
    let reply: Record<string, unknown>;
    try {
      reply = await requireTransport().send({ type: "record-stop", udid });
    } catch (error) {
      if (helperErrorCode(error) === "not-recording") return null;
      throw error;
    }
    const moviePathFromHelper = typeof reply.path === "string" ? reply.path : null;
    const durationMs = typeof reply.durationMs === "number" ? reply.durationMs : null;
    const bytes = typeof reply.bytes === "number" ? reply.bytes : null;
    warn("apple.recording.orphan_reclaimed", { udid, reason, path: moviePathFromHelper, durationMs });
    if (!moviePathFromHelper) return null;
    const record = orphanRecord(moviePathFromHelper, udid, durationMs, bytes);
    if (!record) return null;
    const filed = fileAsProof(record);
    writeSidecar(filed);
    return filed;
  };

  const listLane = (laneId: string): SimRecording[] => {
    let dir: string;
    try {
      dir = laneDir(laneId);
    } catch {
      return [];
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const records: SimRecording[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const record = readSidecar(laneId, name.slice(0, -".json".length));
      if (record) records.push(record);
    }
    // Newest first: the Recent list and `pinActiveOrLatest` both want the last
    // thing that happened, and both would otherwise sort it themselves.
    records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return records;
  };

  const sendOverlay = async (command: Record<string, unknown> & { type: string }): Promise<void> => {
    try {
      await requireTransport().send(command);
    } catch (error) {
      // Overlays are decoration. A failed one must never surface as a failed
      // tap — the tap already happened.
      warn("apple.recording.overlay_failed", { type: command.type, error: String(error) });
    }
  };

  const service: SimRecordingService = {
    active(args) {
      return active.get(args.laneId)?.record ?? null;
    },
    async noteInput(input) {
      if (disposed) return;
      try {
        let entry = active.get(input.laneId);
        if (!entry) {
          // A person tapping the pane never starts a recording. See the
          // `source` field on this method for why.
          if (input.source === "user") return;
          if (!deps.transport || !deps.projectRoot) return;
          await beginRecording({
            laneId: input.laneId,
            udid: input.udid,
            chatSessionId: input.chatSessionId,
            mode: "auto",
          });
          entry = active.get(input.laneId);
        }
        if (!entry || !entry.record.overlays) return;

        if (input.kind === "type" || input.kind === "select" || input.kind === "open-url") {
          const text = input.text?.trim();
          if (text && badgesEnabled()) {
            // `secure` is ADE's call, and ADE's call is "never send it": a
            // secure field's characters do not reach this function at all.
            // The flag is sent anyway so the helper has the last word.
            await sendOverlay({ type: "overlay-text", udid: input.udid, text, secure: false });
          }
        }
        if (typeof input.x === "number" && typeof input.y === "number" && ringsEnabled()) {
          await sendOverlay({ type: "overlay-tap", udid: input.udid, x: input.x, y: input.y });
        }
      } catch (error) {
        warn("apple.recording.note_input_failed", { laneId: input.laneId, error: String(error) });
      }
    },

    async start(args) {
      if (disposed) throw new AppleRecordingUnavailableError("The recording service has been disposed.");
      const existing = active.get(args.laneId);
      if (existing) {
        assertOwner(existing, args.chatSessionId);
        // Conversion, not restart: the file keeps going, the cap goes away,
        // and the seconds before the user pressed Record are still in it.
        if (existing.capTimer) clearTimeout(existing.capTimer);
        existing.capTimer = null;
        existing.record = {
          ...existing.record,
          mode: "manual",
          label: args.label ?? existing.record.label,
          chatSessionId: existing.record.chatSessionId ?? args.chatSessionId,
        };
        writeSidecar(existing.record);
        return existing.record;
      }
      return beginRecording({
        laneId: args.laneId,
        udid: args.udid,
        chatSessionId: args.chatSessionId,
        mode: "manual",
        overlays: args.overlays,
        label: args.label ?? null,
      });
    },

    async stop(args) {
      const discard = args.discard === true && args.keep !== true;
      const entry = active.get(args.laneId);
      if (!entry) {
        // This service has no recording on the lane. The helper can still
        // have one on the lane's device (see `reclaimHelperRecording`), so
        // ask it. A recording that no command can stop is the bug this
        // closes.
        const udid = args.udid?.trim();
        if (!udid || disposed || !deps.transport) return null;
        // Another lane's recording on the same device is not this caller's
        // to stop.
        for (const other of active.values()) {
          if (other.record.udid === udid) return null;
        }
        const reclaimed = await reclaimHelperRecording(udid, "orphan-on-stop");
        if (reclaimed && discard) {
          removeFiles(reclaimed);
          return null;
        }
        return reclaimed;
      }
      assertOwner(entry, args.chatSessionId);
      return stopActive(args.laneId, { reason: "requested", discard });
    },

    async stopDevice(args) {
      if (disposed) return null;
      const lanes = [...active].filter(([, entry]) => entry.record.udid === args.udid).map(([laneId]) => laneId);
      if (lanes.length === 0) {
        if (!deps.transport) return null;
        return reclaimHelperRecording(args.udid, args.reason);
      }
      let stopped: SimRecording | null = null;
      for (const laneId of lanes) {
        stopped = await stopActive(laneId, { reason: args.reason });
      }
      return stopped;
    },

    async list(args) {
      return listLane(args.laneId);
    },

    async remove(args) {
      const activeEntry = active.get(args.laneId);
      if (activeEntry?.record.id === args.id) {
        assertOwner(activeEntry, args.chatSessionId);
        if (activeEntry.record.proof && args.allowProof !== true) {
          throw new AppleRecordingPinnedError(args.id);
        }
        await stopActive(args.laneId, { reason: "requested", discard: true });
        return;
      }

      const record = readSidecar(args.laneId, args.id);
      if (!record) return;
      // Pinned wins over `force`, and only over `force`: `allowProof` is the
      // user's own delete row, which is allowed to take the drawer entry with
      // the file. An agent passing `force` still cannot touch proof.
      if (record.proof && args.allowProof !== true) throw new AppleRecordingPinnedError(args.id);
      if (
        args.force !== true
        && record.chatSessionId
        && args.chatSessionId
        && record.chatSessionId !== args.chatSessionId
      ) {
        throw new AppleRecordingOwnedBySessionError({
          laneId: args.laneId,
          owner: record.chatSessionId,
          startedAt: record.startedAt,
        });
      }
      removeFiles(record);
    },

    async pinActiveOrLatest(args) {
      // A recording still being written has no playable file, so pinning the
      // active one means finishing it first.
      let target = active.has(args.laneId)
        ? await stopActive(args.laneId, { reason: "requested" })
        : null;
      if (!target) {
        const candidates = listLane(args.laneId).filter((record) => record.endedAt);
        target = candidates.find((record) => !args.chatSessionId || record.chatSessionId === args.chatSessionId)
          ?? candidates[0]
          ?? null;
      }
      if (!target) return null;
      // `stopActive` already filed it. Re-filing the same bytes would put a
      // second row in the drawer for one video, so this is now a read of what
      // stopping already did — kept as a method because `proof-bundle` asks
      // "which recording belongs to this turn", which only this knows.
      // `proof`, not `proofArtifactId`: a drawer that accepted the file but
      // answered with no id still took it, and filing it twice would put two
      // rows in front of the user for one video.
      if (target.proof) return target;

      const pinned = fileAsProof(target);
      writeSidecar(pinned);
      return pinned;
    },

    async onTurnEnded(chatSessionId) {
      if (disposed || !chatSessionId) return;
      const lanes: string[] = [];
      for (const [laneId, entry] of active) {
        if (entry.record.mode !== "auto") continue;
        if (entry.record.chatSessionId !== chatSessionId) continue;
        lanes.push(laneId);
      }
      for (const laneId of lanes) {
        try {
          await stopActive(laneId, { reason: "turn-end" });
        } catch (error) {
          warn("apple.recording.turn_end_stop_failed", { laneId, error: String(error) });
        }
      }
    },

    async totalBytes(args) {
      let root: string;
      try {
        root = requireRoot();
      } catch {
        return 0;
      }
      const lanes = args?.laneId
        ? [args.laneId]
        : (() => {
          try {
            return fs.readdirSync(path.join(root, ".ade", "artifacts", "apple-recordings"));
          } catch {
            return [] as string[];
          }
        })();

      let total = 0;
      for (const laneId of lanes) {
        for (const record of listLane(laneId)) {
          if (typeof record.bytes === "number") {
            total += record.bytes;
            continue;
          }
          try {
            total += fs.statSync(record.path).size;
          } catch {
            // A recording whose file went away contributes nothing, which is
            // the honest answer for a storage warning.
          }
        }
      }
      return total;
    },

    helperExited() {
      const ended: SimRecording[] = [];
      for (const entry of active.values()) {
        if (entry.capTimer) clearTimeout(entry.capTimer);
        entry.capTimer = null;
        // Not filed as proof: the helper died before it could finish the
        // MP4, so the file is very likely unplayable. The sidecar still gets
        // an end time and whatever landed on disk, so the drawer lists what
        // happened rather than a recording that runs forever.
        let bytes: number | null = null;
        try {
          bytes = fs.statSync(entry.record.path).size;
        } catch {
          bytes = null;
        }
        const record: SimRecording = {
          ...entry.record,
          endedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - Date.parse(entry.record.startedAt)) || null,
          bytes,
        };
        try {
          writeSidecar(record);
        } catch (error) {
          warn("apple.recording.helper_exit_mark_failed", { id: entry.record.id, error: String(error) });
        }
        ended.push(record);
      }
      if (ended.length > 0) {
        warn("apple.recording.helper_exited", { ended: ended.map((record) => record.id) });
      }
      active.clear();
      return ended;
    },

    dispose() {
      disposed = true;
      turnEndTargets.delete(service);
      for (const entry of active.values()) {
        if (entry.capTimer) clearTimeout(entry.capTimer);
        entry.capTimer = null;
        // The helper finishes the movie when it quits (`SimHelperRuntime.
        // shutdown`), which follows this call. Mark the sidecar ended, so that
        // the drawer does not list a recording that runs forever.
        try {
          writeSidecar({ ...entry.record, endedAt: new Date().toISOString() });
        } catch (error) {
          warn("apple.recording.dispose_mark_failed", { id: entry.record.id, error: String(error) });
        }
      }
      active.clear();
    },
  };

  // Only a wired service answers the turn-end hook; the no-deps fallback that
  // unit 2A constructs to keep the tree compiling must not claim it.
  if (deps.transport && deps.projectRoot) setActiveSimRecordingService(service);

  return service;
}
