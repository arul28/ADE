import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import {
  MAX_CLIENT_BACKLOG_BYTES,
  ZERO_CLIENT_GRACE_MS,
  answerLoopbackPreamble,
  bindLoopbackServer,
  openStreamBody,
  safeEqual,
  writeWithBacklog,
} from "./loopbackTokenServer";

/** The two methods the module touches, plus what it did to them. */
type FakeResponse = ServerResponse & {
  headers: Record<string, string>;
  head: { status: number; headers?: Record<string, string> } | null;
  ended: boolean;
  flushed: boolean;
  writes: Uint8Array[];
  pending: Array<() => void>;
};

function fakeResponse(): FakeResponse {
  const response = {
    headers: {} as Record<string, string>,
    head: null as { status: number; headers?: Record<string, string> } | null,
    ended: false,
    flushed: false,
    writes: [] as Uint8Array[],
    pending: [] as Array<() => void>,
    setHeader(name: string, value: string) {
      response.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      response.head = { status, headers };
      return response;
    },
    end() {
      response.ended = true;
    },
    flushHeaders() {
      response.flushed = true;
    },
    write(chunk: Uint8Array, callback?: () => void) {
      response.writes.push(chunk);
      if (callback) response.pending.push(callback);
      return true;
    },
  };
  return response as unknown as FakeResponse;
}

describe("safeEqual", () => {
  it("accepts an identical token and rejects everything else", () => {
    expect(safeEqual("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(safeEqual("a".repeat(64), "b".repeat(64))).toBe(false);
    // Hashing first is what lets a different-length candidate be compared at
    // all: `timingSafeEqual` throws on mismatched lengths.
    expect(safeEqual("short", "a".repeat(64))).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("answerLoopbackPreamble", () => {
  it("sets the CORS and cache headers on every request", () => {
    const response = fakeResponse();
    const done = answerLoopbackPreamble({ method: "GET" } as IncomingMessage, response);
    expect(done).toBe(false);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.head).toBeNull();
  });

  it("answers a preflight itself and tells the caller to stop", () => {
    const response = fakeResponse();
    const done = answerLoopbackPreamble({ method: "OPTIONS" } as IncomingMessage, response);
    expect(done).toBe(true);
    expect(response.head?.status).toBe(204);
    expect(response.ended).toBe(true);
  });
});

describe("openStreamBody", () => {
  it("opens a chunked body, disables Nagle and flushes the head", () => {
    const response = fakeResponse();
    let noDelay = false;
    openStreamBody(
      { socket: { setNoDelay: (value: boolean) => { noDelay = value; } } } as unknown as IncomingMessage,
      response,
    );
    expect(response.head?.status).toBe(200);
    expect(response.head?.headers?.["Content-Type"]).toBe("application/octet-stream");
    expect(noDelay).toBe(true);
    expect(response.flushed).toBe(true);
  });
});

describe("writeWithBacklog", () => {
  it("charges the write and releases it once the callback fires", () => {
    const response = fakeResponse();
    const client = { backlogBytes: 0 };
    expect(writeWithBacklog(client, response, new Uint8Array(100), () => {
      throw new Error("must not drop");
    })).toBe(true);
    expect(client.backlogBytes).toBe(100);
    response.pending.forEach((callback) => callback());
    expect(client.backlogBytes).toBe(0);
  });

  it("releases once even if the callback fires twice", () => {
    const response = fakeResponse();
    const client = { backlogBytes: 200 };
    writeWithBacklog(client, response, new Uint8Array(100), () => {});
    response.pending[0]?.();
    response.pending[0]?.();
    expect(client.backlogBytes).toBe(200);
  });

  it("drops a reader past the backlog ceiling instead of writing", () => {
    const response = fakeResponse();
    const client = { backlogBytes: MAX_CLIENT_BACKLOG_BYTES };
    const reasons: string[] = [];
    expect(writeWithBacklog(client, response, new Uint8Array(1), (reason) => {
      reasons.push(reason);
    })).toBe(false);
    expect(reasons).toEqual(["backlog"]);
    expect(response.writes).toEqual([]);
  });
});

describe("bindLoopbackServer", () => {
  it("binds an ephemeral loopback port with the live-view timeouts", async () => {
    const { server, port } = await bindLoopbackServer(
      (_request, response) => {
        response.writeHead(200).end("ok");
      },
      { bindErrorMessage: "no port" },
    );
    try {
      expect(port).toBeGreaterThan(0);
      expect(server.keepAliveTimeout).toBe(0);
      expect(server.requestTimeout).toBe(0);
      const response = await fetch(`http://127.0.0.1:${port}/anything`);
      expect(await response.text()).toBe("ok");
    } finally {
      server.close();
    }
  });
});

describe("the shared grace period", () => {
  it("is the one both servers wait before tearing an encoder down", () => {
    expect(ZERO_CLIENT_GRACE_MS).toBe(3_000);
  });
});
