import { describe, expect, it, vi } from "vitest";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  CONNECTION_ID_PATTERN,
  generateConnectionId,
  handleRequest,
  hmacSha256Hex,
  locationHintForGeo,
  mcpAccountKeyForSecret,
  routeMcpPath,
  routeTunnelPath,
  verifySignedQuery,
  type TunnelRelayEnv,
} from "../src/relay";
import {
  CLOSE_BRIDGE_REJECTED,
  CLOSE_FORWARD_FAILED,
  CLOSE_HOST_OFFLINE,
  CLOSE_NOT_READY,
  CLOSE_PARTNER_CLOSED,
  CLOSE_PRE_PIPE_BUFFER_OVERFLOW,
  CLOSE_STALE_PIPE,
  LEGACY_CONTROL_EPOCH,
  RELAY_READY_VERSION,
  TunnelDurableObject,
} from "../src/tunnelDo";

const MACHINE_KEY = "a".repeat(48);
const SECRET = "s".repeat(48);
const CONTROL_EPOCH = "e".repeat(32);

// Minimal Durable Object storage stand-in — enough to exercise the claim path
// and the pre-upgrade auth rejections without a live runtime. Socket pairing
// and hibernation are covered by the wrangler-dev smoke test (see README).
class FakeStorage {
  private map = new Map<string, unknown>();
  private alarm: number | null = null;
  setAlarmCalls = 0;
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(time: number): Promise<void> {
    this.setAlarmCalls += 1;
    this.alarm = time;
  }
}

type TestSocketRole = "control" | "client" | "pipe";

class FakeSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  throwOnSend = false;

  constructor(
    readonly tags: string[],
    private attachment: {
      role: TestSocketRole;
      id?: string;
      epoch?: string;
      readyVersion?: typeof RELAY_READY_VERSION;
      established?: boolean;
      legacyBuffered?: true;
      legacyStateUnknown?: true;
      correlationId?: string;
      ts: number;
    },
  ) {}

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment as typeof this.attachment;
  }

  send(value: unknown): void {
    if (this.throwOnSend) throw new Error("socket is dead");
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

class FakeState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];

  addSocket(
    role: TestSocketRole,
    id?: string,
    ts = Date.now(),
    options: {
      epoch?: string;
      omitEpoch?: boolean;
      readyVersion?: typeof RELAY_READY_VERSION;
      established?: boolean;
      legacyBuffered?: boolean;
      correlationId?: string;
    } = {},
  ): FakeSocket {
    const epoch = options.epoch ?? CONTROL_EPOCH;
    const tags = [role, ...(id ? [`conn:${id}`] : []), ...(options.omitEpoch ? [] : [`epoch:${epoch}`])];
    const socket = new FakeSocket(tags, {
      role,
      id,
      ...(!options.omitEpoch ? { epoch } : {}),
      ...(options.readyVersion ? { readyVersion: options.readyVersion } : {}),
      ...(options.established ? { established: true } : {}),
      ...(options.legacyBuffered ? { legacyBuffered: true as const } : {}),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ts,
    });
    this.sockets.push(socket);
    return socket;
  }

  getWebSockets(tag?: string): WebSocket[] {
    const sockets = tag ? this.sockets.filter((socket) => socket.tags.includes(tag)) : this.sockets;
    return sockets as unknown as WebSocket[];
  }

  acceptWebSocket(): void {}
}

function makeDoHarness(): { durable: TunnelDurableObject; state: FakeState; storage: FakeStorage } {
  const state = new FakeState();
  const durable = new TunnelDurableObject(state as unknown as DurableObjectState, {} as TunnelRelayEnv);
  return { durable, state, storage: state.storage };
}

function makeDo(): TunnelDurableObject {
  const { durable } = makeDoHarness();
  return durable;
}

function installAcceptSocketStub(durable: TunnelDurableObject, state: FakeState): void {
  const testDurable = durable as unknown as {
    acceptSocket: (
      attachment: {
        role: TestSocketRole;
        id?: string;
        epoch?: string;
        readyVersion?: typeof RELAY_READY_VERSION;
        correlationId?: string;
      },
      afterAccept?: (socket: WebSocket) => void,
    ) => Promise<Response>;
  };
  testDurable.acceptSocket = async (attachment, afterAccept) => {
    const socket = state.addSocket(attachment.role, attachment.id, Date.now(), {
      epoch: attachment.epoch,
      readyVersion: attachment.readyVersion,
      correlationId: attachment.correlationId,
    });
    afterAccept?.(socket as unknown as WebSocket);
    return new Response(null, { status: 200 });
  };
}

async function signedPipeRequest(args: {
  id: string;
  epoch?: string;
}): Promise<Request> {
  const ts = String(Math.floor(Date.now() / 1_000));
  const base = args.epoch
    ? buildPipeSignatureBase(MACHINE_KEY, args.id, args.epoch, ts)
    : buildPipeSignatureBase(MACHINE_KEY, args.id, ts);
  const sig = await hmacSha256Hex(SECRET, base);
  const query = new URLSearchParams({ ts, sig });
  if (args.epoch) query.set("epoch", args.epoch);
  return new Request(`https://relay.test/host/${MACHINE_KEY}/pipe/${args.id}?${query}`, {
    headers: { Upgrade: "websocket" },
  });
}

function claimRequest(secret: unknown): Request {
  return new Request(`https://relay.test/machines/${MACHINE_KEY}/claim`, {
    method: "POST",
    body: JSON.stringify({ secret }),
    headers: { "content-type": "application/json" },
  });
}

describe("routeTunnelPath", () => {
  it("matches each tunnel route", () => {
    expect(routeTunnelPath(`/machines/${MACHINE_KEY}/claim`)).toEqual({ kind: "claim", machineKey: MACHINE_KEY });
    expect(routeTunnelPath(`/host/${MACHINE_KEY}`)).toEqual({ kind: "host", machineKey: MACHINE_KEY });
    expect(routeTunnelPath(`/host/${MACHINE_KEY}/pipe/abcdef01`)).toEqual({
      kind: "pipe",
      machineKey: MACHINE_KEY,
      id: "abcdef01",
    });
    expect(routeTunnelPath(`/connect/${MACHINE_KEY}`)).toEqual({ kind: "connect", machineKey: MACHINE_KEY });
    expect(routeTunnelPath(`/prewarm/${MACHINE_KEY}`)).toEqual({ kind: "prewarm", machineKey: MACHINE_KEY });
  });

  it("rejects bad machine keys and connection ids", () => {
    expect(routeTunnelPath("/host/not-hex")).toBeNull();
    expect(routeTunnelPath(`/host/${MACHINE_KEY}/pipe/NOThex!`)).toBeNull();
    expect(routeTunnelPath(`/machines/${MACHINE_KEY}/publish`)).toBeNull();
    expect(routeTunnelPath("/prewarm/not-hex")).toBeNull();
    expect(routeTunnelPath(`/prewarm/${MACHINE_KEY}/extra`)).toBeNull();
    expect(routeTunnelPath("/unknown")).toBeNull();
  });
});

describe("routeMcpPath", () => {
  const KEY = "b".repeat(40);
  it.each([
    ["per-machine MCP", `/m/${KEY}/mcp?x=1`, { kind: "mcp", machineKey: KEY, path: "/mcp?x=1" }],
    ["account MCP", `/a/${KEY}/mcp`, { kind: "mcp-account", accountKey: KEY, path: "/mcp" }],
    ["account root", `/a/${KEY}`, { kind: "mcp-account", accountKey: KEY, path: "/" }],
    ["account OAuth path keeps its encoding", `/a/${KEY}/oauth/authorize?state=s%20t`, { kind: "mcp-account", accountKey: KEY, path: "/oauth/authorize?state=s%20t" }],
    ["account key is lowercased", `/a/${KEY.toUpperCase()}/mcp`, { kind: "mcp-account", accountKey: KEY, path: "/mcp" }],
    ["account protected-resource discovery", `/.well-known/oauth-protected-resource/a/${KEY}/mcp`, { kind: "mcp-account", accountKey: KEY, path: "/.well-known/oauth-protected-resource/mcp" }],
    ["account authorization-server discovery", `/.well-known/oauth-authorization-server/a/${KEY}`, { kind: "mcp-account", accountKey: KEY, path: "/.well-known/oauth-authorization-server" }],
    ["account openid discovery", `/.well-known/openid-configuration/a/${KEY}`, { kind: "mcp-account", accountKey: KEY, path: "/.well-known/openid-configuration" }],
    ["account key that is not hex", "/a/not-a-key/mcp", null],
    ["account key that is too short", `/a/${"b".repeat(31)}/mcp`, null],
    ["dot segment under an account", `/a/${KEY}/%2e%2e/mcp`, null],
    ["unknown discovery kind", `/.well-known/security.txt/a/${KEY}`, null],
    ["internal account path", "/__mcp-account", null],
  ] as const)("%s", (_label, path, expected) => {
    expect(routeMcpPath(new URL(`https://relay.test${path}`))).toEqual(expected);
  });
});

describe("locationHintForGeo", () => {
  it("splits the two-region continents on longitude", () => {
    expect(locationHintForGeo({ continent: "NA", longitude: "-122.33" })).toBe("wnam"); // Seattle
    expect(locationHintForGeo({ continent: "NA", longitude: "-73.94" })).toBe("enam"); // New York
    expect(locationHintForGeo({ continent: "EU", longitude: "-0.13" })).toBe("weur"); // London
    expect(locationHintForGeo({ continent: "EU", longitude: "30.52" })).toBe("eeur"); // Kyiv
    expect(locationHintForGeo({ continent: "AS", longitude: "55.27" })).toBe("me"); // Dubai
    expect(locationHintForGeo({ continent: "AS", longitude: "139.69" })).toBe("apac"); // Tokyo
  });

  it("maps the single-region continents", () => {
    expect(locationHintForGeo({ continent: "sa", longitude: "-46.63" })).toBe("sam");
    expect(locationHintForGeo({ continent: "AF", longitude: "18.42" })).toBe("afr");
    expect(locationHintForGeo({ continent: "OC", longitude: "151.21" })).toBe("oc");
  });

  it("falls back to the larger half when the longitude is missing or junk", () => {
    expect(locationHintForGeo({ continent: "NA" })).toBe("enam");
    expect(locationHintForGeo({ continent: "EU", longitude: "not-a-number" })).toBe("weur");
    expect(locationHintForGeo({ continent: "AS", longitude: 999 })).toBe("apac");
    // An empty longitude is missing data, not the prime meridian — `Number("")`
    // is 0, which would otherwise read as a real coordinate and pick `me`.
    expect(locationHintForGeo({ continent: "AS", longitude: "" })).toBe("apac");
    expect(locationHintForGeo({ continent: "AS", longitude: "  " })).toBe("apac");
  });

  it("declines to hint when the geography is unknown", () => {
    // `request.cf` is absent under `wrangler dev` and for unrecognized regions;
    // Cloudflare's own placement is the right answer there.
    expect(locationHintForGeo(undefined)).toBeUndefined();
    expect(locationHintForGeo(null)).toBeUndefined();
    expect(locationHintForGeo({})).toBeUndefined();
    expect(locationHintForGeo({ continent: "XX", longitude: "10" })).toBeUndefined();
  });
});

describe("Durable Object placement", () => {
  function routerHarness(): { env: TunnelRelayEnv; hints: Array<string | undefined> } {
    const hints: Array<string | undefined> = [];
    const stub = { fetch: async () => new Response("routed") } as unknown as DurableObjectStub;
    const env = {
      TUNNEL: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: (_id: DurableObjectId, options?: { locationHint?: string }) => {
          hints.push(options?.locationHint);
          return stub;
        },
      } as unknown as DurableObjectNamespace,
    } as TunnelRelayEnv;
    return { env, hints };
  }

  function geoRequest(path: string, cf?: Record<string, unknown>): Request {
    const request = new Request(`https://relay.test${path}`);
    return (cf ? Object.assign(request, { cf }) : request) as Request;
  }

  it("hints placement from the machine's own routes", async () => {
    const { env, hints } = routerHarness();
    const cf = { continent: "NA", longitude: "-122.33" };

    await handleRequest(geoRequest(`/machines/${MACHINE_KEY}/claim`, cf), env);
    await handleRequest(geoRequest(`/host/${MACHINE_KEY}`, cf), env);

    expect(hints).toEqual(["wnam", "wnam"]);
  });

  it("never lets a phone's location place a machine's object", async () => {
    const { env, hints } = routerHarness();
    // A travelling phone must not drag the object away from the machine, and a
    // pipe/prewarm arrives long after placement is already settled.
    const cf = { continent: "AS", longitude: "139.69" };

    await handleRequest(geoRequest(`/connect/${MACHINE_KEY}`, cf), env);
    await handleRequest(geoRequest(`/prewarm/${MACHINE_KEY}`, cf), env);
    await handleRequest(geoRequest(`/host/${MACHINE_KEY}/pipe/abcdef01`, cf), env);

    expect(hints).toEqual([undefined, undefined, undefined]);
  });

  it("omits the hint entirely when the request carries no geography", async () => {
    const { env, hints } = routerHarness();

    await handleRequest(geoRequest(`/machines/${MACHINE_KEY}/claim`), env);

    expect(hints).toEqual([undefined]);
  });
});

// A Durable Object restarting under Cloudflare. A request that can be sent
// twice gets one more try on a fresh stub; a WebSocket upgrade never does (the
// object may already hold its half of the socket) and the client reconnects.
// Whatever is not recovered is a 503 with Retry-After, not an unhandled 500.
describe("Durable Object transient failures", () => {
  const upgrade = { upgrade: "websocket" };
  const claimBody = JSON.stringify({ secret: SECRET });
  it.each([
    ["a host upgrade is not retried", `/host/${MACHINE_KEY}`, { headers: upgrade }, "Durable Object storage is no longer accessible.", 1, { status: 503, calls: 1 }],
    ["a phone upgrade is not retried", `/connect/${MACHINE_KEY}`, { headers: upgrade }, "internal error; reference = bnpch2gr1hv7r31ifl4tvhvh", 1, { status: 503, calls: 1 }],
    ["a prewarm is retried once", `/prewarm/${MACHINE_KEY}`, {}, "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.", 1, { status: 200, calls: 2, body: "" }],
    ["a claim is retried once with its body", `/machines/${MACHINE_KEY}/claim`, { method: "POST", body: claimBody }, "Internal error while starting up Durable Object storage caused object to be reset; reference = k", 1, { status: 200, calls: 2, body: claimBody }],
    ["a claim that keeps failing is a 503", `/machines/${MACHINE_KEY}/claim`, { method: "POST", body: claimBody }, "internal error; reference = z", 9, { status: 503, calls: 2 }],
    ["an MCP call is not sent twice", `/m/${MACHINE_KEY}/mcp`, { method: "POST", body: "{}" }, "internal error; reference = m", 1, { status: 503, calls: 1 }],
    ["an MCP stream GET is not sent twice", `/m/${MACHINE_KEY}/mcp`, {}, "internal error; reference = m", 1, { status: 503, calls: 1 }],
  ] as const)("%s", async (_label, path, init, message, failures, expected) => {
    let left: number = failures;
    let calls = 0;
    const stub = {
      fetch: async (request: Request) => {
        // The MCP endpoint lookup answers with the machine it belongs to.
        if (new URL(request.url).pathname === "/__mcp-endpoint") return Response.json({ machineKey: MACHINE_KEY });
        calls += 1;
        const body = request.body ? await request.text() : "";
        if (left > 0) {
          left -= 1;
          throw new Error(message);
        }
        return new Response(body);
      },
    };
    const env = {
      TUNNEL: { idFromName: (name: string) => name, get: () => stub } as unknown as DurableObjectNamespace,
    } as TunnelRelayEnv;

    const response = await handleRequest(new Request(`https://relay.test${path}`, init), env);

    expect(response.status).toBe(expected.status);
    expect(calls).toBe(expected.calls);
    if (expected.status === 503) expect(response.headers.get("retry-after")).toBe("5");
    if ("body" in expected) expect(await response.text()).toBe(expected.body);
  });

  it("still surfaces a failure that is not Cloudflare's", async () => {
    const env = {
      TUNNEL: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => { throw new TypeError("Cannot read properties of undefined"); } }),
      } as unknown as DurableObjectNamespace,
    } as TunnelRelayEnv;
    await expect(handleRequest(new Request(`https://relay.test/host/${MACHINE_KEY}`, { headers: { upgrade: "websocket" } }), env))
      .rejects.toThrow("Cannot read properties of undefined");
  });
});

describe("mcpAccountKeyForSecret", () => {
  it.each([
    ["32 random bytes in base64url", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0u_-", true],
    ["padded base64url", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0u_=", true],
    ["too short", "A1b2C3d4E5f6", false],
    ["standard base64 characters", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0u+/", false],
    ["too long", "a".repeat(129), false],
    ["not a string", 42, false],
  ] as const)("%s", async (_label, secret, valid) => {
    const expected = valid ? (await hmacSha256Hex(secret as string, "ade-mcp-account")).slice(0, 40) : null;
    const key = await mcpAccountKeyForSecret(secret);
    expect(key).toBe(expected);
    if (key) expect(key).toMatch(/^[a-f0-9]{40}$/);
  });
});

// The account address tries each computer on the account in turn, and only
// while the machine object proves the brain never saw the request.
describe("ADE MCP account failover", () => {
  const ACCOUNT_KEY = "c".repeat(40);
  const M1 = "1".repeat(48);
  const M2 = "2".repeat(48);
  const M3 = "3".repeat(48);
  type MachineAnswer = "ok" | "offline" | "off" | "lost" | "busy";

  function answerFor(kind: MachineAnswer, machineKey: string): Response {
    const cors = { "access-control-allow-origin": "*" };
    switch (kind) {
      case "ok":
        return new Response(`answered by ${machineKey}`, { status: 200, headers: cors });
      case "offline":
        return Response.json({ error: "offline" }, { status: 503, headers: { ...cors, "x-ade-mcp-undelivered": "offline" } });
      case "off":
        return Response.json({ error: "ade_mcp_off" }, { status: 404, headers: { ...cors, "x-ade-mcp-undelivered": "ade_mcp_off" } });
      case "lost":
        // Sent to the brain, then its socket went: the same 503, no marker.
        return Response.json({ error: "offline" }, { status: 503, headers: cors });
      case "busy":
        return Response.json({ error: "rate_limited" }, { status: 429, headers: cors });
    }
  }

  function accountHarness(args: {
    members: string[];
    front?: string | null;
    answers: Record<string, MachineAnswer>;
  }) {
    const tried: Array<{ machineKey: string; mount: string | null; body: string }> = [];
    const fronts: string[] = [];
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { waited.push(promise); } };
    const env = {
      TUNNEL: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: (id: DurableObjectId) => ({
          fetch: async (request: Request) => {
            const name = id as unknown as string;
            const url = new URL(request.url);
            if (name === `mcp-account:${ACCOUNT_KEY}`) {
              if (url.pathname === "/__mcp-account") return Response.json({ members: args.members, front: args.front ?? null });
              if (url.pathname === "/__mcp-account/front") {
                fronts.push(((await request.json()) as { machineKey: string }).machineKey);
                return new Response(null, { status: 204 });
              }
            }
            tried.push({ machineKey: name, mount: request.headers.get("x-ade-mcp-mount"), body: await request.text() });
            return answerFor(args.answers[name] ?? "offline", name);
          },
        }),
      } as unknown as DurableObjectNamespace,
    } as TunnelRelayEnv;
    const send = (init: RequestInit = { method: "POST", body: "{\"jsonrpc\":\"2.0\"}" }) =>
      handleRequest(new Request(`https://relay.test/a/${ACCOUNT_KEY}/mcp`, init), env, ctx);
    return { send, tried, fronts, settle: () => Promise.all(waited) };
  }

  it.each([
    ["front answers first", [M1, M2, M3], M1, { [M1]: "ok" }, [M1], 200, M1, []],
    ["newest first without a front", [M1, M2, M3], null, { [M3]: "ok" }, [M3], 200, M3, [M3]],
    ["a front that left is ignored", [M2, M3], M1, { [M3]: "ok" }, [M3], 200, M3, [M3]],
    ["offline front fails over to the newest", [M1, M2, M3], M1, { [M1]: "offline", [M3]: "ok" }, [M1, M3], 200, M3, [M3]],
    ["off and offline both fail over", [M1, M2, M3], null, { [M3]: "off", [M2]: "offline", [M1]: "ok" }, [M3, M2, M1], 200, M1, [M1]],
    ["a request the brain may have seen is final", [M1, M2], M2, { [M2]: "lost", [M1]: "ok" }, [M2], 503, null, []],
    ["a rate limit is final", [M1, M2], null, { [M2]: "busy", [M1]: "ok" }, [M2], 429, null, [M2]],
    ["all offline", [M1, M2], null, { [M1]: "offline", [M2]: "off" }, [M2, M1], 503, null, []],
    ["all off", [M1, M2], null, { [M1]: "off", [M2]: "off" }, [M2, M1], 404, null, []],
    ["no members", [], null, {}, [], 404, null, []],
  ] as const)("%s", async (_label, members, front, answers, expectedTried, status, answeredBy, expectedFronts) => {
    const harness = accountHarness({ members: [...members], front, answers: answers as Record<string, MachineAnswer> });

    const response = await harness.send();
    await harness.settle();

    expect(harness.tried.map((entry) => entry.machineKey)).toEqual(expectedTried);
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-ade-mcp-undelivered")).toBeNull();
    if (answeredBy) expect(await response.text()).toBe(`answered by ${answeredBy}`);
    if (status === 503 && !answeredBy && expectedTried.length > 1) {
      expect(response.headers.get("retry-after")).toBe("30");
      expect(await response.json()).toMatchObject({ error: "offline" });
    }
    if (status === 404) expect(await response.json()).toMatchObject({ error: "ade_mcp_off" });
    expect(harness.fronts).toEqual(expectedFronts);
  });

  it("resends the same body to each computer under the Worker's own mount", async () => {
    const harness = accountHarness({ members: [M1, M2], answers: { [M2]: "offline", [M1]: "ok" } });

    const response = await harness.send({
      method: "POST",
      headers: { "x-ade-mcp-mount": `a/${"d".repeat(40)}` },
      body: "{\"jsonrpc\":\"2.0\",\"id\":7}",
    });

    expect(response.status).toBe(200);
    expect(harness.tried).toEqual([
      { machineKey: M2, mount: `a/${ACCOUNT_KEY}`, body: "{\"jsonrpc\":\"2.0\",\"id\":7}" },
      { machineKey: M1, mount: `a/${ACCOUNT_KEY}`, body: "{\"jsonrpc\":\"2.0\",\"id\":7}" },
    ]);
  });

  it("refuses a body over 1 MiB without reaching a computer", async () => {
    const harness = accountHarness({ members: [M1], answers: { [M1]: "ok" } });

    const response = await harness.send({ method: "POST", body: "x".repeat(1024 * 1024 + 1) });

    expect(response.status).toBe(413);
    expect(harness.tried).toEqual([]);
  });

  it("drops a client's mount header on the per-machine address", async () => {
    const seen: Array<string | null> = [];
    const env = {
      TUNNEL: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname === "/__mcp-endpoint") return Response.json({ machineKey: MACHINE_KEY });
            seen.push(request.headers.get("x-ade-mcp-mount"));
            return new Response("ok");
          },
        }),
      } as unknown as DurableObjectNamespace,
    } as TunnelRelayEnv;

    await handleRequest(new Request(`https://relay.test/m/${"9".repeat(40)}/mcp`, {
      method: "POST",
      headers: { "x-ade-mcp-mount": `a/${ACCOUNT_KEY}` },
      body: "{}",
    }), env);

    expect(seen).toEqual([null]);
  });

  it("answers account preflight at the Worker", async () => {
    const harness = accountHarness({ members: [M1], answers: { [M1]: "ok" } });
    const response = await harness.send({ method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(harness.tried).toEqual([]);
  });
});

describe("verifySignedQuery", () => {
  it("accepts a correct signature within skew", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const base = buildHostSignatureBase(MACHINE_KEY, ts);
    const sig = await hmacSha256Hex(SECRET, base);
    expect(await verifySignedQuery({ secret: SECRET, base, timestamp: ts, signature: sig })).toEqual({ ok: true });
  });

  it("rejects a tampered signature", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const base = buildPipeSignatureBase(MACHINE_KEY, "abcdef01", ts);
    const sig = await hmacSha256Hex(SECRET, base);
    const result = await verifySignedQuery({
      secret: SECRET,
      base,
      timestamp: ts,
      signature: sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature signed for a different id", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signed = buildPipeSignatureBase(MACHINE_KEY, "aaaaaaaa", ts);
    const sig = await hmacSha256Hex(SECRET, signed);
    const attacked = buildPipeSignatureBase(MACHINE_KEY, "bbbbbbbb", ts);
    expect((await verifySignedQuery({ secret: SECRET, base: attacked, timestamp: ts, signature: sig })).ok).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const base = buildHostSignatureBase(MACHINE_KEY, ts);
    const sig = await hmacSha256Hex(SECRET, base);
    const result = await verifySignedQuery({ secret: SECRET, base, timestamp: ts, signature: sig });
    expect(result).toEqual({ ok: false, reason: "stale or invalid timestamp" });
  });

  it("rejects missing ts or sig", async () => {
    expect((await verifySignedQuery({ secret: SECRET, base: "x", timestamp: "", signature: "" })).ok).toBe(false);
  });
});

describe("generateConnectionId", () => {
  it("produces a hex id matching the route pattern", () => {
    for (let i = 0; i < 32; i += 1) {
      const id = generateConnectionId();
      expect(CONNECTION_ID_PATTERN.test(id)).toBe(true);
    }
  });
});

describe("health", () => {
  it("reports protocol and Worker version metadata without touching the Durable Object namespace", async () => {
    const workerVersion = {
      id: "00000000-0000-0000-0000-000000000002",
      tag: "0123456789abcdef",
      timestamp: "2026-07-21T12:34:56.000Z",
    };
    const env = {
      CF_VERSION_METADATA: workerVersion,
      get TUNNEL(): DurableObjectNamespace {
        throw new Error("health must not look up or wake a Durable Object");
      },
    } as TunnelRelayEnv;

    const response = await handleRequest(new Request("https://relay.test/health"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "ade-tunnel-relay",
      protocolVersion: 2,
      workerVersion,
    });
  });
});

describe("machine claim", () => {
  it("claims once, is idempotent for the same secret, conflicts on a different one", async () => {
    const durable = makeDo();
    const first = await durable.fetch(claimRequest(SECRET));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, claimed: true });

    const again = await durable.fetch(claimRequest(SECRET));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, claimed: false });

    const conflict = await durable.fetch(claimRequest("d".repeat(48)));
    expect(conflict.status).toBe(409);
  });

  it("rejects an out-of-range secret", async () => {
    const durable = makeDo();
    const short = await durable.fetch(claimRequest("too-short"));
    expect(short.status).toBe(400);
  });

  it("rejects a non-POST claim", async () => {
    const durable = makeDo();
    const res = await durable.fetch(new Request(`https://relay.test/machines/${MACHINE_KEY}/claim`, { method: "GET" }));
    expect(res.status).toBe(405);
  });
});

describe("signed upgrade auth rejections", () => {
  it("requires a websocket upgrade header", async () => {
    const durable = makeDo();
    await durable.fetch(claimRequest(SECRET));
    const res = await durable.fetch(new Request(`https://relay.test/host/${MACHINE_KEY}?ts=1&sig=abc`));
    expect(res.status).toBe(426);
  });

  it("rejects an unknown (unclaimed) machine", async () => {
    const durable = makeDo();
    const res = await durable.fetch(
      new Request(`https://relay.test/host/${MACHINE_KEY}?ts=1&sig=abc`, { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a /connect request that is not a websocket upgrade", async () => {
    const durable = makeDo();
    await durable.fetch(claimRequest(SECRET));
    const res = await durable.fetch(new Request(`https://relay.test/connect/${MACHINE_KEY}`));
    expect(res.status).toBe(426);
  });

  it("rejects a bad host signature after claim", async () => {
    const durable = makeDo();
    await durable.fetch(claimRequest(SECRET));
    const res = await durable.fetch(
      new Request(`https://relay.test/host/${MACHINE_KEY}?ts=${Math.floor(Date.now() / 1000)}&sig=deadbeef`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it.each(["legacy", "epoch"] as const)("accepts %s host and pipe HMAC bases", async (mode) => {
    const { durable, state, storage } = makeDoHarness();
    installAcceptSocketStub(durable, state);
    await storage.put("secret", SECRET);
    const ts = String(Math.floor(Date.now() / 1_000));
    const epoch = mode === "epoch" ? CONTROL_EPOCH : undefined;
    const hostBase = epoch
      ? buildHostSignatureBase(MACHINE_KEY, epoch, ts)
      : buildHostSignatureBase(MACHINE_KEY, ts);
    const hostSig = await hmacSha256Hex(SECRET, hostBase);
    const hostQuery = new URLSearchParams({ ts, sig: hostSig });
    if (epoch) hostQuery.set("epoch", epoch);
    const hostResponse = await durable.fetch(new Request(
      `https://relay.test/host/${MACHINE_KEY}?${hostQuery}`,
      { headers: { Upgrade: "websocket" } },
    ));
    expect(hostResponse.status).toBe(200);

    const controlEpoch = epoch ?? LEGACY_CONTROL_EPOCH;
    const id = "abcdef01";
    state.addSocket("client", id, Date.now(), { epoch: controlEpoch });
    const pipeResponse = await durable.fetch(await signedPipeRequest({ id, epoch }));
    expect(pipeResponse.status).toBe(200);
    expect(state.sockets.some((socket) => socket.tags.includes("pipe"))).toBe(true);
  });
});

describe("durable socket lifecycle", () => {
  it("closes an orphan pipe when the client disappears before ready", async () => {
    const { durable, state } = makeDoHarness();
    const id = "abcde123";
    const control = state.addSocket("control", undefined, Date.now(), { epoch: CONTROL_EPOCH });
    const client = state.addSocket("client", id, Date.now(), {
      epoch: CONTROL_EPOCH,
      readyVersion: RELAY_READY_VERSION,
    });
    const pipe = state.addSocket("pipe", id, Date.now(), { epoch: CONTROL_EPOCH });
    client.close(1006, "client vanished");

    await durable.webSocketMessage(control as unknown as WebSocket, JSON.stringify({
      t: "ready",
      id,
      epoch: CONTROL_EPOCH,
    }));

    expect(pipe.closes).toContainEqual({ code: CLOSE_BRIDGE_REJECTED, reason: "relay client unavailable" });
  });

  it("migrates a hibernated legacy control attachment without reporting host offline", async () => {
    const { durable, state, storage } = makeDoHarness();
    await storage.put("secret", SECRET);
    installAcceptSocketStub(durable, state);
    const control = state.addSocket("control", undefined, Date.now(), { omitEpoch: true });

    const response = await durable.fetch(new Request(
      `https://relay.test/connect/${MACHINE_KEY}?ready=2`,
      { headers: { Upgrade: "websocket" } },
    ));

    expect(response.status).toBe(200);
    expect(control.closes).toEqual([]);
    expect(control.deserializeAttachment()).toMatchObject({ role: "control", epoch: LEGACY_CONTROL_EPOCH });
    const open = JSON.parse(String(control.sent[0])) as { t: string; id: string };
    expect(control.sent).toEqual([JSON.stringify({ t: "open", id: open.id })]);
    const client = state.sockets.find((socket) => socket.tags.includes("client"))!;
    expect(client.sent).toEqual([JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION })]);

    const pipeResponse = await durable.fetch(await signedPipeRequest({ id: open.id }));
    expect(pipeResponse.status).toBe(200);
    expect(client.sent).toEqual([
      JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }),
      JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }),
    ]);
  });

  it.each([
    { controlEpoch: LEGACY_CONTROL_EPOCH, readyV2: false, name: "old/old" },
    { controlEpoch: LEGACY_CONTROL_EPOCH, readyV2: true, name: "old/new" },
    { controlEpoch: CONTROL_EPOCH, readyV2: false, name: "new/old" },
    { controlEpoch: CONTROL_EPOCH, readyV2: true, name: "new/new" },
  ])("establishes the $name control/client compatibility path", async ({ controlEpoch, readyV2 }) => {
    const { durable, state, storage } = makeDoHarness();
    await storage.put("secret", SECRET);
    installAcceptSocketStub(durable, state);
    const control = state.addSocket("control", undefined, Date.now(), { epoch: controlEpoch });
    await durable.fetch(new Request(
      `https://relay.test/connect/${MACHINE_KEY}${readyV2 ? "?ready=2" : ""}`,
      { headers: { Upgrade: "websocket" } },
    ));
    const open = JSON.parse(String(control.sent.at(-1))) as { id: string; epoch: string };
    const client = state.sockets.find((socket) => socket.tags.includes("client"))!;
    if (!readyV2) await durable.webSocketMessage(client as unknown as WebSocket, "ade-hello");

    await durable.fetch(await signedPipeRequest({
      id: open.id,
      ...(controlEpoch === LEGACY_CONTROL_EPOCH ? {} : { epoch: controlEpoch }),
    }));
    const pipe = state.sockets.find((socket) => socket.tags.includes("pipe"))!;
    if (controlEpoch !== LEGACY_CONTROL_EPOCH) {
      if (readyV2) {
        expect(client.sent).toEqual([JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION })]);
      } else {
        expect(pipe.sent).toEqual([]);
      }
      await durable.webSocketMessage(control as unknown as WebSocket, JSON.stringify({
        t: "ready",
        id: open.id,
        epoch: controlEpoch,
      }));
    }

    if (readyV2) {
      expect(client.sent).toEqual([
        JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }),
        JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }),
      ]);
    } else {
      expect(pipe.sent).toEqual(["ade-hello"]);
    }
    expect(client.deserializeAttachment()).toMatchObject({ established: true, epoch: controlEpoch });
    expect(pipe.deserializeAttachment()).toMatchObject({ established: true, epoch: controlEpoch });
  });

  // The Apple device stream speaks first: its bytes reach the pipe socket
  // while the brain's {t:"ready"} is still in flight on the control socket.
  async function openEpochPairWithEarlyPipe(readyV2: boolean, durable = makeDoHarness()) {
    const { durable: relay, state, storage } = durable;
    await storage.put("secret", SECRET);
    installAcceptSocketStub(relay, state);
    const control = state.addSocket("control", undefined, Date.now(), { epoch: CONTROL_EPOCH });
    return { relay, state, control, ...await openStreamPair(relay, state, control, readyV2) };
  }

  async function openStreamPair(relay: TunnelDurableObject, state: FakeState, control: FakeSocket, readyV2: boolean) {
    await relay.fetch(new Request(
      `https://relay.test/connect/${MACHINE_KEY}?kind=apple-stream&path=%2Fapple%2Fstream%2Ft${readyV2 ? "&ready=2" : ""}`,
      { headers: { Upgrade: "websocket" } },
    ));
    const open = JSON.parse(String(control.sent.at(-1))) as { id: string };
    await relay.fetch(await signedPipeRequest({ id: open.id, epoch: CONTROL_EPOCH }));
    const ofRole = (role: string) => state.sockets.find((socket) => (
      socket.tags.includes(role) && socket.tags.includes(`conn:${open.id}`)
    ))!;
    return { client: ofRole("client"), pipe: ofRole("pipe"), id: open.id };
  }

  it.each([false, true])("holds host bytes sent before ready and flushes them in order (ready-v2 client: %s)", async (readyV2) => {
    const { relay, control, client, pipe, id } = await openEpochPairWithEarlyPipe(readyV2);
    const config = new Uint8Array([1, 2, 3]).buffer;
    // A keyframe of full-screen noise at the 20 Mb/s cap measured 1.9 MB.
    const keyframe = new Uint8Array(2 * 1024 * 1024).buffer;

    await relay.webSocketMessage(pipe as unknown as WebSocket, config);
    await relay.webSocketMessage(pipe as unknown as WebSocket, '{"t":"stats"}');
    await relay.webSocketMessage(pipe as unknown as WebSocket, keyframe);
    expect(pipe.closes).toEqual([]);
    expect(client.closes).toEqual([]);
    const accepted = readyV2 ? [JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION })] : [];
    expect(client.sent).toEqual(accepted);

    await relay.webSocketMessage(control as unknown as WebSocket, JSON.stringify({ t: "ready", id, epoch: CONTROL_EPOCH }));
    const ready = readyV2 ? [JSON.stringify({ t: "ready", v: RELAY_READY_VERSION })] : [];
    expect(client.sent).toEqual([...accepted, ...ready, config, '{"t":"stats"}', keyframe]);

    const delta = new Uint8Array([9]).buffer;
    await relay.webSocketMessage(pipe as unknown as WebSocket, delta);
    expect(client.sent.at(-1)).toBe(delta);
    expect(pipe.deserializeAttachment()).toMatchObject({ established: true });
    expect(pipe.deserializeAttachment()).not.toHaveProperty("pipeBuffered");
  });

  it.each([
    { name: "overflows the pre-ready buffer", code: CLOSE_PRE_PIPE_BUFFER_OVERFLOW, reconstruct: false },
    { name: "lost its pre-ready buffer to a reconstructed instance", code: CLOSE_FORWARD_FAILED, reconstruct: true },
  ])("closes the pair, never forwarding a gap, when the pipe $name", async ({ code, reconstruct }) => {
    const harness = makeDoHarness();
    const { relay, state, control, client, pipe, id } = await openEpochPairWithEarlyPipe(true, harness);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await relay.webSocketMessage(pipe as unknown as WebSocket, new ArrayBuffer(3 * 1024 * 1024));
    const next = reconstruct
      ? new TunnelDurableObject(state as unknown as DurableObjectState, {} as TunnelRelayEnv)
      : relay;
    if (reconstruct) {
      await next.webSocketMessage(control as unknown as WebSocket, JSON.stringify({ t: "ready", id, epoch: CONTROL_EPOCH }));
    } else {
      await next.webSocketMessage(pipe as unknown as WebSocket, new ArrayBuffer(2 * 1024 * 1024));
    }
    log.mockRestore();

    expect(client.closes).toEqual([{ code, reason: expect.stringContaining("pre-ready pipe buffer") }]);
    expect(pipe.closes).toEqual([{ code, reason: expect.stringContaining("pre-ready pipe buffer") }]);
    expect(client.sent).toEqual([JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION })]);
    expect(client.deserializeAttachment()).not.toMatchObject({ established: true });
  });

  it("bounds pre-ready pipe bytes across every tunnel of the object, and frees them once a pair is ready", async () => {
    const harness = makeDoHarness();
    const { relay, state, control, client, pipe, id } = await openEpochPairWithEarlyPipe(false, harness);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const burst = () => new ArrayBuffer(3 * 1024 * 1024);
    await relay.webSocketMessage(pipe as unknown as WebSocket, burst());
    const others = [];
    for (let i = 0; i < 4; i += 1) {
      const pair = await openStreamPair(relay, state, control, false);
      await relay.webSocketMessage(pair.pipe as unknown as WebSocket, burst());
      others.push(pair);
    }
    expect([pipe, ...others.map((pair) => pair.pipe)].flatMap((socket) => socket.closes)).toEqual([]);

    // 15 MiB held: one more 3 MiB burst would pass the object's total.
    const over = await openStreamPair(relay, state, control, false);
    await relay.webSocketMessage(over.pipe as unknown as WebSocket, burst());
    expect(over.client.closes).toEqual([{ code: CLOSE_PRE_PIPE_BUFFER_OVERFLOW, reason: "pre-ready pipe buffer overflow" }]);
    expect(over.pipe.closes).toEqual([{ code: CLOSE_PRE_PIPE_BUFFER_OVERFLOW, reason: "pre-ready pipe buffer overflow" }]);

    // A ready pair hands its bytes to the client and gives its share back.
    await relay.webSocketMessage(control as unknown as WebSocket, JSON.stringify({ t: "ready", id, epoch: CONTROL_EPOCH }));
    expect(client.sent).toHaveLength(1);
    const after = await openStreamPair(relay, state, control, false);
    await relay.webSocketMessage(after.pipe as unknown as WebSocket, burst());
    log.mockRestore();
    expect(after.pipe.closes).toEqual([]);
  });

  it.each([
    { name: "lost in-memory marker data", options: { epoch: LEGACY_CONTROL_EPOCH, legacyBuffered: true } },
    { name: "pre-deploy unknown attachment", options: { omitEpoch: true } },
  ])("closes a legacy pair when $name cannot be proven after hibernation", async ({ options }) => {
    const { state, storage } = makeDoHarness();
    await storage.put("secret", SECRET);
    state.addSocket("control", undefined, Date.now(), { epoch: LEGACY_CONTROL_EPOCH });
    const client = state.addSocket("client", "abcdef01", Date.now(), options);
    const reconstructed = new TunnelDurableObject(
      state as unknown as DurableObjectState,
      {} as TunnelRelayEnv,
    );
    installAcceptSocketStub(reconstructed, state);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await reconstructed.fetch(await signedPipeRequest({ id: "abcdef01" }));

    const pipe = state.sockets.find((socket) => socket.tags.includes("pipe"))!;
    expect(client.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: expect.stringContaining("legacy"),
    }]);
    expect(pipe.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: expect.stringContaining("legacy"),
    }]);
    expect(client.sent).toEqual([]);
    expect(client.deserializeAttachment()).not.toMatchObject({ established: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"kind":"forward_failed"'));
    log.mockRestore();
  });

  it("propagates a safe client correlation id to pipe lifecycle logs", async () => {
    const { durable, state, storage } = makeDoHarness();
    await storage.put("secret", SECRET);
    installAcceptSocketStub(durable, state);
    const controlEpoch = CONTROL_EPOCH;
    const correlationId = "123e4567-e89b-42d3-a456-426614174000";
    const control = state.addSocket("control", undefined, Date.now(), {
      epoch: controlEpoch,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await durable.fetch(new Request(
      `https://relay.test/connect/${MACHINE_KEY}?ready=2&cid=${correlationId}`,
      { headers: { Upgrade: "websocket" } },
    ));
    const open = JSON.parse(String(control.sent.at(-1))) as {
      id: string;
      epoch: string;
    };
    const client = state.sockets.find((socket) => socket.tags.includes("client"))!;
    expect(client.deserializeAttachment()).toMatchObject({ correlationId });

    await durable.fetch(await signedPipeRequest({
      id: open.id,
      epoch: controlEpoch,
    }));
    const pipe = state.sockets.find((socket) => socket.tags.includes("pipe"))!;
    expect(pipe.deserializeAttachment()).toMatchObject({ correlationId });

    await durable.webSocketClose(
      client as unknown as WebSocket,
      1006,
      "abnormal close",
      false,
    );
    const terminalLog = log.mock.calls
      .flatMap(([entry]) => [String(entry)])
      .find((entry) => entry.includes('"kind":"socket_closed"'));
    expect(terminalLog).toContain(`"correlationId":"${correlationId}"`);
    expect(terminalLog).not.toContain("ready=2");
    expect(terminalLog).not.toContain(MACHINE_KEY);
    log.mockRestore();
  });

  it("migrates a proven pre-deploy client/pipe pair after hibernation", async () => {
    const { state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01", Date.now(), { omitEpoch: true });
    const pipe = state.addSocket("pipe", "abcdef01", Date.now(), { omitEpoch: true });
    const reconstructed = new TunnelDurableObject(
      state as unknown as DurableObjectState,
      {} as TunnelRelayEnv,
    );

    await reconstructed.webSocketMessage(client as unknown as WebSocket, "hello");

    expect(pipe.sent).toEqual(["hello"]);
    expect(client.closes).toEqual([]);
    expect(pipe.closes).toEqual([]);
    expect(client.deserializeAttachment()).toMatchObject({
      epoch: LEGACY_CONTROL_EPOCH,
      established: true,
    });
    expect(pipe.deserializeAttachment()).toMatchObject({
      epoch: LEGACY_CONTROL_EPOCH,
      established: true,
    });
  });

  it("maps brain rejects to the waiting client and keeps unknown control types ignored", async () => {
    const { durable, state } = makeDoHarness();
    const control = state.addSocket("control");
    const client = state.addSocket("client", "abcdef01");

    await durable.webSocketMessage(
      control as unknown as WebSocket,
      JSON.stringify({
        t: "reject",
        id: "abcdef01",
        epoch: CONTROL_EPOCH,
        code: 4555,
        reason: `bridge\u0000 refused ${"é".repeat(100)}`,
      }),
    );
    expect(client.closes).toHaveLength(1);
    expect(client.closes[0]?.code).toBe(4555);
    expect(client.closes[0]?.reason).not.toContain("\u0000");
    expect(Buffer.byteLength(client.closes[0]?.reason ?? "", "utf8")).toBeLessThanOrEqual(123);

    const secondClient = state.addSocket("client", "abcdef02");
    await durable.webSocketMessage(
      control as unknown as WebSocket,
      JSON.stringify({ t: "reject", id: "abcdef02", epoch: CONTROL_EPOCH, code: 1006, reason: "bad code" }),
    );
    expect(secondClient.closes).toEqual([{ code: CLOSE_BRIDGE_REJECTED, reason: "bad code" }]);

    await durable.webSocketMessage(control as unknown as WebSocket, JSON.stringify({ t: "future-type" }));
    expect(control.sent).toEqual([]);
    expect(secondClient.closes).toHaveLength(1);
  });

  it("preserves application close details across a pair and falls back to 4000 otherwise", async () => {
    const first = makeDoHarness();
    const client = first.state.addSocket("client", "abcdef01");
    const pipe = first.state.addSocket("pipe", "abcdef01");
    await first.durable.webSocketClose(
      client as unknown as WebSocket,
      4666,
      "phone\tclosed",
      true,
    );
    expect(client.closes).toEqual([]);
    expect(pipe.closes).toEqual([{ code: 4666, reason: "phone closed" }]);

    const second = makeDoHarness();
    const normalClient = second.state.addSocket("client", "abcdef02");
    const normalPipe = second.state.addSocket("pipe", "abcdef02");
    await second.durable.webSocketClose(normalClient as unknown as WebSocket, 1000, "", true);
    expect(normalPipe.closes).toEqual([{ code: CLOSE_PARTNER_CLOSED, reason: "partner closed" }]);
  });

  it("logs a host pipe 4003 without peer text while preserving the close for its partner", async () => {
    const { durable, state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01", Date.now(), { established: true });
    const pipe = state.addSocket("pipe", "abcdef01", Date.now(), { established: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await durable.webSocketClose(pipe as unknown as WebSocket, 4003, "private network detail", true);

    expect(client.closes).toEqual([{ code: 4003, reason: "private network detail" }]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(
      /"kind":"socket_closed".*"role":"pipe".*"epochMode":"epoch".*"code":4003.*"established":true/,
    ));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("private network detail"));
    log.mockRestore();
  });

  it("closes an early client when its buffered frames exceed 256 KiB", async () => {
    const { durable, state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01");

    await durable.webSocketMessage(client as unknown as WebSocket, new ArrayBuffer(128 * 1024));
    expect(client.closes).toEqual([]);
    await durable.webSocketMessage(client as unknown as WebSocket, new ArrayBuffer(128 * 1024));
    expect(client.closes).toEqual([]);
    await durable.webSocketMessage(client as unknown as WebSocket, new ArrayBuffer(1));
    expect(client.closes).toEqual([{
      code: CLOSE_PRE_PIPE_BUFFER_OVERFLOW,
      reason: "pre-pipe buffer overflow",
    }]);
  });

  it("closes both established peers with a recoverable code when forwarding throws", async () => {
    const { durable, state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01", Date.now(), { established: true });
    const pipe = state.addSocket("pipe", "abcdef01", Date.now(), { established: true });
    pipe.throwOnSend = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await durable.webSocketMessage(client as unknown as WebSocket, "hello");

    expect(client.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: "relay forwarding failed",
    }]);
    expect(pipe.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: "relay forwarding failed",
    }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"kind":"forward_failed"'));
    log.mockRestore();
  });

  it("closes only unestablished clients when their host control socket is lost", async () => {
    const { durable, state } = makeDoHarness();
    const control = state.addSocket("control");
    const pending = state.addSocket("client", "abcdef01");
    const established = state.addSocket("client", "abcdef02", Date.now(), { established: true });
    state.addSocket("pipe", "abcdef02", Date.now(), { established: true });

    await durable.webSocketClose(control as unknown as WebSocket, 1006, "", false);

    expect(pending.closes).toEqual([{ code: CLOSE_HOST_OFFLINE, reason: "host offline" }]);
    expect(established.closes).toEqual([]);
  });

  it("reschedules alarms for data sockets but not for an idle control socket", async () => {
    const { durable, state, storage } = makeDoHarness();
    state.addSocket("control");
    await durable.alarm();
    expect(storage.setAlarmCalls).toBe(0);
    expect(await storage.getAlarm()).toBeNull();

    state.addSocket("client", "abcdef01");
    await durable.alarm();
    expect(storage.setAlarmCalls).toBe(1);
    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("closes the new client immediately when signaling the control socket throws", async () => {
    const { durable, state, storage } = makeDoHarness();
    const control = state.addSocket("control");
    control.throwOnSend = true;
    const testDurable = durable as unknown as {
      acceptSocket: (attachment: { role: TestSocketRole; id?: string; epoch: string }) => Promise<Response>;
    };
    testDurable.acceptSocket = async (attachment) => {
      state.addSocket(attachment.role, attachment.id, Date.now(), { epoch: attachment.epoch });
      return new Response(null, { status: 200 });
    };

    const response = await durable.fetch(new Request(`https://relay.test/connect/${MACHINE_KEY}`, {
      headers: { Upgrade: "websocket" },
    }));
    const client = state.sockets.find((socket) => socket.tags.includes("client"));
    expect(response.status).toBe(200);
    expect(client?.closes).toEqual([{ code: CLOSE_HOST_OFFLINE, reason: "host offline" }]);
    expect(storage.setAlarmCalls).toBe(0);
  });
});
