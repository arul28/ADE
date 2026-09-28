import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPLE_STREAM_PATH_PREFIX,
  appleStreamTokenFromRequest,
  getActiveAppleStreamRouter,
  setActiveAppleStreamRouter,
  tryRouteAppleStreamSocket,
} from "./appleStreamListenerRoute";
import { relayPipeLocalPath } from "./syncTunnelClientService";

type AttachArgs = [{ send(data: Uint8Array): void }, { ticket: string; token: string | null }];

function router(attach = vi.fn(async (..._args: AttachArgs) => true)) {
  return {
    attach,
    ticketFromUrl: (url: string | null | undefined) =>
      typeof url === "string" && url.startsWith(APPLE_STREAM_PATH_PREFIX)
        ? (url.split("?")[0] ?? "").slice(APPLE_STREAM_PATH_PREFIX.length)
        : null,
    hasTicket: undefined as ((ticket: string) => boolean) | undefined,
  };
}

function socket() {
  const sent: Array<{ data: Uint8Array; compress?: boolean }> = [];
  return {
    sent,
    closed: null as number | null,
    send(data: Uint8Array, options?: { compress?: boolean }) {
      sent.push({ data, compress: options?.compress });
    },
    close(code?: number) {
      this.closed = code ?? 1000;
    },
    on: vi.fn(),
  };
}

afterEach(() => {
  setActiveAppleStreamRouter(null);
});

describe("appleStreamTokenFromRequest", () => {
  it("reads the bearer header a native client can set", () => {
    expect(appleStreamTokenFromRequest({ headers: { authorization: "Bearer abc" } })).toBe("abc");
  });

  it("falls back to the query a browser has to use", () => {
    expect(appleStreamTokenFromRequest({ url: "/apple/stream/x?token=abc" })).toBe("abc");
  });

  it("is null when neither is present", () => {
    expect(appleStreamTokenFromRequest({ url: "/apple/stream/x" })).toBeNull();
  });
});

describe("tryRouteAppleStreamSocket", () => {
  it("leaves a sync socket alone", () => {
    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/" }, router())).toBe(false);
  });

  it("leaves an apple socket alone when no relay is registered", () => {
    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/abc" }, null)).toBe(false);
  });

  it("diverts an apple socket and never compresses the video frames", () => {
    const attach = vi.fn(async (..._args: AttachArgs) => true);
    const ws = socket();
    expect(tryRouteAppleStreamSocket(
      ws as never,
      { url: "/apple/stream/abc?token=tok" },
      router(attach),
    )).toBe(true);
    expect(attach).toHaveBeenCalledWith(expect.anything(), { ticket: "abc", token: "tok" });
    attach.mock.calls[0]![0].send(new Uint8Array([1, 2]));
    expect(ws.sent[0]!.compress).toBe(false);
  });

  it("routes through the registered forwarder by default and lets a detach clear it", () => {
    const registered = router();
    const detach = setActiveAppleStreamRouter(registered);
    const active = getActiveAppleStreamRouter();
    expect(active).not.toBeNull();
    expect(active?.ticketFromUrl("/apple/stream/abc")).toBe("abc");
    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/abc" })).toBe(true);
    expect(registered.attach).toHaveBeenCalledWith(expect.anything(), { ticket: "abc", token: null });
    detach();
    expect(getActiveAppleStreamRouter()).toBeNull();
    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/abc" })).toBe(false);
  });

  it("sends a ticket to the forwarder that issued it, not the newest one", () => {
    // One brain opens several projects, each with its own forwarder and
    // tickets. The last one used to take every socket, so an older project's
    // ticket was unknown and the viewer was closed with 4401.
    const older = router();
    const newer = router();
    older.hasTicket = (ticket) => ticket === "old-ticket";
    newer.hasTicket = (ticket) => ticket === "new-ticket";
    setActiveAppleStreamRouter(older);
    setActiveAppleStreamRouter(newer);

    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/old-ticket?token=tok" })).toBe(true);
    expect(older.attach).toHaveBeenCalledWith(expect.anything(), { ticket: "old-ticket", token: "tok" });
    expect(newer.attach).not.toHaveBeenCalled();

    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/new-ticket" })).toBe(true);
    expect(newer.attach).toHaveBeenCalledWith(expect.anything(), { ticket: "new-ticket", token: null });
  });

  it("falls back to the newest forwarder when none claims the ticket", () => {
    const older = router();
    const newer = router();
    setActiveAppleStreamRouter(older);
    setActiveAppleStreamRouter(newer);

    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/unknown" })).toBe(true);
    expect(newer.attach).toHaveBeenCalledWith(expect.anything(), { ticket: "unknown", token: null });
    expect(older.attach).not.toHaveBeenCalled();
  });
});

describe("relayPipeLocalPath", () => {
  it("accepts a well-formed apple stream path", () => {
    expect(relayPipeLocalPath({ kind: "apple-stream", path: "/apple/stream/abcdefgh?token=tok12345" }))
      .toBe("/apple/stream/abcdefgh?token=tok12345");
  });

  it("dials the root for an ordinary sync pipe", () => {
    expect(relayPipeLocalPath({})).toBe("");
  });

  it("refuses any other local path a relay client might name", () => {
    expect(relayPipeLocalPath({ kind: "apple-stream", path: "/ade-attachments/upload" })).toBe("");
    expect(relayPipeLocalPath({ kind: "apple-stream", path: "/apple/stream/../../x" })).toBe("");
    expect(relayPipeLocalPath({ kind: "apple-stream", path: "//evil.example.com/" })).toBe("");
  });
});
