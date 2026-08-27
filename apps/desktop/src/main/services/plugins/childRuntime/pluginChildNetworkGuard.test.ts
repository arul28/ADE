/**
 * The child half of the declared-network contract.
 *
 * Every case drives the guard against FAKE globals and fake core modules, so a
 * test never opens a socket and never depends on what this machine can reach.
 * The four doors are proven one at a time because they are patched one at a
 * time, and a plugin that reaches for a different one is the exact way this
 * guard has to fail.
 */

import { describe, expect, it, vi } from "vitest";

import { PluginSdkError } from "../../../../shared/plugins/sdk";
import {
  installPluginNetworkGuard,
  type PluginNetworkGuardTargets,
} from "./pluginChildNetworkGuard";

type Refusal = { message: string; fields: Record<string, unknown> };

function harness(hosts: readonly string[]) {
  const refusals: Refusal[] = [];
  const calls: { door: string; args: unknown[] }[] = [];
  const record = (door: string) => (...args: unknown[]) => {
    calls.push({ door, args });
    return `${door}-ok`;
  };
  const targets: PluginNetworkGuardTargets = {
    globals: {
      fetch: vi.fn(async (...args: unknown[]) => {
        calls.push({ door: "fetch", args });
        return "fetch-ok";
      }),
    },
    modules: {
      http: { request: record("http.request"), get: record("http.get") },
      https: { request: record("https.request"), get: record("https.get") },
      net: { connect: record("net.connect"), createConnection: record("net.createConnection") },
      tls: { connect: record("tls.connect") },
    },
  };
  installPluginNetworkGuard({
    pluginId: "ade-cursor-cloud",
    hosts,
    onRefused: (message, fields) => refusals.push({ message, fields }),
    targets,
  });
  return { targets, refusals, calls };
}

describe("installPluginNetworkGuard — fetch", () => {
  it("lets a declared host through untouched", async () => {
    const { targets, calls, refusals } = harness(["api.cursor.com"]);
    const fetchFn = targets.globals.fetch as (input: string) => Promise<unknown>;
    await expect(fetchFn("https://api.cursor.com/v1/agents")).resolves.toBe("fetch-ok");
    expect(calls).toHaveLength(1);
    expect(refusals).toEqual([]);
  });

  it("rejects an undeclared host rather than throwing synchronously", async () => {
    const { targets, calls, refusals } = harness(["api.cursor.com"]);
    const fetchFn = targets.globals.fetch as (input: string) => Promise<unknown>;
    await expect(fetchFn("https://evil.test/steal")).rejects.toMatchObject({
      code: "network_host_not_declared",
    });
    expect(calls).toHaveLength(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.fields).toMatchObject({
      code: "network_host_not_declared",
      host: "evil.test",
      via: "fetch",
    });
  });

  it("reads the host off a Request-like input", async () => {
    const { targets, calls } = harness(["api.cursor.com"]);
    const fetchFn = targets.globals.fetch as (input: unknown) => Promise<unknown>;
    await expect(fetchFn({ url: "https://api.cursor.com/v1" })).resolves.toBe("fetch-ok");
    await expect(fetchFn({ url: "https://evil.test/v1" })).rejects.toBeInstanceOf(PluginSdkError);
    expect(calls).toHaveLength(1);
  });

  it("refuses a URL it cannot read at all", async () => {
    const { targets, refusals } = harness(["api.cursor.com"]);
    const fetchFn = targets.globals.fetch as (input: string) => Promise<unknown>;
    await expect(fetchFn("/relative/path")).rejects.toBeInstanceOf(PluginSdkError);
    expect(refusals).toHaveLength(1);
  });

  it("refuses everything for a plugin that declares no network", async () => {
    const { targets, calls } = harness([]);
    const fetchFn = targets.globals.fetch as (input: string) => Promise<unknown>;
    await expect(fetchFn("https://api.cursor.com/v1")).rejects.toBeInstanceOf(PluginSdkError);
    expect(calls).toHaveLength(0);
  });
});

describe("installPluginNetworkGuard — http and https", () => {
  it("allows a declared host through both the URL and the options form", () => {
    const { targets, calls } = harness(["api.cursor.com"]);
    const https = targets.modules.https as Record<string, (...args: unknown[]) => unknown>;
    expect(https.get!("https://api.cursor.com/v1")).toBe("https.get-ok");
    expect(https.request!({ hostname: "api.cursor.com", path: "/v1" })).toBe("https.request-ok");
    expect(calls).toHaveLength(2);
  });

  it("throws on an undeclared host, before the request is made", () => {
    const { targets, calls, refusals } = harness(["api.cursor.com"]);
    const https = targets.modules.https as Record<string, (...args: unknown[]) => unknown>;
    expect(() => https.get!("https://evil.test/x")).toThrow(PluginSdkError);
    expect(calls).toHaveLength(0);
    expect(refusals[0]!.fields).toMatchObject({ host: "evil.test", via: "https.get" });
  });

  it("reads a host that carries a port", () => {
    const { targets, calls } = harness(["api.cursor.com"]);
    const http = targets.modules.http as Record<string, (...args: unknown[]) => unknown>;
    expect(http.request!({ host: "api.cursor.com:8443", path: "/x" })).toBe("http.request-ok");
    expect(calls).toHaveLength(1);
  });

  it("treats a request with no host as the localhost dial Node makes it", () => {
    const { targets, refusals } = harness(["api.cursor.com"]);
    const http = targets.modules.http as Record<string, (...args: unknown[]) => unknown>;
    expect(() => http.request!({ path: "/x" })).toThrow(PluginSdkError);
    expect(refusals[0]!.fields).toMatchObject({ host: "localhost" });
  });

  it("lets a plugin that declared localhost reach it", () => {
    const { targets, calls } = harness(["localhost"]);
    const http = targets.modules.http as Record<string, (...args: unknown[]) => unknown>;
    expect(http.request!({ port: 8080, path: "/x" })).toBe("http.request-ok");
    expect(calls).toHaveLength(1);
  });

  it("follows the wildcard rule the redirect chain needs", () => {
    const { targets, calls } = harness(["huggingface.co", "*.hf.co"]);
    const https = targets.modules.https as Record<string, (...args: unknown[]) => unknown>;
    expect(https.get!("https://huggingface.co/model.bin")).toBe("https.get-ok");
    expect(https.get!("https://us.aws.cdn.hf.co/xet/abc")).toBe("https.get-ok");
    expect(() => https.get!("https://hf.co.evil.test/x")).toThrow(PluginSdkError);
    expect(calls).toHaveLength(2);
  });
});

describe("installPluginNetworkGuard — the socket backstop", () => {
  it("refuses a raw TCP connect to an undeclared host", () => {
    const { targets, calls } = harness(["api.cursor.com"]);
    const net = targets.modules.net as Record<string, (...args: unknown[]) => unknown>;
    expect(() => net.connect!({ host: "evil.test", port: 443 })).toThrow(PluginSdkError);
    expect(() => net.connect!(443, "evil.test")).toThrow(PluginSdkError);
    expect(calls).toHaveLength(0);
  });

  it("allows a declared host, through tls as well as net", () => {
    const { targets, calls } = harness(["api.cursor.com"]);
    const net = targets.modules.net as Record<string, (...args: unknown[]) => unknown>;
    const tls = targets.modules.tls as Record<string, (...args: unknown[]) => unknown>;
    expect(net.createConnection!({ host: "api.cursor.com", port: 443 })).toBe("net.createConnection-ok");
    expect(tls.connect!({ host: "api.cursor.com", port: 443 })).toBe("tls.connect-ok");
    expect(calls).toHaveLength(2);
  });

  it("leaves unix-domain sockets alone — a path is not a host", () => {
    const { targets, calls, refusals } = harness([]);
    const net = targets.modules.net as Record<string, (...args: unknown[]) => unknown>;
    expect(net.connect!("/tmp/ade.sock")).toBe("net.connect-ok");
    expect(net.connect!({ path: "/tmp/ade.sock" })).toBe("net.connect-ok");
    expect(calls).toHaveLength(2);
    expect(refusals).toEqual([]);
  });
});

describe("installPluginNetworkGuard — WebSocket", () => {
  it("refuses an undeclared host and builds an allowed one", () => {
    const built: string[] = [];
    class FakeSocket {
      static readonly OPEN = 1;
      constructor(url: string) {
        built.push(url);
      }
    }
    const targets: PluginNetworkGuardTargets = {
      globals: { WebSocket: FakeSocket },
      modules: {},
    };
    installPluginNetworkGuard({
      pluginId: "ade-cursor-cloud",
      hosts: ["api.cursor.com"],
      onRefused: () => undefined,
      targets,
    });
    const Guarded = targets.globals.WebSocket as unknown as {
      new (url: string): unknown;
      OPEN: number;
    };
    expect(() => new Guarded("wss://evil.test/socket")).toThrow(PluginSdkError);
    new Guarded("wss://api.cursor.com/socket");
    expect(built).toEqual(["wss://api.cursor.com/socket"]);
    // The static a plugin reads to compare readyState must survive the wrap.
    expect(Guarded.OPEN).toBe(1);
  });
});

describe("installPluginNetworkGuard — the audit line", () => {
  it("writes one refusal line per refused request, with the code as a field", () => {
    const { targets, refusals } = harness(["api.cursor.com"]);
    const https = targets.modules.https as Record<string, (...args: unknown[]) => unknown>;
    expect(() => https.get!("https://a.test/1")).toThrow();
    expect(() => https.get!("https://b.test/2")).toThrow();
    expect(refusals).toHaveLength(2);
    expect(refusals.map((entry) => entry.fields.host)).toEqual(["a.test", "b.test"]);
    // No secret, no URL path, no query string — only the host and the door.
    for (const refusal of refusals) {
      expect(Object.keys(refusal.fields).sort()).toEqual(["code", "host", "via"]);
      expect(refusal.message).not.toContain("/1");
      expect(refusal.message).not.toContain("/2");
    }
  });
});
