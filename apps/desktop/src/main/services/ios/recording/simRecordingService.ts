import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ADE_ACCENT_COLOR } from "../../../../shared/themeTokens";
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
 * 1. The first injected input on a device with no running recording starts one,
 *    tagged `auto`, owned by the calling chat.
 * 2. It stops at the end of that chat's turn, or after ten minutes, whichever
 *    comes first.
 * 3. `record-start` while an auto recording runs **converts** it — no restart,
 *    no gap, no cap — so "let me record that" never costs the first minute.
 * 4. An agent may delete a recording it owns and has not pinned. Pinned ones
 *    are refused with `APPLE_RECORDING_PINNED`; another chat's are refused with
 *    the ordinary cooperative-guard error.
 * 5. `proof-bundle` pins the active recording (or this chat's latest), files it
 *    into the proof drawer, and makes it undeletable.
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
};

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
  }): Promise<SimRecording | null>;
  list(args: { laneId: string }): Promise<SimRecording[]>;
  remove(args: { laneId: string; id: string; chatSessionId: string | null; force?: boolean }): Promise<void>;
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
};

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
  /** The proof drawer. Absent means `pinActiveOrLatest` still pins locally. */
  artifactFiler?: AppleRecordingArtifactFiler | null;
  fps?: number;
  logger?: {
    warn?: (event: string, data?: Record<string, unknown>) => void;
    info?: (event: string, data?: Record<string, unknown>) => void;
  } | null;
};

/**
 * The instance the chat turn lifecycle talks to.
 *
 * A module-level handle rather than another constructor argument threaded
 * through `main.ts` → `agentChatService` → the provider layer, because the
 * turn-end hook is *one* fire-and-forget call and the alternative is five files
 * of wiring for it. Only a service with a real helper transport claims the
 * handle, so unit 2A's inert fallback (`createSimRecordingService()` with no
 * deps) cannot shadow the wired one.
 */
let turnEndTarget: SimRecordingService | null = null;

/** Called by `createSimRecordingService`; exported for tests. */
export function setActiveSimRecordingService(service: SimRecordingService | null): void {
  turnEndTarget = service;
}

/**
 * Tell recording that a chat turn finished.
 *
 * Fire-and-forget and error-safe by construction: a chat turn must settle
 * whether or not a video got written, so this returns void and swallows
 * everything. This is the only function the chat lifecycle imports.
 */
export function notifySimRecordingTurnEnded(chatSessionId: string | null | undefined): void {
  if (!chatSessionId || !turnEndTarget) return;
  try {
    void turnEndTarget.onTurnEnded(chatSessionId).catch(() => {});
  } catch {
    // Unreachable in practice; kept so a future synchronous throw cannot
    // escape into the turn-settle path.
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
    await transport.send({
      type: "record-start",
      udid: args.udid,
      path: target,
      overlays,
      fps: deps.fps ?? 30,
      accentColor: accent(),
    });

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
    options: { reason: "requested" | "turn-end" | "cap"; discard?: boolean },
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
      writeSidecar(finished);
      return finished;
    })();

    entry.stopping = run;
    return run;
  };

  const removeFiles = (record: SimRecording): void => {
    for (const file of [record.path, sidecarPath(record.laneId, record.id)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        warn("apple.recording.remove_failed", { file, error: String(error) });
      }
    }
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
    async noteInput(input) {
      if (disposed) return;
      try {
        let entry = active.get(input.laneId);
        if (!entry) {
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
      const entry = active.get(args.laneId);
      if (!entry) return null;
      assertOwner(entry, args.chatSessionId);
      const discard = args.discard === true && args.keep !== true;
      return stopActive(args.laneId, { reason: "requested", discard });
    },

    async list(args) {
      return listLane(args.laneId);
    },

    async remove(args) {
      const activeEntry = active.get(args.laneId);
      if (activeEntry?.record.id === args.id) {
        assertOwner(activeEntry, args.chatSessionId);
        if (activeEntry.record.proof) throw new AppleRecordingPinnedError(args.id);
        await stopActive(args.laneId, { reason: "requested", discard: true });
        return;
      }

      const record = readSidecar(args.laneId, args.id);
      if (!record) return;
      // Pinned wins over `force`. The drawer hides the delete action entirely
      // for proof, and a flag must not be a way around that.
      if (record.proof) throw new AppleRecordingPinnedError(args.id);
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

      const pinned: SimRecording = { ...target, proof: true };
      writeSidecar(pinned);

      try {
        deps.artifactFiler?.ingest({
          backend: { name: "apple-device", style: "local_fallback", toolName: "apple_record" },
          ...(args.chatSessionId ? { owners: [{ kind: "chat_session", id: args.chatSessionId }] } : {}),
          ...(deps.projectRoot ? { callerRoot: deps.projectRoot } : {}),
          inputs: [
            {
              kind: "video_recording",
              title: pinned.label ?? `Apple device recording · ${pinned.udid.slice(0, 8)}`,
              description: "Screen recording of the lane's Apple device, with input overlays.",
              path: pinned.path,
              mimeType: "video/mp4",
              metadata: {
                laneId: pinned.laneId,
                udid: pinned.udid,
                durationMs: pinned.durationMs,
                overlays: pinned.overlays,
                mode: pinned.mode,
              },
            },
          ],
        });
      } catch (error) {
        // The pin is what makes it undeletable, and it is already on disk.
        // Failing to copy it into the drawer must not undo that.
        warn("apple.recording.proof_file_failed", { id: pinned.id, error: String(error) });
      }

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

    dispose() {
      disposed = true;
      if (turnEndTarget === service) turnEndTarget = null;
      for (const entry of active.values()) {
        if (entry.capTimer) clearTimeout(entry.capTimer);
        entry.capTimer = null;
      }
      active.clear();
    },
  };

  // Only a wired service answers the turn-end hook; the no-deps fallback that
  // unit 2A constructs to keep the tree compiling must not claim it.
  if (deps.transport && deps.projectRoot) setActiveSimRecordingService(service);

  return service;
}
