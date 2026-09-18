import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { SyncCommandPayload } from "../../../../desktop/src/shared/types";
import type { MacDesktopStatus } from "../../../../desktop/src/shared/types/macDesktop";
import type {
  SyncMacDesktopStreamEndedPayload,
  SyncMacDesktopStreamRecordPayload,
} from "../../../../desktop/src/shared/types/sync";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";

/**
 * The Mac Desktop live-view wire contract, bound to the same fixture the phone
 * mirrors (`apps/desktop/src/shared/__fixtures__/macDesktopStreamContract.json`,
 * decoded by `apps/ios/ADETests/MacDesktopStreamContractTests.swift`).
 *
 * The seam is three strings and one payload shape, and each one fails silently
 * when it drifts: a renamed method becomes "unsupported action", a renamed
 * field becomes a dropped frame, and an unredacted status reply becomes a
 * token or a host path on the wire. This test pins all three against the
 * fixture so a host change that would break the phone fails here first.
 */

const fixture = JSON.parse(readFileSync(
  join(__dirname, "../../../../desktop/src/shared/__fixtures__/macDesktopStreamContract.json"),
  "utf8",
)) as {
  projectId: string;
  laneId: string;
  subscriptionId: string;
  viewerLabel: string;
  subscribeResult: { ok: true; width: number; height: number; codec: string };
  config: { codec: string; width: number; height: number; annexB: boolean };
  streamRecord: SyncMacDesktopStreamRecordPayload;
  frameRecord: SyncMacDesktopStreamRecordPayload;
  streamEnded: SyncMacDesktopStreamEndedPayload;
  status: MacDesktopStatus;
};

function makePayload(action: string, args: Record<string, unknown> = {}): SyncCommandPayload {
  return { commandId: `cmd-${action}`, action, args };
}

function createService() {
  const status = fixture.status;
  const getStatus = vi.fn(async () => status);
  const start = vi.fn(async () => status);
  const stop = vi.fn(async () => ({ stopped: true, releasedWindows: 1 }));
  const subscribe = vi.fn(async () => fixture.subscribeResult);
  const unsubscribe = vi.fn(() => ({ ok: true }));
  const service = createSyncRemoteCommandService({
    laneService: {},
    prService: {},
    ptyService: {},
    sessionService: {},
    fileService: {},
    macDesktopService: { getStatus, start, stop },
    macDesktopSyncStream: { subscribe, unsubscribe },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never);
  return { service, getStatus, start, stop, subscribe, unsubscribe };
}

describe("macDesktop sync wire contract", () => {
  it("advertises all five methods to viewer clients", () => {
    const { service } = createService();
    for (const action of [
      "macDesktop.getStatus",
      "macDesktop.start",
      "macDesktop.stop",
      "macDesktop.streamSubscribe",
      "macDesktop.streamUnsubscribe",
    ]) {
      expect(service.getDescriptor(action)).toEqual({
        action,
        scope: "project",
        policy: { viewerAllowed: true },
      });
    }
  });

  it("answers getStatus with the fixture shape, redacted to null recording", async () => {
    const { service, getStatus } = createService();

    const result = await service.execute(makePayload("macDesktop.getStatus", { laneId: fixture.laneId })) as MacDesktopStatus;

    expect(getStatus).toHaveBeenCalledWith({ laneId: fixture.laneId });
    expect(result.supported).toBe(true);
    expect(result.display?.width).toBe(fixture.status.display?.width);
    expect(result.lease?.holderLabel).toBe(fixture.status.lease?.holderLabel);
    // The one host path in `MacDesktopStatus` never crosses the socket.
    expect(result.recording).toBeNull();
    expect(JSON.stringify(result)).not.toContain(fixture.status.recording?.filePath ?? "/definitely-absent");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("forwards start and stop with the lane and name the web client sends", async () => {
    const { service, start, stop } = createService();

    await service.execute(makePayload("macDesktop.start", {
      laneId: fixture.laneId,
      laneName: "fix-header",
    }));
    expect(start).toHaveBeenCalledWith({ laneId: fixture.laneId, laneName: "fix-header" });

    await expect(service.execute(makePayload("macDesktop.stop", {
      laneId: fixture.laneId,
    }))).resolves.toEqual({ stopped: true, releasedWindows: 1 });
    expect(stop).toHaveBeenCalledWith({ laneId: fixture.laneId });
  });

  it("carries the subscription sink into the stream fan-out and returns the fixture reply", async () => {
    const { service, subscribe } = createService();
    const sink = {
      connectionId: "conn-1",
      sendRecord: vi.fn(),
      sendEnded: vi.fn(),
      pendingBytes: () => 0,
    };

    const result = await service.execute(makePayload("macDesktop.streamSubscribe", {
      laneId: fixture.laneId,
      subscriptionId: fixture.subscriptionId,
      viewerLabel: fixture.viewerLabel,
    }), { macDesktopStream: sink });

    expect(result).toEqual(fixture.subscribeResult);
    expect(subscribe).toHaveBeenCalledWith({
      laneId: fixture.laneId,
      subscriptionId: fixture.subscriptionId,
      connectionId: "conn-1",
      viewerLabel: fixture.viewerLabel,
      sink,
    });
  });

  it("refuses streamSubscribe without a live sync connection", async () => {
    const { service, subscribe } = createService();

    await expect(service.execute(makePayload("macDesktop.streamSubscribe", {
      laneId: fixture.laneId,
      subscriptionId: fixture.subscriptionId,
    }))).rejects.toThrow(/live sync connection/);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("forwards an unsubscribe and rejects a missing subscriptionId", async () => {
    const { service, unsubscribe } = createService();

    await expect(service.execute(makePayload("macDesktop.streamUnsubscribe", {
      subscriptionId: fixture.subscriptionId,
    }))).resolves.toEqual({ ok: true });
    expect(unsubscribe).toHaveBeenCalledWith(fixture.subscriptionId);

    await expect(service.execute(makePayload("macDesktop.streamUnsubscribe", {})))
      .rejects.toThrow(/requires subscriptionId/);
  });

  it("keeps the pushed record fields exactly the ones the fixture and the phone decode", () => {
    // The host's producer lives in `macDesktopSyncStream.ts`; this is the
    // fixture's own contract assertion so a renamed/removed field here fails
    // against the values the Swift test decodes from the same file.
    expect(Object.keys(fixture.streamRecord).sort()).toEqual([
      "data",
      "keyframe",
      "kind",
      "seq",
      "subscriptionId",
      "timestampUs",
    ]);
    expect(Object.keys(fixture.streamEnded).sort()).toEqual(["reason", "subscriptionId"]);
    expect(JSON.parse(Buffer.from(fixture.streamRecord.data, "base64").toString("utf8")))
      .toEqual(fixture.config);
    expect(Buffer.from(fixture.frameRecord.data, "base64")
      .subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    expect(fixture.frameRecord.kind).toBe("frame");
    expect(fixture.frameRecord.keyframe).toBe(true);
  });
});
