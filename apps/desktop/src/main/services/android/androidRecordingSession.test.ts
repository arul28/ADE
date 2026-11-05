import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAndroidRecordingSessions } from "./androidRecordingSession";

/*
 * A recording holds the lane's stream. When the lane lets its device go while
 * a start is still on its way, the release must wait for that start and then
 * end it: otherwise the late start holds the stream of a device that is gone.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createAndroidRecordingSessions", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-rec-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a second start, and a release ends the start still on its way", async () => {
    const hold = deferred<string>();
    const untap = vi.fn();
    const releaseStream = vi.fn(async () => undefined);
    const sessions = createAndroidRecordingSessions({
      requireBooted: async () => ({}),
      assertWorkCopyLive: () => undefined,
      streams: { subscribePackets: vi.fn(() => untap) },
      holdStreamForRecording: () => hold.promise,
      releaseStreamForRecording: releaseStream,
      artifactFiler: null,
      callerRoot: null,
      dataDir,
      logger: null,
      now: () => new Date("2026-11-05T08:00:00Z"),
    });

    const first = sessions.api.recordStart({ laneId: "lane-1" });
    await expect(sessions.api.recordStart({ laneId: "lane-1" })).rejects.toMatchObject({ code: "ANDROID_RECORDING_ACTIVE" });

    // The lane lets the device go while the first start waits for the stream.
    const released = sessions.finishQuietly("lane-1", "released", "android.recording_release_stop_failed", { waitForStart: true });
    hold.resolve("emulator-5556");

    await expect(first).resolves.toMatchObject({ laneId: "lane-1", active: true });
    await released;
    expect(sessions.isRecording("lane-1")).toBe(false);
    expect(untap).toHaveBeenCalledTimes(1);
    expect(releaseStream).toHaveBeenCalledTimes(1);
    await expect(sessions.api.recordStop({ laneId: "lane-1" })).resolves.toMatchObject({ active: false, stopReason: "released" });
  });
});
