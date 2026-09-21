import { describe, expect, it, vi } from "vitest";

import { createAppleDeviceNamespace, resolveAppleStreamUrl } from "../appleDevice";

function makeCall(results: Record<string, unknown> = {}) {
  const calls: Array<{ action: string; args: unknown }> = [];
  const call = (async (action: string, args: unknown, fallback: unknown) => {
    calls.push({ action, args });
    if (action in results) return results[action];
    if (typeof fallback === "function") return (fallback as () => unknown)();
    return fallback;
  }) as never;
  return { call, calls };
}

function namespaceFor(results: Record<string, unknown> = {}, endpoint: string | null = "ws://10.0.0.4:8787/") {
  const { call, calls } = makeCall(results);
  return {
    ns: createAppleDeviceNamespace(call as never, () => endpoint) as Record<string, (...args: never[]) => Promise<unknown>>,
    calls,
  };
}

const TICKET = {
  url: null,
  path: "/apple/stream/abc123def",
  token: "tok-xyz",
  codec: "avc1.42E01E",
  width: 393,
  height: 852,
  expiresAt: "2026-01-01T00:00:00.000Z",
};

describe("resolveAppleStreamUrl", () => {
  it("resolves the ticket path against a direct endpoint", () => {
    expect(resolveAppleStreamUrl("ws://10.0.0.4:8787/", "/apple/stream/abc?token=t")).toEqual({
      url: "ws://10.0.0.4:8787/apple/stream/abc?token=t",
      forwarded: false,
      error: null,
    });
  });

  it("names the local path as a pipe kind on a relay endpoint", () => {
    const resolved = resolveAppleStreamUrl(
      "wss://relay.ade.dev/connect/machine-key",
      "/apple/stream/abc",
    );
    expect(resolved.forwarded).toBe(true);
    const url = new URL(resolved.url!);
    expect(url.pathname).toBe("/connect/machine-key");
    expect(url.searchParams.get("kind")).toBe("apple-stream");
    expect(url.searchParams.get("path")).toBe("/apple/stream/abc");
  });

  it("says what is missing rather than returning a broken url", () => {
    expect(resolveAppleStreamUrl(null, "/apple/stream/abc").error).toMatch(/connection/);
    expect(resolveAppleStreamUrl("ws://host/", "").error).toMatch(/no address/);
  });
});

describe("createAppleDeviceNamespace", () => {
  it("mints a ticket for startStream and hands back a transport the reader understands", async () => {
    const { ns, calls } = namespaceFor({ "apple.streamTicket": TICKET });
    const status = await ns.startStream!({ laneId: "lane-a", chatSessionId: "chat-1" } as never) as {
      transport: { url: string; token: string; width: number };
    };
    expect(calls[0]).toEqual({
      action: "apple.streamTicket",
      args: { laneId: "lane-a", chatSessionId: "chat-1" },
    });
    expect(status.transport.token).toBe("tok-xyz");
    expect(status.transport.width).toBe(393);
  });

  it("resolves the minted ticket to an absolute socket url carrying the token", async () => {
    const { ns } = namespaceFor({ "apple.streamTicket": TICKET });
    await ns.startStream!({ laneId: "lane-a" } as never);
    const resolved = await ns.resolveStreamUrl!(null as never) as { url: string };
    const url = new URL(resolved.url);
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/apple/stream/abc123def");
    expect(url.searchParams.get("token")).toBe("tok-xyz");
  });

  it("carries the token inside the pipe path when the route is the relay", async () => {
    const { ns } = namespaceFor(
      { "apple.streamTicket": TICKET },
      "wss://relay.ade.dev/connect/machine-key",
    );
    await ns.startStream!({ laneId: "lane-a" } as never);
    const resolved = await ns.resolveStreamUrl!(null as never) as { url: string };
    expect(new URL(resolved.url).searchParams.get("path"))
      .toBe("/apple/stream/abc123def?token=tok-xyz");
  });

  it("sends input as apple.input in device points", async () => {
    const { ns, calls } = namespaceFor({ "apple.input": { ok: true } });
    await ns.tap!({ laneId: "lane-a", chatSessionId: "chat-1", x: 12.5, y: 40 } as never);
    expect(calls[0]!.args).toEqual({
      kind: "tap",
      laneId: "lane-a",
      chatSessionId: "chat-1",
      x: 12.5,
      y: 40,
    });
  });

  it("asks for the full status so the shared column can render it", async () => {
    const { ns, calls } = namespaceFor({ "apple.status": { raw: { supported: true } } });
    const status = await ns.getStatus!({ laneId: "lane-a" } as never);
    expect(calls[0]).toEqual({ action: "apple.status", args: { laneId: "lane-a", full: true } });
    expect(status).toEqual({ supported: true });
  });

  it("routes everything unnamed through the allowlisted passthrough", async () => {
    const { ns, calls } = namespaceFor({ "apple.invoke": { ok: true } });
    await ns.relaunchApp!({ laneId: "lane-a", chatSessionId: "chat-1", bundleId: "com.acme" } as never);
    expect(calls[0]!.action).toBe("apple.invoke");
    expect(calls[0]!.args).toMatchObject({
      method: "relaunchApp",
      laneId: "lane-a",
      chatSessionId: "chat-1",
    });
  });

  it("carries no window-capture affordances, because there is no window", async () => {
    const { ns } = namespaceFor();
    // `openSystemSettings`, `revealSimulator`, `getSimulatorWindowState` and
    // the two parking holds used to sit here as honest refusals. They are gone
    // from the preload contract entirely now — the helper reads the
    // framebuffer, so there is no Simulator.app window to reveal, park, or ask
    // a Screen Recording grant for on any surface, local or remote.
    for (const method of [
      "openSystemSettings",
      "revealSimulator",
      "getSimulatorWindowState",
      "retainWindowParking",
      "releaseWindowParking",
    ]) {
      expect((ns as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it("fails a lane-less live view with a sentence rather than a silent stub", async () => {
    const { ns } = namespaceFor();
    await expect(ns.startStream!({} as never)).rejects.toThrow(/needs a lane/);
  });

  it("does not subscribe to events it can never receive", () => {
    const { ns } = namespaceFor();
    const unsubscribe = (ns.onEvent as unknown as (cb: () => void) => () => void)(vi.fn());
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});
