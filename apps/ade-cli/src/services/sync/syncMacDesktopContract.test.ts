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
  const getDisplay = vi.fn(async () => status.display);
  const takeControl = vi.fn(async (args: { laneId: string; controllerId: string }) => ({
    ...status.lease!,
    holder: "user" as const,
    holderId: args.controllerId,
    holderLabel: "ADE Web",
  }));
  const returnControl = vi.fn(async () => null);
  const renewLease = vi.fn(async (args: { holderId: string }) => ({
    ...status.lease!,
    holder: "user" as const,
    holderId: args.holderId,
    holderLabel: "ADE Web",
  }));
  const click = vi.fn(async (_args: Record<string, unknown>) => ({
    ok: true as const,
    action: "click",
    mode: "real" as const,
    silent: true as const,
    resolved: null,
    observation: null,
    trace: null,
  }));
  const move = vi.fn(async (_args: Record<string, unknown>) => ({
    ok: true as const,
    action: "move",
    mode: "real" as const,
    silent: true as const,
    resolved: null,
    observation: null,
    trace: null,
  }));
  const releaseInput = vi.fn(async (_args: Record<string, unknown>) => ({
    ok: true as const,
    action: "releaseInput",
    mode: "real" as const,
    silent: true as const,
    resolved: null,
    observation: null,
    trace: null,
  }));
  const service = createSyncRemoteCommandService({
    laneService: {},
    prService: {},
    ptyService: {},
    sessionService: {},
    fileService: {},
    macDesktopService: {
      getStatus,
      start,
      stop,
      getDisplay,
      takeControl,
      returnControl,
      renewLease,
      click,
      move,
      releaseInput,
    },
    macDesktopSyncStream: { subscribe, unsubscribe },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never);
  return {
    service,
    getStatus,
    start,
    stop,
    subscribe,
    unsubscribe,
    getDisplay,
    takeControl,
    returnControl,
    renewLease,
    click,
    move,
    releaseInput,
  };
}

const CONTROL_CONTEXT = { connectionId: "conn-1" };

describe("macDesktop sync wire contract", () => {
  it("advertises the read-only methods to viewer clients", () => {
    const { service } = createService();
    for (const action of [
      "macDesktop.getStatus",
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
    // The unsubscribe is scoped to the connection that sent it; this payload
    // carries none, so the service gets null and ends nothing it does not own.
    expect(unsubscribe).toHaveBeenCalledWith(fixture.subscriptionId, null);

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

describe("macDesktop web takeover contract", () => {
  it("registers display lifecycle and takeover as controller-only, never viewer-allowed", () => {
    const { service } = createService();
    // `start`/`stop` create and destroy a display on the host, and the four
    // takeover calls post real input there: a read-only viewer device watches
    // (`getStatus`, `stream*`), a paired/account browser controller drives.
    for (const action of [
      "macDesktop.start",
      "macDesktop.stop",
      "macDesktop.takeControl",
      "macDesktop.returnControl",
      "macDesktop.renewLease",
      "macDesktop.input",
    ]) {
      expect(service.getDescriptor(action)).toEqual({
        action,
        scope: "project",
        policy: { viewerAllowed: false, controllerAllowed: true, queueable: false },
      });
    }
  });

  it("derives the lease controller id from the socket and the caller's token", async () => {
    const { service, takeControl } = createService();

    const lease = await service.execute(makePayload("macDesktop.takeControl", {
      laneId: fixture.laneId,
      controllerId: "tab-token-1",
      controllerLabel: "Arul's browser",
    }), CONTROL_CONTEXT) as { holderId: string };

    // The wire's "controllerId" is a token; the holder id is the derived one.
    expect(takeControl).toHaveBeenCalledWith({
      laneId: fixture.laneId,
      controllerId: "web:conn-1:tab-token-1",
      controllerLabel: "Arul's browser",
    });
    expect(lease.holderId).toBe("web:conn-1:tab-token-1");
  });

  it("refuses takeover without a live sync connection", async () => {
    const { service, takeControl } = createService();
    await expect(service.execute(makePayload("macDesktop.takeControl", {
      laneId: fixture.laneId,
      controllerId: "tab-token-1",
    }))).rejects.toThrow(/live sync connection/);
    expect(takeControl).not.toHaveBeenCalled();
  });

  it("lets a second connection return only its own derived lease", async () => {
    const { service, returnControl, renewLease } = createService();

    await service.execute(makePayload("macDesktop.returnControl", {
      laneId: fixture.laneId,
      controllerId: "tab-token-1",
    }), { connectionId: "conn-2" });
    // The second socket's derivation cannot name the first's holder id, so the
    // service will not match and release nothing.
    expect(returnControl).toHaveBeenCalledWith({
      laneId: fixture.laneId,
      controllerId: "web:conn-2:tab-token-1",
    });

    await service.execute(makePayload("macDesktop.renewLease", {
      laneId: fixture.laneId,
      controllerId: "tab-token-1",
    }), { connectionId: "conn-2" });
    expect(renewLease).toHaveBeenCalledWith({
      laneId: fixture.laneId,
      holderId: "web:conn-2:tab-token-1",
    });
  });

  it("returns the lease on connection close, and only for the connection that took it", async () => {
    const { service, returnControl } = createService();

    await service.execute(makePayload("macDesktop.takeControl", {
      laneId: fixture.laneId,
      controllerId: "tab-token-1",
    }), CONTROL_CONTEXT);

    service.releaseMacDesktopConnection("conn-2");
    expect(returnControl).not.toHaveBeenCalled();

    service.releaseMacDesktopConnection("conn-1");
    expect(returnControl).toHaveBeenCalledWith({
      laneId: fixture.laneId,
      controllerId: "web:conn-1:tab-token-1",
    });
    // The bookkeeping is per connection and dropped with it.
    returnControl.mockClear();
    service.releaseMacDesktopConnection("conn-1");
    expect(returnControl).not.toHaveBeenCalled();
  });

  it("strips forged identities, forces silent, and re-derives the controller id", async () => {
    const { service, click } = createService();

    await service.execute(makePayload("macDesktop.input", {
      laneId: fixture.laneId,
      call: {
        kind: "click",
        args: {
          laneId: fixture.laneId,
          x: 1200,
          y: 800,
          mode: "real",
          button: "left",
          count: 1,
          silent: false,
          // The wire's `controllerId` is the caller's token; a claimed full
          // holder id, a holder id and a chat session are all discarded.
          controllerId: "tab-token-1",
          holderId: "web:conn-9:someone-else",
          chatSessionId: "someone-elses-chat",
        },
      },
    }), CONTROL_CONTEXT);

    expect(click).toHaveBeenCalledWith({
      laneId: fixture.laneId,
      x: 1200,
      y: 800,
      mode: "real",
      button: "left",
      count: 1,
      silent: true,
      controllerId: "web:conn-1:tab-token-1",
    });
    const forwarded = click.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("holderId");
    expect(forwarded).not.toHaveProperty("chatSessionId");
  });

  it("cannot wear another connection's holder id", async () => {
    const { service, move } = createService();

    await service.execute(makePayload("macDesktop.input", {
      laneId: fixture.laneId,
      call: {
        kind: "move",
        args: { laneId: fixture.laneId, x: 1, y: 1, controllerId: "web:conn-9:stolen" },
      },
    }), CONTROL_CONTEXT);

    const forwarded = move.mock.calls[0]![0] as unknown as Record<string, unknown>;
    // The claimed holder id is not passed through: it becomes this socket's
    // token, which can never equal the lease `web:conn-9:stolen` names.
    expect(forwarded.controllerId).toBe("web:conn-1:web:conn-9:stolen");
    expect(forwarded.controllerId).not.toBe("web:conn-9:stolen");
  });

  it("routes every forwarded kind to its own service call", async () => {
    const { service, move } = createService();
    await service.execute(makePayload("macDesktop.input", {
      laneId: fixture.laneId,
      call: { kind: "move", args: { laneId: fixture.laneId, x: 42, y: 43, silent: true, controllerId: "tab-token-1" } },
    }), CONTROL_CONTEXT);
    expect(move).toHaveBeenCalledWith({
      laneId: fixture.laneId,
      x: 42,
      y: 43,
      silent: true,
      controllerId: "web:conn-1:tab-token-1",
    });

    await expect(service.execute(makePayload("macDesktop.input", {
      laneId: fixture.laneId,
      call: { kind: "teleport", args: {} },
    }), CONTROL_CONTEXT)).rejects.toThrow(/does not support 'teleport'/);
  });

  /**
   * The remote release must not steer the host's cursor.
   *
   * `homeX`/`homeY` mean "where the person watching is pointing", which the
   * desktop pane can answer about the host's own screen. A web controller is
   * pointing at a screen in another building, so honouring its number would
   * fling the host's cursor to an arbitrary place — and it is the one
   * coordinate the display check cannot catch, because pointing off the lane's
   * display is the purpose of it.
   */
  it("keeps a remote release, but never lets it name where the host's cursor goes", async () => {
    const { service, releaseInput } = createService();

    await service.execute(makePayload("macDesktop.input", {
      laneId: fixture.laneId,
      call: {
        kind: "releaseInput",
        args: {
          laneId: fixture.laneId,
          button: "left",
          homeX: 99_999,
          homeY: -4_000,
          controllerId: "tab-token-1",
        },
      },
    }), CONTROL_CONTEXT);

    expect(releaseInput).toHaveBeenCalledTimes(1);
    const args = releaseInput.mock.calls[0]![0]!;
    // The button still gets lifted: that is the point of the call.
    expect(args.button).toBe("left");
    expect(args).not.toHaveProperty("homeX");
    expect(args).not.toHaveProperty("homeY");
    // And the identity is still the host's own, not the caller's assertion.
    expect(args.silent).toBe(true);
  });

  it("bounds text at 4 KiB and refuses points off the display", async () => {
    const { service, getDisplay } = createService();

    await expect(service.execute(makePayload("macDesktop.input", {
      laneId: fixture.laneId,
      call: {
        kind: "type",
        args: { laneId: fixture.laneId, text: "x".repeat(4 * 1024 + 1), controllerId: "tab-token-1" },
      },
    }), CONTROL_CONTEXT)).rejects.toThrow(/4 KiB/);

    // The fixture display is 2560x1440 at the origin: (0, -50) is off it.
    getDisplay.mockResolvedValueOnce({
      ...fixture.status.display!,
      origin: { x: 0, y: 0 },
    });
    await expect(service.execute(makePayload("macDesktop.input", {
      laneId: fixture.laneId,
      call: {
        kind: "click",
        args: { laneId: fixture.laneId, x: 1280, y: -50, mode: "real", controllerId: "tab-token-1" },
      },
    }), CONTROL_CONTEXT)).rejects.toThrow(/outside the lane's display/);
  });
});
