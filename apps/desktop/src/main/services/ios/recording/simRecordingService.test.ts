import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLE_OWNED_BY_OTHER_SESSION_CODE,
  APPLE_RECORDING_PINNED_CODE,
  AUTO_RECORDING_MAX_MS,
  appleRecordingsDirectory,
  createSimRecordingService,
  type SimRecordingService,
} from "./simRecordingService";
import type { SimHelperTransport } from "../simHelperClient";

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
} {
  const commands: Array<Record<string, unknown>> = [];
  let pendingError: Error | null = null;
  return {
    commands,
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

  it("converts an auto recording to manual without restarting it, and clears the cap", async () => {
    vi.useFakeTimers();
    await service.noteInput({ laneId: lane, udid, chatSessionId: "chat-1", kind: "tap", x: 1, y: 2 });
    const converted = await service.start({ laneId: lane, udid, chatSessionId: "chat-1", label: "sign-in" });

    expect(converted.mode).toBe("manual");
    expect(converted.label).toBe("sign-in");
    // The whole point: one `record-start`, so the file has no gap in it.
    expect(transport.typed("record-start")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(AUTO_RECORDING_MAX_MS * 2);
    expect(transport.typed("record-stop")).toHaveLength(0);

    // And a turn ending no longer owns it either.
    await service.onTurnEnded("chat-1");
    expect(transport.typed("record-stop")).toHaveLength(0);
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
    const started = await service.start({ laneId: lane, udid });
    fs.writeFileSync(started.path, "mp4");

    await service.stop({ laneId: lane });
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
