import { describe, expect, it } from "vitest";
import type { Logger } from "../logging/logger";
import type { MacDesktopDriverClient } from "../macDesktop/macDesktopDriverClient";
import { createAppControlWindowRecorder } from "./appControlWindowRecorder";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

/** A helper client that never spawns: it answers at once, or holds a stop open. */
function createFakeClients() {
  const clients: Array<{ disposed: boolean; emit: (event: { event: string } & Record<string, unknown>) => void }> = [];
  let releaseStop: (() => void) | null = null;
  const create = (): MacDesktopDriverClient => {
    const listeners = new Set<(event: { event: string } & Record<string, unknown>) => void>();
    const entry = { disposed: false, emit: (event: { event: string } & Record<string, unknown>) => listeners.forEach((listener) => listener(event)) };
    clients.push(entry);
    return {
      readPermissions: async () => ({ screenRecording: "granted", accessibility: "granted" }),
      listWindowsForPid: async () => [],
      startWindowRecording: async () => {},
      stopRecordingByKey: async () => {
        await new Promise<void>((resolve) => {
          releaseStop = resolve;
        });
        return { filePath: "/tmp/recording.mp4" };
      },
      onEvent: (listener: (event: { event: string } & Record<string, unknown>) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: () => {
        entry.disposed = true;
      },
    } as unknown as MacDesktopDriverClient;
  };
  return { clients, create, finishStop: () => releaseStop?.() };
}

describe("App Control window recorder idle release", () => {
  it("keeps the helper while a recording runs or a call waits, and starts a new one after a release", async () => {
    const fake = createFakeClients();
    const recorder = createAppControlWindowRecorder({ logger, platform: "darwin", createClient: fake.create })!;
    expect(recorder.releaseIdle?.()).toBe(false);

    await recorder.start({ key: "lane-1", windowId: 3, fps: 30, filePath: "/tmp/recording.mp4", keepIdle: false });
    expect(recorder.releaseIdle?.()).toBe(false);

    // A stop in flight still needs the helper that runs the recording.
    const stopping = recorder.stop("lane-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.releaseIdle?.()).toBe(false);
    fake.finishStop();
    await stopping;

    expect(recorder.releaseIdle?.()).toBe(true);
    expect(fake.clients[0]?.disposed).toBe(true);

    // The next call starts a new helper, and its interruptions still reach App Control.
    const interrupted: string[] = [];
    recorder.onInterrupted((key) => interrupted.push(key));
    await recorder.start({ key: "lane-2", windowId: 4, fps: 30, filePath: "/tmp/other.mp4", keepIdle: false });
    expect(fake.clients).toHaveLength(2);
    expect(recorder.releaseIdle?.()).toBe(false);
    fake.clients[1]?.emit({ event: "recording-interrupted", laneId: "lane-2" });
    expect(interrupted).toEqual(["lane-2"]);
    expect(recorder.releaseIdle?.()).toBe(true);
  });
});
