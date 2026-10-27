// cd apps/ade-cli && npx tsx ../../scripts/perf/net/desktop-remote.bench.mts <command> [options]
//
// A headless "desktop connected to another machine's brain", through the slow-network proxy. It runs
// the desktop's own paired-runtime code (openSyncRuntimeTransport + RuntimeRpcClient from
// apps/desktop/src/main/services/remoteRuntime): the same hello, the same permessage-deflate socket,
// the same JSON-RPC over sync `rpc` envelopes. It does not run the renderer, so "project usable" is
// the first reads a Work tab makes (lanes, sessions, chats), not a painted window.
//
// Commands:
//   pair --target host:port --pin 123456 --state <file>   PIN-pair as a desktop (direct PIN pairing
//                                                          grants runtime RPC); writes credentials
//   run  --target host:port --state <file> --project <registry id> --chat <session id>
//        [--profiles 3g,lte,lan] [--runs 3] [--json <out.jsonl>] [--pipelined]
//        --pipelined sends projects.list right behind ade/initialize, as pairedRuntimeBootstrap does now
//
// Steps timed from the moment the socket starts to open:
//   connected     transport up (socket + hello_ok), ade/initialize and projects.list answered
//                 (what bootstrapPairedRuntime does before the desktop shows the machine as connected)
//   projectUsable lane.list, session.list and chat.listSessions for the project, in parallel
//   chatOpen      chat.getChatEventHistory for the big chat (maxEvents 1000, maxBytes 256 KiB, the
//                 chat pane's first read)
// Then the link drops (every proxied connection cut at once) and `reconnect` times a fresh
// bootstrap + one lane.list. The desktop's automatic reconnect also waits its backoff first
// (remoteConnectionService); that wait is policy, reported in the docs, not timed here.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openSyncRuntimeTransport } from "../../../apps/desktop/src/main/services/remoteRuntime/syncRuntimeTransport";
import { RuntimeRpcClient } from "../../../apps/desktop/src/main/services/remoteRuntime/runtimeRpcClient";
import { DESKTOP_CLIENT_NAMES } from "../../../apps/desktop/src/shared/runtimeClientNames";
import type { DesktopPairedMachineCredentials } from "../../../apps/desktop/src/shared/types/pairedRuntime";
import { encodeSyncEnvelope, parseSyncEnvelopeFrame } from "../../../apps/ade-cli/src/services/sync/syncProtocol";
// @ts-expect-error plain ESM helper without types
import { startSlowProxy, NETWORK_PROFILES } from "./slow-proxy.mjs";

const WebSocket = createRequire(path.resolve(import.meta.dirname, "../../../apps/ade-cli/package.json"))("ws") as typeof import("ws").default;

const argv = process.argv.slice(2);
const command = argv[0] ?? "run";
const read = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
};
const targetText = read("--target");
if (!targetText) throw new Error("--target host:port is required");
const target = { host: targetText.slice(0, targetText.lastIndexOf(":")) || "127.0.0.1", port: Number(targetText.slice(targetText.lastIndexOf(":") + 1)) };
if (target.port === 8787) throw new Error("Refusing to measure 8787: that is the machine brain.");
const statePath = read("--state") ?? path.join(os.tmpdir(), "ade-desktop-remote-state.json");
const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
};

async function pair(): Promise<void> {
  const pin = read("--pin");
  if (!pin) throw new Error("--pin is required");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dpopPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const dpopPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64");
  const deviceId = `perf-desktop-${randomUUID()}`;
  const siteId = randomUUID().replace(/-/g, "");
  const ws = new WebSocket(`ws://${target.host}:${target.port}/`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const result = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pairing timed out")), 20_000);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      const parsed = parseSyncEnvelopeFrame(isBinary ? data : data.toString("utf8"));
      if (parsed.type === "pairing_result") { clearTimeout(timer); resolve(parsed.payload); }
    });
    ws.send(encodeSyncEnvelope({
      type: "pairing_request",
      requestId: "pair",
      payload: {
        code: pin,
        peer: { deviceId, deviceName: "ADE perf desktop", platform: "macOS", deviceType: "desktop", siteId, dbVersion: 0 },
        dpopPublicKey,
      },
      compressionCodec: "none",
    }));
  });
  ws.close();
  if (!result?.ok || !result.secret) throw new Error(`pairing failed: ${JSON.stringify(result)}`);
  // The host's identity comes from its hello_ok; read it with the new secret.
  const now = new Date().toISOString();
  const credentials: DesktopPairedMachineCredentials = {
    version: 1,
    hostIdentity: { deviceId: "", siteId: "", name: "", platform: "macOS", deviceType: "desktop" },
    deviceId: result.deviceId ?? deviceId,
    siteId,
    deviceName: "ADE perf desktop",
    secret: result.secret,
    dpopPrivateKey,
    dpopPublicKey,
    endpoints: [`ws://${target.host}:${target.port}`],
    createdAt: now,
    updatedAt: now,
  };
  const probe = new WebSocket(`ws://${target.host}:${target.port}/`);
  await new Promise<void>((resolve, reject) => { probe.once("open", () => resolve()); probe.once("error", reject); });
  const { buildDesktopPairedHello } = await import("../../../apps/desktop/src/main/services/remoteRuntime/syncRuntimeTransport");
  const hello = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hello timed out")), 20_000);
    probe.on("message", (data: Buffer, isBinary: boolean) => {
      const parsed = parseSyncEnvelopeFrame(isBinary ? data : data.toString("utf8"));
      if (parsed.type === "hello_ok" || parsed.type === "hello_error") { clearTimeout(timer); resolve(parsed); }
    });
    probe.send(encodeSyncEnvelope({ type: "hello", requestId: "hello", payload: buildDesktopPairedHello(credentials), compressionCodec: "none" }));
  });
  probe.close();
  if (hello.type !== "hello_ok") throw new Error(`paired hello failed: ${JSON.stringify(hello.payload).slice(0, 300)}`);
  const brain = hello.payload.brain;
  credentials.hostIdentity = { deviceId: brain.deviceId, siteId: brain.siteId, name: brain.deviceName, platform: brain.platform, deviceType: brain.deviceType };
  fs.writeFileSync(statePath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ paired: true, deviceId: credentials.deviceId, rpcChannel: hello.payload.features?.rpcChannel === true }));
}

type Timed = { scenario: "connect" | "reconnect"; profile: string; run: number; ms: Record<string, number>; proxy: { connections: number; upBytes: number; downBytes: number }; calls: number };

// Where a bootstrap spends its time: transport (socket + hello_ok), then the RPC calls.
const bootstrapSplits: Array<{ transport: number; rpc: number }> = [];

async function bootstrap(credentials: DesktopPairedMachineCredentials, endpoint: string) {
  const started = performance.now();
  const transport = await openSyncRuntimeTransport({ credentials, endpoint, appVersion: "perf" });
  const transportMs = performance.now() - started;
  const client = new RuntimeRpcClient(transport);
  const note = () => bootstrapSplits.push({ transport: Math.round(transportMs), rpc: Math.round(performance.now() - started - transportMs) });
  if (argv.includes("--pipelined")) {
    // pairedRuntimeBootstrap since P1: projects.list goes out right behind initialize.
    const initializing = client.initialize(DESKTOP_CLIENT_NAMES.remote, "perf");
    const projects = client.call("projects.list", {});
    projects.catch(() => {});
    await initializing;
    await projects;
    note();
    return client;
  }
  await client.initialize(DESKTOP_CLIENT_NAMES.remote, "perf");
  await client.call("projects.list", {});
  note();
  return client;
}

function action(client: RuntimeRpcClient, projectId: string, domain: string, name: string, args: Record<string, unknown>) {
  return client.call("ade/actions/call", {
    projectId,
    name: "run_ade_action",
    arguments: { domain, action: name, args },
  });
}

async function runOnce(credentials: DesktopPairedMachineCredentials, profile: string, run: number, projectId: string, chatId: string): Promise<Timed[]> {
  const proxy = await startSlowProxy({ targetHost: target.host, targetPort: target.port, profile });
  const endpoint = `ws://127.0.0.1:${proxy.port}`;
  const out: Timed[] = [];
  let client: RuntimeRpcClient | null = null;
  try {
    const t0 = performance.now();
    client = await bootstrap(credentials, endpoint);
    const connected = performance.now() - t0;
    const sized = async (label: string, promise: Promise<unknown>) => {
      const result = await promise;
      // DESKTOP_REMOTE_SIZES=1: each read's decoded reply size and when it landed.
      if (process.env.DESKTOP_REMOTE_SIZES === "1") {
        process.stderr.write(`[desktop] ${label} ${Math.round(JSON.stringify(result ?? null).length / 1024)} KB decoded at ${Math.round(performance.now() - t0)} ms\n`);
      }
      return result;
    };
    await Promise.all([
      sized("lane.list", action(client, projectId, "lane", "list", { includeArchived: false, includeStatus: true })),
      sized("session.list", action(client, projectId, "session", "list", { limit: 200 })),
      sized("chat.listSessions", action(client, projectId, "chat", "listSessions", {})),
    ]);
    const projectUsable = performance.now() - t0;
    await sized("chat.getChatEventHistory", action(client, projectId, "chat", "getChatEventHistory", { sessionId: chatId, maxEvents: 1000, maxBytes: 256 * 1024 }));
    const chatOpen = performance.now() - t0;
    const split = bootstrapSplits.at(-1)!;
    out.push({ scenario: "connect", profile, run, ms: { connected: Math.round(connected), transport: split.transport, bootstrapRpc: split.rpc, projectUsable: Math.round(projectUsable), chatOpen: Math.round(chatOpen) }, proxy: proxy.stats(), calls: 7 });

    // Drop the link, then time the fresh bootstrap a reconnect does.
    proxy.dropAll();
    client.close();
    client = null;
    proxy.resetStats();
    const t1 = performance.now();
    client = await bootstrap(credentials, endpoint);
    const reconnected = performance.now() - t1;
    await action(client, projectId, "lane", "list", { includeArchived: false, includeStatus: true });
    const firstRead = performance.now() - t1;
    const resplit = bootstrapSplits.at(-1)!;
    out.push({ scenario: "reconnect", profile, run, ms: { connected: Math.round(reconnected), transport: resplit.transport, bootstrapRpc: resplit.rpc, firstRead: Math.round(firstRead) }, proxy: proxy.stats(), calls: 3 });
  } finally {
    client?.close();
    await proxy.close();
  }
  return out;
}

if (command === "pair") {
  await pair();
} else {
  const credentials = JSON.parse(fs.readFileSync(statePath, "utf8")) as DesktopPairedMachineCredentials;
  const projectId = read("--project");
  const chatId = read("--chat");
  if (!projectId || !chatId) throw new Error("--project and --chat are required");
  const profiles = (read("--profiles") ?? "3g,lte,lan").split(",").filter(Boolean);
  for (const profile of profiles) if (!NETWORK_PROFILES[profile]) throw new Error(`Unknown profile ${profile}`);
  const runs = Number(read("--runs") ?? 3);
  const json = read("--json");
  const results: Timed[] = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const profile of profiles) {
      for (const row of await runOnce(credentials, profile, run, projectId, chatId)) {
        console.log(JSON.stringify(row));
        results.push(row);
        if (json) fs.appendFileSync(json, `${JSON.stringify(row)}\n`);
      }
    }
  }
  const groups = new Map<string, Timed[]>();
  for (const row of results) groups.set(`${row.scenario} ${row.profile}`, [...(groups.get(`${row.scenario} ${row.profile}`) ?? []), row]);
  for (const [key, rows] of groups) {
    const steps = Object.keys(rows[0]!.ms);
    console.log(JSON.stringify({
      summary: key,
      runs: rows.length,
      ms: Object.fromEntries(steps.map((step) => [step, median(rows.map((row) => row.ms[step]!))])),
      downKB: +((median(rows.map((row) => row.proxy.downBytes)) ?? 0) / 1024).toFixed(1),
      upKB: +((median(rows.map((row) => row.proxy.upBytes)) ?? 0) / 1024).toFixed(1),
      connections: median(rows.map((row) => row.proxy.connections)),
    }));
  }
}
process.exit(0);
