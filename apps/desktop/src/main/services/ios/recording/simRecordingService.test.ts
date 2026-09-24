import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLE_OWNED_BY_OTHER_SESSION_CODE,
  APPLE_RECORDING_PINNED_CODE,
  AUTO_RECORDING_MAX_MS,
  MANUAL_RECORDING_MAX_MS,
  createSimRecordingService,
  type SimRecordingService,
} from "./simRecordingService";
import { appleRecordingsDirectory } from "./appleRecordingsStore";
import { APPLE_DEVICE_ALREADY_RECORDING_CODE } from "../../../../shared/types/iosSimulator";
import { SimHelperError, type SimHelperTransport } from "../simHelperClient";

/**
 * A helper that answers instead of running.
 *
 * It records every command so the tests can assert on the *sequence* — which
 * is where the auto-record contract actually lives: "convert, do not restart"
 * is only observable as the absence of a second `record-start`.
 */
function createFakeTransport(): SimHelperTransport & {
  commands: Array<Record<string, unknown>>;
  typed(type: string): Array<Record<string, unknown>>;
  failNext(error: Error): void;
  /** Replace the reply to a command type, e.g. to play a newer helper. */
  replies: Record<string, (command: Record<string, unknown>) => Record<string, unknown>>;
} {
  const commands: Array<Record<string, unknown>> = [];
  let pendingError: Error | null = null;
  const replies: Record<string, (command: Record<string, unknown>) => Record<string, unknown>> = {};
  return {
    commands,
    replies,
    binaryPath: "/fake/ade-sim-helper",
    typed(type: string) {
      return commands.filter((command) => command.type === type);
    },
    failNext(error: Error) {
      pendingError = error;
    },
    async send(command) {
      commands.push(command);
      if (pendingError) {
        const error = pendingError;
        pendingError = null;
        throw error;
      }
      const override = replies[command.type];
      if (override) return override(command);
      if (command.type === "record-stop") {
        return { path: String(command.path ?? ""), durationMs: 4200, bytes: 123_456 };
      }
      return {};
    },
    onEvent() {
      return () => {};
    },
  };
}

describe("simRecordingService", () => {
  let root: string;
  let transport: ReturnType<typeof createFakeTransport>;
  let filed: Array<Record<string, unknown>>;
  let service: SimRecordingService;

  const lane = "lane-a";
  const udid = "UDID-1";

  const build = (overrides: Parameters<typeof createSimRecordingService>[0] = {}): SimRecordingService =>
    createSimRecordingService({
      transport,
      projectRoot: root,
      artifactFiler: {
        ingest(request) {
          filed.push(request as Record<string, unknown>);
          return { artifacts: [], links: [] };
        },
      },
      ...overrides,
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-apple-rec-"));
    transport = createFakeTransport();
    filed = [];
    service = build();
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts an auto recording on the first injected input and decorates it", async () => {
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 10, y: 20 });

    const starts = transport.typed("record-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ udid, overlays: true, fps: 30 });
    expect(String(starts[0]!.path)).toContain(path.join(".ade", "artifacts", "apple-recordings", lane));
    expect(transport.typed("overlay-tap")).toEqual([{ type: "overlay-tap", udid, x: 10, y: 20 }]);

    const [record] = await service.list({ laneId: lane });
    expect(record).toMatchObject({ mode: "auto", chatSessionId: "chat-1", proof: false, endedAt: null });
  });

  it("does not start a second recording for later input, and badges typed text", async () => {
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 });
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "type", text: "hello" });

    expect(transport.typed("record-start")).toHaveLength(1);
    expect(transport.typed("overlay-text")).toEqual([
      { type: "overlay-text", udid, text: "hello", secure: false },
    ]);
  });

  it("omits the decorations each setting switches off", async () => {
    service.dispose();
    service = build({
      readOverlaySetting: (key) => (key === "apple.recordingOverlays.keyBadges" ? false : true),
    });
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "type", text: "hello", x: 3, y: 4 });

    expect(transport.typed("overlay-text")).toHaveLength(0);
    expect(transport.typed("overlay-tap")).toHaveLength(1);
  });

  it("treats a missing overlay setting as on, because 2E has not shipped the keys yet", async () => {
    service.dispose();
    service = build({ readOverlaySetting: () => undefined });
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 1 });
    expect(transport.typed("record-start")[0]).toMatchObject({ overlays: true });
  });

  it("stops the chat's auto recordings when its turn ends", async () => {
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 });
    await service.onTurnEnded("chat-1");

    expect(transport.typed("record-stop")).toHaveLength(1);
    const [record] = await service.list({ laneId: lane });
    expect(record).toMatchObject({ endedAt: expect.any(String), durationMs: 4200, bytes: 123_456 });
  });

  it("leaves another chat's recording alone at turn end", async () => {
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 });
    await service.onTurnEnded("chat-2");
    expect(transport.typed("record-stop")).toHaveLength(0);
  });

  it("never stops a manual recording at turn end", async () => {
    await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    await service.onTurnEnded("chat-1");
    expect(transport.typed("record-stop")).toHaveLength(0);
  });

  it("stops an auto recording after ten minutes", async () => {
    vi.useFakeTimers();
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 });

    await vi.advanceTimersByTimeAsync(AUTO_RECORDING_MAX_MS - 1);
    expect(transport.typed("record-stop")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2);
    expect(transport.typed("record-stop")).toHaveLength(1);
  });

  it("converts an auto recording to manual without restarting it, and restarts the cap from the conversion", async () => {
    vi.useFakeTimers();
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(AUTO_RECORDING_MAX_MS - 1000);
    const converted = await service.start({ laneId: lane, udid, chatSessionId: "chat-1", label: "sign-in" });

    expect(converted.mode).toBe("manual");
    expect(converted.label).toBe("sign-in");
    expect(converted.maxDurationMs).toBe(MANUAL_RECORDING_MAX_MS);
    // The whole point: one `record-start`, so the file has no gap in it.
    expect(transport.typed("record-start")).toHaveLength(1);

    // The auto cap would have fired here; the manual one counts from the
    // conversion.
    await vi.advanceTimersByTimeAsync(MANUAL_RECORDING_MAX_MS - 1);
    expect(transport.typed("record-stop")).toHaveLength(0);

    // And a turn ending no longer owns it either.
    await service.onTurnEnded("chat-1");
    expect(transport.typed("record-stop")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2);
    expect(transport.typed("record-stop")).toHaveLength(1);
  });

  it("tells listeners when a recording starts, turns manual, and stops", async () => {
    // The owner's 2026-09-23 report: an agent started a recording from the
    // CLI after the pane opened, and the pane's recording bar never showed.
    service.dispose();
    const changes: Array<{ laneId: string; phase: string; mode: string; endedAt: string | null }> = [];
    service = build({
      onRecordingChange: ({ laneId, phase, recording }) => {
        changes.push({ laneId, phase, mode: recording.mode, endedAt: recording.endedAt ?? null });
      },
    });
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 });
    await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    await service.stop({ laneId: lane, chatSessionId: "chat-1", keep: true });
    await Promise.resolve();

    expect(changes.map((change) => `${change.phase}:${change.mode}`)).toEqual([
      "started:auto",
      "updated:manual",
      "stopped:manual",
    ]);
    expect(changes.every((change) => change.laneId === lane)).toBe(true);
    // The stop is told with the finished row, not the one still recording.
    expect(changes[2]!.endedAt).not.toBeNull();
  });

  it("stops a chat's manual recording at the ten-minute cap, files it, and says why", async () => {
    vi.useFakeTimers();
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    expect(started.maxDurationMs).toBe(MANUAL_RECORDING_MAX_MS);

    await vi.advanceTimersByTimeAsync(MANUAL_RECORDING_MAX_MS - 1);
    expect(transport.typed("record-stop")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);

    expect(transport.typed("record-stop")).toHaveLength(1);
    const [record] = await service.list({ laneId: lane });
    expect(record).toMatchObject({ stopReason: "cap", proof: true, endedAt: expect.any(String) });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      inputs: [expect.objectContaining({ description: expect.stringContaining("Stopped at its 10:00 cap.") })],
    });
    expect(service.active({ laneId: lane })).toBeNull();
  });

  it("takes --max-seconds as the cap, and leaves a person's own recording uncapped", async () => {
    vi.useFakeTimers();
    await service.start({ laneId: lane, udid, chatSessionId: "chat-1", maxSeconds: 30 });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(transport.typed("record-stop")).toHaveLength(1);

    const mine = await service.start({ laneId: "lane-b", udid: "UDID-2", chatSessionId: null });
    expect(mine.maxDurationMs).toBeNull();
    await vi.advanceTimersByTimeAsync(MANUAL_RECORDING_MAX_MS * 3);
    expect(transport.typed("record-stop")).toHaveLength(1);
  });

  it("asks the helper to cut idle time by default, and not with keepIdle", async () => {
    await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    await service.start({ laneId: "lane-b", udid: "UDID-2", chatSessionId: "chat-1", keepIdle: true });
    expect(transport.typed("record-start").map((command) => command.idleCompression)).toEqual([true, false]);
  });

  it("records the video length, the real time and the idle cut from a newer helper", async () => {
    transport.replies["record-start"] = (command) => ({ path: command.path, idleCompression: command.idleCompression });
    transport.replies["record-stop"] = () => ({ path: "", durationMs: 70_000, wallDurationMs: 197_000, idleCutMs: 127_000, bytes: 9 });
    const named = build({ resolveDeviceName: () => "ADE Repro" });
    const started = await named.start({ laneId: lane, udid, chatSessionId: "chat-7" });
    expect(started.idleCompression).toBe(true);
    fs.writeFileSync(started.path, "mp4");

    const stopped = await named.stop({ laneId: lane, chatSessionId: "chat-7" });
    expect(stopped).toMatchObject({
      durationMs: 70_000,
      wallDurationMs: 197_000,
      idleCutMs: 127_000,
      stopReason: "requested",
    });
    expect(filed[0]).toMatchObject({
      // Wall-clock times, so the drawer's time range is real.
      provenance: { source: "ade-recorder", recordedFrom: started.startedAt, recordedTo: stopped!.endedAt },
      inputs: [expect.objectContaining({
        title: "Simulator recording · ADE Repro · 1:10 · idle cut 2:07",
        description: expect.stringContaining("2:07 cut from 3:17 of real time"),
        metadata: expect.objectContaining({ durationMs: 70_000, wallDurationMs: 197_000, idleCutMs: 127_000 }),
      })],
    });
    named.dispose();
  });

  it("works against an older helper that neither cuts idle time nor reports it", async () => {
    // The default fake is the older helper: `{}` for record-start, and only
    // durationMs and bytes for record-stop.
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    expect(started.idleCompression).toBe(false);
    const stopped = await service.stop({ laneId: lane, chatSessionId: "chat-1" });
    expect(stopped).toMatchObject({ durationMs: 4200, wallDurationMs: 4200, idleCutMs: 0 });
    expect(filed[0]).toMatchObject({
      inputs: [expect.objectContaining({ title: expect.not.stringContaining("idle cut") })],
    });
  });

  it("refuses to stop a recording owned by another chat", async () => {
    await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    await expect(service.stop({ laneId: lane, chatSessionId: "chat-2" })).rejects.toMatchObject({
      code: APPLE_OWNED_BY_OTHER_SESSION_CODE,
    });
    expect(transport.typed("record-stop")).toHaveLength(0);
  });

  it("discards the file when asked to", async () => {
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    fs.writeFileSync(started.path, "mp4");

    await expect(service.stop({ laneId: lane, chatSessionId: "chat-1", discard: true })).resolves.toBeNull();
    expect(fs.existsSync(started.path)).toBe(false);
    expect(await service.list({ laneId: lane })).toEqual([]);
  });

  it("lets a chat delete its own finished recording", async () => {
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    fs.writeFileSync(started.path, "mp4");
    await service.stop({ laneId: lane, chatSessionId: "chat-1" });

    // `allowProof` is the user's own delete row. Every stopped recording is
    // proof now (round 3, A3), so without it this is the refusal the next
    // test asserts.
    await service.remove({ laneId: lane, id: started.id, chatSessionId: "chat-1", allowProof: true });
    expect(await service.list({ laneId: lane })).toEqual([]);
    expect(fs.existsSync(started.path)).toBe(false);
  });

  it("refuses to delete another chat's recording", async () => {
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    await service.stop({ laneId: lane, chatSessionId: "chat-1" });

    await expect(
      service.remove({ laneId: lane, id: started.id, chatSessionId: "chat-2", allowProof: true }),
    ).rejects.toMatchObject({ code: APPLE_OWNED_BY_OTHER_SESSION_CODE });
    expect(await service.list({ laneId: lane })).toHaveLength(1);
  });

  it("refuses to delete a pinned recording, even with force", async () => {
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    fs.writeFileSync(started.path, "mp4");
    await service.pinActiveOrLatest({ laneId: lane, chatSessionId: "chat-1" });

    for (const force of [false, true]) {
      await expect(
        service.remove({ laneId: lane, id: started.id, chatSessionId: "chat-1", force }),
      ).rejects.toMatchObject({ code: APPLE_RECORDING_PINNED_CODE });
    }
    expect(fs.existsSync(started.path)).toBe(true);
  });

  it("pins the active recording, stopping it first, and files it as proof", async () => {
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1", label: "sign-in" });
    fs.writeFileSync(started.path, "mp4");

    const pinned = await service.pinActiveOrLatest({ laneId: lane, chatSessionId: "chat-1" });

    expect(pinned).toMatchObject({ id: started.id, proof: true, endedAt: expect.any(String) });
    expect(transport.typed("record-stop")).toHaveLength(1);
    // Stopping filed it; pinning must not file the same bytes twice.
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      inputs: [expect.objectContaining({ kind: "video_recording", path: started.path, mimeType: "video/mp4" })],
      owners: [{ kind: "chat_session", id: "chat-1" }, { kind: "lane", id: lane }],
      // ADE's recorder made these bytes, from start to stop.
      provenance: { source: "ade-recorder", recordedFrom: started.startedAt, recordedTo: pinned!.endedAt },
    });
    expect((await service.list({ laneId: lane }))[0]!.proof).toBe(true);
  });

  it("falls back to this chat's latest finished recording when nothing is active", async () => {
    const first = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    await service.stop({ laneId: lane, chatSessionId: "chat-1" });

    const pinned = await service.pinActiveOrLatest({ laneId: lane, chatSessionId: "chat-1" });
    expect(pinned?.id).toBe(first.id);
    expect(pinned?.proof).toBe(true);
  });

  it("returns null when the lane has never recorded", async () => {
    await expect(service.pinActiveOrLatest({ laneId: "empty", chatSessionId: "chat-1" })).resolves.toBeNull();
  });

  it("sums bytes on disk without deleting anything", async () => {
    const started = await service.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    fs.writeFileSync(started.path, "mp4");
    await service.stop({ laneId: lane, chatSessionId: "chat-1" });

    // The stop reply's byte count is authoritative once it exists.
    expect(await service.totalBytes()).toBe(123_456);
    expect(await service.totalBytes({ laneId: lane })).toBe(123_456);
    expect(await service.totalBytes({ laneId: "other" })).toBe(0);
    expect(fs.existsSync(started.path)).toBe(true);
  });

  it("keeps an input working when the helper refuses the recording", async () => {
    transport.failNext(new Error("helper is busy"));
    await expect(
      service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 }),
    ).resolves.toBeUndefined();
    expect(await service.list({ laneId: lane })).toEqual([]);
  });

  it("does nothing at all without a helper or a project root", async () => {
    const inert = createSimRecordingService();
    await expect(
      inert.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 }),
    ).resolves.toBeUndefined();
    await expect(inert.list({ laneId: lane })).resolves.toEqual([]);
    await expect(inert.totalBytes()).resolves.toBe(0);
    await expect(inert.start({ laneId: lane, udid, chatSessionId: null })).rejects.toThrow(/APPLE_HELPER_UNAVAILABLE/);
    inert.dispose();
  });

  it("never starts a recording for a person driving the pane", async () => {
    // Round 3, A2. One live test left three MP4s in .ade/artifacts with
    // nothing on screen about any of them, because every tap the user made
    // was treated as an agent verifying its work.
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2, source: "user" });
    expect(transport.typed("record-start")).toHaveLength(0);
    expect(await service.list({ laneId: lane })).toEqual([]);

    // An agent's input still does, and the person's input during it is still
    // drawn on the screen being recorded.
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 3, y: 4 });
    expect(transport.typed("record-start")).toHaveLength(1);
    transport.commands.length = 0;
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 5, y: 6, source: "user" });
    expect(transport.typed("record-start")).toHaveLength(0);
    expect(transport.typed("overlay-tap")).toHaveLength(1);
  });

  it("files every stopped recording as proof, captioned with the device", async () => {
    // Round 3, A3: there is no pin step any more. A recording that exists is
    // in the drawer, or the user never learns it exists.
    const named = build({ resolveDeviceName: () => "ADE Repro" });
    const started = await named.start({ laneId: lane, udid, chatSessionId: "chat-7" });
    fs.writeFileSync(started.path, "mp4");

    const stopped = await named.stop({ laneId: lane, chatSessionId: "chat-7" });
    expect(stopped).toMatchObject({ proof: true });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      owners: [{ kind: "chat_session", id: "chat-7" }, { kind: "lane", id: lane }],
      inputs: [expect.objectContaining({
        kind: "video_recording",
        title: "Simulator recording · ADE Repro · 0:04",
        path: started.path,
      })],
    });
    named.dispose();
  });

  it("owns an agent's recording by lane when no chat drove it", async () => {
    /*
     * The broker links an artifact to its owners and derives the lane from
     * them, so a chat-only claim left a CLI-started recording with an EMPTY
     * owner list: `ade proof list` returned it under no scope, project-wide
     * included, while the caller still got a real artifact id back. It looked
     * filed and was unreachable.
     */
    // `chatSessionId: null` is the point of the case, not an omission: it is
    // what a CLI or agent capture looks like, and what used to leave the
    // artifact with no owner at all.
    const started = await service.start({ laneId: lane, udid, chatSessionId: null });
    fs.writeFileSync(started.path, "mp4");

    await service.stop({ laneId: lane, chatSessionId: null });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.owners).toEqual([{ kind: "lane", id: lane }]);
  });

  it("keeps the video when the drawer refuses it", async () => {
    const refusing = build({
      artifactFiler: {
        ingest() { throw new Error("drawer is closed"); },
      },
    });
    const started = await refusing.start({ laneId: lane, udid, chatSessionId: null });
    fs.writeFileSync(started.path, "mp4");

    const stopped = await refusing.stop({ laneId: lane, chatSessionId: null });
    // Proof-marked with no artifact behind it: the bytes are what matters, and
    // a drawer that would not take them is not a reason to lose them.
    expect(stopped).toMatchObject({ proof: true, proofArtifactId: null });
    expect(fs.existsSync(started.path)).toBe(true);
    refusing.dispose();
  });

  it("takes the drawer row with the file when the user deletes it", async () => {
    const deleted: string[] = [];
    const wired = build({
      artifactFiler: {
        ingest(request) {
          filed.push(request as Record<string, unknown>);
          return { artifacts: [{ artifactId: "artifact-9" }], links: [] };
        },
        deleteArtifacts(args) {
          deleted.push(...args.artifactIds);
          return {};
        },
      },
    });
    const started = await wired.start({ laneId: lane, udid, chatSessionId: "chat-1" });
    fs.writeFileSync(started.path, "mp4");
    const stopped = await wired.stop({ laneId: lane, chatSessionId: "chat-1" });
    expect(stopped?.proofArtifactId).toBe("artifact-9");

    await wired.remove({ laneId: lane, id: started.id, chatSessionId: "chat-1", allowProof: true });
    expect(deleted).toEqual(["artifact-9"]);
    expect(fs.existsSync(started.path)).toBe(false);
    wired.dispose();
  });

  it("puts a lane's files exactly where the contract says", () => {
    expect(appleRecordingsDirectory("/p", "lane-x")).toBe(
      path.join("/p", ".ade", "artifacts", "apple-recordings", "lane-x"),
    );
  });
});

/**
 * A helper with the real one's state: one recording slot per device.
 *
 * The stateless fake above answers every `record-stop`, so it cannot show the
 * failure these tests pin — the helper still writing a movie that the service
 * no longer knows about. This one refuses a second `record-start` on a busy
 * device and a `record-stop` on an idle one, with the codes
 * `SimHelperRuntime.code(for:)` sends.
 */
function createStatefulHelper(): SimHelperTransport & {
  recording: Map<string, string>;
  loseNextStartReply(): void;
  typed(type: string): Array<Record<string, unknown>>;
} {
  const recording = new Map<string, string>();
  const commands: Array<Record<string, unknown>> = [];
  let loseStartReply = false;
  return {
    recording,
    binaryPath: "/fake/ade-sim-helper",
    loseNextStartReply() {
      loseStartReply = true;
    },
    typed(type: string) {
      return commands.filter((command) => command.type === type);
    },
    async send(command) {
      commands.push(command);
      const deviceUdid = String(command.udid ?? "");
      if (command.type === "record-start") {
        if (recording.has(deviceUdid)) {
          throw new SimHelperError("already-recording", "This device is already recording.");
        }
        recording.set(deviceUdid, String(command.path));
        fs.writeFileSync(String(command.path), "movie");
        if (loseStartReply) {
          // The helper began; the reply did not reach ADE in time.
          loseStartReply = false;
          throw new SimHelperError("timeout", "The simulator helper did not answer `record-start` within 30s.");
        }
        return { path: command.path };
      }
      if (command.type === "record-stop") {
        const moviePath = recording.get(deviceUdid);
        if (!moviePath) throw new SimHelperError("not-recording", "This device is not recording.");
        recording.delete(deviceUdid);
        return { path: moviePath, durationMs: 3000, bytes: 5 };
      }
      return {};
    },
    onEvent() {
      return () => {};
    },
  };
}

describe("simRecordingService against the helper's per-device state", () => {
  let root: string;
  let helper: ReturnType<typeof createStatefulHelper>;
  let filed: Array<Record<string, unknown>>;
  let service: SimRecordingService;
  const udid = "UDID-1";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-apple-rec-state-"));
    helper = createStatefulHelper();
    filed = [];
    service = createSimRecordingService({
      transport: helper,
      projectRoot: root,
      artifactFiler: {
        ingest(request) {
          filed.push(request as Record<string, unknown>);
          return { artifacts: [], links: [] };
        },
      },
    });
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("regression: a start whose reply was lost does not lock the device", async () => {
    // Live on 2026-09-22: `record-stop` returned null from every lane while
    // `record-start` said "This device is already recording.", and the state
    // survived a stream restart and a power cycle. Only killing the helper
    // cleared it.
    helper.loseNextStartReply();
    await expect(service.start({ laneId: "lane-a", udid, chatSessionId: null })).rejects.toThrow(/did not answer/);
    expect(helper.recording.has(udid)).toBe(true);
    expect(service.active({ laneId: "lane-a" })).toBeNull();

    const next = await service.start({ laneId: "lane-a", udid, chatSessionId: null });

    expect(service.active({ laneId: "lane-a" })?.id).toBe(next.id);
    expect(helper.recording.get(udid)).toBe(next.path);
    // The orphan's video is kept and filed, like any stopped recording.
    expect(filed).toHaveLength(1);
    const finished = (await service.list({ laneId: "lane-a" })).filter((record) => record.endedAt);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ udid, laneId: "lane-a", proof: true, durationMs: 3000 });
  });

  it("regression: record-stop reaches a recording the service lost", async () => {
    helper.loseNextStartReply();
    await service.start({ laneId: "lane-a", udid, chatSessionId: null }).catch(() => null);

    const stopped = await service.stop({ laneId: "lane-a", chatSessionId: null, udid });

    expect(stopped).toMatchObject({ udid, laneId: "lane-a", proof: true });
    expect(helper.recording.has(udid)).toBe(false);
  });

  it("stops without touching the helper when neither side is recording", async () => {
    await expect(service.stop({ laneId: "lane-a", chatSessionId: null, udid })).resolves.toBeNull();
    expect(filed).toEqual([]);
  });

  it("names the lane that holds the device instead of taking its recording", async () => {
    await service.start({ laneId: "lane-a", udid, chatSessionId: null });

    await expect(service.start({ laneId: "lane-b", udid, chatSessionId: null })).rejects.toMatchObject({
      code: APPLE_DEVICE_ALREADY_RECORDING_CODE,
      laneId: "lane-a",
    });
    // Nor may lane B's stop end it.
    await expect(service.stop({ laneId: "lane-b", chatSessionId: null, udid })).resolves.toBeNull();
    expect(service.active({ laneId: "lane-a" })).not.toBeNull();
    expect(helper.typed("record-stop")).toEqual([]);
  });

  it("ends a device's recording in whichever lane holds it", async () => {
    await service.start({ laneId: "lane-a", udid, chatSessionId: null });

    const stopped = await service.stopDevice({ udid, reason: "device-off" });

    expect(stopped).toMatchObject({ laneId: "lane-a", proof: true });
    expect(service.active({ laneId: "lane-a" })).toBeNull();
    expect(helper.recording.has(udid)).toBe(false);
  });

  it("ends a device's orphan recording too", async () => {
    helper.loseNextStartReply();
    await service.start({ laneId: "lane-a", udid, chatSessionId: null }).catch(() => null);

    await expect(service.stopDevice({ udid, reason: "released" })).resolves.toMatchObject({ laneId: "lane-a" });
    expect(helper.recording.has(udid)).toBe(false);
  });

  it("regression: a helper restart drops the recordings it held, and the next agent input starts a new one", async () => {
    // 2026-09-23, live: a restarted helper holds none of the old helper's
    // recordings. Kept in memory, the lane's entry looked active forever and
    // swallowed the next auto-record start.
    const started = await service.start({ laneId: "lane-a", udid, chatSessionId: "chat-1" });
    // The restart: the new helper process has no recording on the device.
    helper.recording.clear();

    const ended = service.helperExited();

    expect(ended.map((record) => record.id)).toEqual([started.id]);
    expect(service.active({ laneId: "lane-a" })).toBeNull();
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(appleRecordingsDirectory(root, "lane-a"), `${started.id}.json`), "utf8"),
    ) as { endedAt: string | null; proof: boolean };
    expect(sidecar.endedAt).not.toBeNull();
    // Not filed: the dead helper never finished the movie.
    expect(sidecar.proof).toBe(false);
    expect(filed).toEqual([]);

    await service.noteInput({ laneId: "lane-a", udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2, source: "agent" });
    expect(helper.typed("record-start")).toHaveLength(2);
    expect(service.active({ laneId: "lane-a" })?.id).not.toBe(started.id);
  });

  /** Rebuild `service` with a change listener, for the tests that read it. */
  const withChanges = (): Array<{ laneId: string; phase: string; recordingId: string; stopReason: unknown }> => {
    const changes: Array<{ laneId: string; phase: string; recordingId: string; stopReason: unknown }> = [];
    service.dispose();
    service = createSimRecordingService({
      transport: helper,
      projectRoot: root,
      artifactFiler: {
        ingest(request) {
          filed.push(request as Record<string, unknown>);
          return { artifacts: [], links: [] };
        },
      },
      onRecordingChange: ({ laneId, phase, recording }) => {
        changes.push({ laneId, phase, recordingId: recording.id, stopReason: recording.stopReason ?? null });
      },
    });
    return changes;
  };

  it("regression: a helper exit tells each lane its recording stopped", async () => {
    // The pane re-reads its list only on this event. Without it a recording
    // the dead helper held stayed "live" on screen.
    const changes = withChanges();
    const started = await service.start({ laneId: "lane-a", udid, chatSessionId: null });
    helper.recording.clear();

    const [ended] = service.helperExited();

    expect(ended).toMatchObject({ id: started.id, stopReason: "helper-exited" });
    expect(changes.at(-1)).toEqual({ laneId: "lane-a", phase: "stopped", recordingId: started.id, stopReason: "helper-exited" });
  });

  it("proof-bundle does not file a recording the helper died writing", async () => {
    await service.start({ laneId: "lane-a", udid, chatSessionId: "chat-1" });
    helper.recording.clear();
    service.helperExited();

    await expect(service.pinActiveOrLatest({ laneId: "lane-a", chatSessionId: "chat-1" })).resolves.toBeNull();
    expect(filed).toEqual([]);
  });

  it("regression: a reclaimed orphan recording tells its lane it stopped", async () => {
    const changes = withChanges();
    helper.loseNextStartReply();
    await service.start({ laneId: "lane-a", udid, chatSessionId: null }).catch(() => null);

    const reclaimed = await service.stopDevice({ udid, reason: "device-off" });

    expect(reclaimed).not.toBeNull();
    expect(changes).toContainEqual({ laneId: "lane-a", phase: "stopped", recordingId: reclaimed!.id, stopReason: null });
  });

  it("marks a recording ended when the service is disposed under it", async () => {
    const started = await service.start({ laneId: "lane-a", udid, chatSessionId: null });

    service.dispose();

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(appleRecordingsDirectory(root, "lane-a"), `${started.id}.json`), "utf8"),
    ) as { endedAt: string | null };
    expect(sidecar.endedAt).not.toBeNull();
  });
});
