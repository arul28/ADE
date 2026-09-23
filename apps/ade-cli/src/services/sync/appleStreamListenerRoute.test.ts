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

  it("uses the registered router by default and lets a detach clear it", () => {
    const registered = router();
    const detach = setActiveAppleStreamRouter(registered);
    expect(getActiveAppleStreamRouter()).toBe(registered);
    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/abc" })).toBe(true);
    detach();
    expect(getActiveAppleStreamRouter()).toBeNull();
    expect(tryRouteAppleStreamSocket(socket() as never, { url: "/apple/stream/abc" })).toBe(false);
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
