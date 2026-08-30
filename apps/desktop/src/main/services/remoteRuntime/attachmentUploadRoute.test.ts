import { describe, expect, it } from "vitest";
import { resolveRemoteAttachmentUploadRoute } from "./attachmentUploadRoute";

const CAPABLE = {
  features: {
    attachmentUploadV1: { enabled: true as const, path: "/ade-attachments/upload", maxBytes: 52_428_800 },
  },
} as never;

describe("resolveRemoteAttachmentUploadRoute", () => {
  it("maps a direct ws endpoint to the http upload URL", () => {
    expect(resolveRemoteAttachmentUploadRoute({
      endpoint: "ws://192.168.1.20:8787/",
      hello: CAPABLE,
    })).toEqual({ url: "http://192.168.1.20:8787/ade-attachments/upload", maxBytes: 52_428_800 });
  });

  it("maps a direct wss endpoint to https", () => {
    expect(resolveRemoteAttachmentUploadRoute({
      endpoint: "wss://mac.tail1234.ts.net:8787/",
      hello: CAPABLE,
    })?.url).toBe("https://mac.tail1234.ts.net:8787/ade-attachments/upload");
  });

  it("drops any query or fragment on the sync endpoint", () => {
    expect(resolveRemoteAttachmentUploadRoute({
      endpoint: "ws://host:8787/?token=abc#frag",
      hello: CAPABLE,
    })?.url).toBe("http://host:8787/ade-attachments/upload");
  });

  it("returns null for a host that does not advertise the route", () => {
    expect(resolveRemoteAttachmentUploadRoute({
      endpoint: "ws://host:8787/",
      hello: { features: {} } as never,
    })).toBeNull();
    expect(resolveRemoteAttachmentUploadRoute({
      endpoint: "ws://host:8787/",
      hello: null,
    })).toBeNull();
  });

  it("returns null on a relay-routed socket", () => {
    // The relay brokers WebSocket frames only; an HTTP POST to that URL would
    // never reach the host's own listener.
    expect(resolveRemoteAttachmentUploadRoute({
      endpoint: "wss://relay.ade.dev/bridge/abc",
      hello: { ...(CAPABLE as object), connectionTransport: "relay" } as never,
    })).toBeNull();
  });

  it("returns null for an endpoint that is not a websocket URL", () => {
    for (const endpoint of ["ssh://host:22", "not a url", ""]) {
      expect(resolveRemoteAttachmentUploadRoute({ endpoint, hello: CAPABLE })).toBeNull();
    }
  });

  it("returns null for a malformed capability", () => {
    const cases = [
      { enabled: true, path: "ade-attachments/upload", maxBytes: 10 },
      { enabled: true, path: "/ok", maxBytes: 0 },
      { enabled: true, path: "/ok", maxBytes: Number.NaN },
    ];
    for (const attachmentUploadV1 of cases) {
      expect(resolveRemoteAttachmentUploadRoute({
        endpoint: "ws://host:8787/",
        hello: { features: { attachmentUploadV1 } } as never,
      })).toBeNull();
    }
  });

  it("follows a route path the host moved in a later version", () => {
    expect(resolveRemoteAttachmentUploadRoute({
      endpoint: "ws://host:8787/",
      hello: {
        features: { attachmentUploadV1: { enabled: true, path: "/ade-attachments/v2", maxBytes: 100 } },
      } as never,
    })).toEqual({ url: "http://host:8787/ade-attachments/v2", maxBytes: 100 });
  });
});
