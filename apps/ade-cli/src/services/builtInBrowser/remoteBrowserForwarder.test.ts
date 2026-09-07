import { describe, expect, it, vi } from "vitest";

import { DesktopBridgeUnavailableError } from "./desktopBridgeClient";
import type { BuiltInBrowserDesktopBridgeClient } from "./desktopBridgeMethods";
import {
  createRemoteBrowserForwarder,
  withRemoteBrowserForwarding,
} from "./remoteBrowserForwarder";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof createRemoteBrowserForwarder>[0]["logger"];

async function unavailable(): Promise<never> {
  throw new DesktopBridgeUnavailableError("/sock/desktop-bridge.sock", "no desktop here");
}

function makeBridge(overrides: Record<string, unknown> = {}): BuiltInBrowserDesktopBridgeClient {
  return {
    navigate: vi.fn(unavailable),
    createTab: vi.fn(unavailable),
    showPanel: vi.fn(unavailable),
    observe: vi.fn(unavailable),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as BuiltInBrowserDesktopBridgeClient;
}

describe("remote browser forwarder", () => {
  it("forwards a headless `browser open` as a runtime event and reports the ack", async () => {
    const events: Record<string, unknown>[] = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        events.push(payload);
        // A desktop holding a remote pin on this machine takes the request.
        const request = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.acknowledgeRemoteRequest({
            requestId: request.requestId,
            desktopLabel: "This computer",
            accepted: true,
          });
        });
      },
      logger,
      ackTimeoutMs: 500,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    const result = await bridge.navigate({
      url: "http://localhost:3000/",
      laneId: "lane-1",
      chatSessionId: "chat-1",
    } as never) as Record<string, unknown>;

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("built_in_browser_remote_request");
    expect(events[0].event).toMatchObject({
      url: "http://localhost:3000/",
      laneId: "lane-1",
      chatSessionId: "chat-1",
      openPanel: true,
    });
    expect(result).toMatchObject({
      status: "forwarded_to_desktop",
      url: "http://localhost:3000/",
      acknowledged: true,
      desktopLabel: "This computer",
    });
    expect(typeof result.requestId).toBe("string");
  });

  it("stops waiting when no desktop answers, instead of failing the command", async () => {
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: () => {},
      logger,
      ackTimeoutMs: 10,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    const result = await bridge.createTab({ url: "http://127.0.0.1:5173/" } as never);

    expect(result).toMatchObject({
      status: "forwarded_to_desktop",
      acknowledged: false,
      desktopLabel: null,
    });
  });

  it("carries a desktop's refusal back so the CLI can say why", async () => {
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        const request = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.acknowledgeRemoteRequest({
            requestId: request.requestId,
            desktopLabel: "This computer",
            accepted: false,
            reason: "Reaching port 8080 on Mac Studio was not allowed.",
          });
        });
      },
      logger,
      ackTimeoutMs: 500,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    const result = await bridge.showPanel({ url: "http://localhost:8080/" } as never);

    expect(result).toMatchObject({
      acknowledged: false,
      reason: "Reaching port 8080 on Mac Studio was not allowed.",
    });
  });

  it("leaves tab-scoped actions failing, and passes a working bridge straight through", async () => {
    const forwarder = createRemoteBrowserForwarder({ emitEvent: () => {}, logger });
    const navigate = vi.fn(async () => ({ attached: true }));
    const bridge = withRemoteBrowserForwarding(makeBridge({ navigate }), forwarder);

    // `observe` acts on a specific live tab; no other desktop can stand in.
    await expect(bridge.observe({} as never)).rejects.toThrow(DesktopBridgeUnavailableError);
    // With a desktop attached here, nothing is forwarded.
    await expect(bridge.navigate({ url: "http://localhost:3000/" } as never))
      .resolves.toEqual({ attached: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("ignores an acknowledgement for a request nobody is waiting on", () => {
    const forwarder = createRemoteBrowserForwarder({ emitEvent: () => {}, logger });
    expect(forwarder.acknowledgeRemoteRequest({ requestId: "bbr-gone" })).toEqual({ ok: false });
    expect(forwarder.acknowledgeRemoteRequest({})).toEqual({ ok: false });
  });
});
