// Slow-network TCP pass-through proxy for perf runs. No admin rights, no system network changes:
// it listens on a local port and forwards every connection to one target, shaping both directions.
//
//   node scripts/perf/net/slow-proxy.mjs --profile 3g --listen 127.0.0.1:0 --target 127.0.0.1:8788
//   (prints one JSON line {"listening":"127.0.0.1:<port>",...}; send SIGINT for the byte totals)
//
// Programmatic: `import { startSlowProxy, NETWORK_PROFILES } from "./slow-proxy.mjs"`.
//
// Shaping model, per connection and per direction (a "link"):
//   - bandwidth: bytes leave the link no faster than `kbps` (serialization delay, FIFO per direction);
//   - latency: each byte arrives `rttMs / 2` after it left (so a request + reply costs one full RTT);
//   - connection setup: the upstream connect is held for one RTT, which is what a TCP handshake costs
//     before the first byte can flow (TLS would add more; ADE's LAN/tailnet sync is plain ws).
// Not modelled: packet loss, TCP slow start, a bandwidth pool shared across connections (each
// connection gets the full rate, like separate flows on an uncongested link).
//
// Profiles: 3g = slow 3G (400 kbps each way, 400 ms RTT); lte = 10 Mbps / 60 ms;
// lan = no shaping (still counts bytes). Override with --kbps / --rtt.
import net from "node:net";
import { pathToFileURL } from "node:url";

export const NETWORK_PROFILES = Object.freeze({
  "3g": { name: "3g", kbps: 400, rttMs: 400 },
  lte: { name: "lte", kbps: 10_000, rttMs: 60 },
  lan: { name: "lan", kbps: 0, rttMs: 0 },
  // A laptop away from home reaching a desktop at home over a direct tailnet path: about 30 ms RTT
  // (a measured median, 2026-10-26). Bandwidth was not measured; 50 Mbps stands in for a home uplink.
  wan30: { name: "wan30", kbps: 50_000, rttMs: 30 },
  // Two machines on one home LAN over a tailnet: about 7 ms RTT.
  lan7: { name: "lan7", kbps: 0, rttMs: 7 },
});

/** Largest piece scheduled as one unit, so a big write is paced instead of landing at once. */
const SLICE_BYTES = 8 * 1024;

function createLink({ kbps, rttMs }, deliver, onBytes) {
  const bytesPerMs = kbps > 0 ? (kbps * 1000) / 8 / 1000 : 0;
  const oneWayMs = Math.max(0, rttMs / 2);
  let busyUntil = 0;
  let pending = 0;
  let closed = false;
  let onDrained = null;
  const queue = [];
  let timer = null;

  const pump = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].at <= now + 0.5) {
      const item = queue.shift();
      pending -= 1;
      if (!closed) deliver(item.chunk);
    }
    if (queue.length) {
      timer = setTimeout(pump, Math.max(0, queue[0].at - performance.now()));
    } else if (onDrained) {
      const done = onDrained;
      onDrained = null;
      done();
    }
  };

  return {
    push(chunk) {
      onBytes(chunk.byteLength);
      if (!bytesPerMs && !oneWayMs) {
        deliver(chunk);
        return;
      }
      for (let offset = 0; offset < chunk.byteLength; offset += SLICE_BYTES) {
        const slice = chunk.subarray(offset, Math.min(chunk.byteLength, offset + SLICE_BYTES));
        const now = performance.now();
        const start = Math.max(now, busyUntil);
        const leaves = bytesPerMs ? start + slice.byteLength / bytesPerMs : start;
        busyUntil = leaves;
        queue.push({ chunk: slice, at: leaves + oneWayMs });
        pending += 1;
      }
      if (!timer) timer = setTimeout(pump, Math.max(0, queue[0].at - performance.now()));
    },
    /** Calls `done` once every queued byte has been delivered (immediately when idle). */
    drain(done) {
      if (!pending) done();
      else onDrained = done;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      queue.length = 0;
    },
  };
}

/**
 * Start a proxy. Resolves to { port, host, stats(), resetStats(), dropAll(), close() }.
 * `stats()` returns { connections, open, upBytes, downBytes } where up = client → target.
 */
export async function startSlowProxy({ listenHost = "127.0.0.1", listenPort = 0, targetHost = "127.0.0.1", targetPort, profile = "lan", kbps, rttMs } = {}) {
  if (!targetPort) throw new Error("startSlowProxy: targetPort is required");
  const base = typeof profile === "string" ? NETWORK_PROFILES[profile] : profile;
  if (!base) throw new Error(`Unknown network profile ${profile}; use ${Object.keys(NETWORK_PROFILES).join(", ")}`);
  const shape = { name: base.name ?? "custom", kbps: kbps ?? base.kbps, rttMs: rttMs ?? base.rttMs };
  const totals = { connections: 0, upBytes: 0, downBytes: 0 };
  const live = new Set();

  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    totals.connections += 1;
    const pair = { client, upstream: null };
    live.add(pair);
    client.setNoDelay(true);
    const upLink = createLink(shape, (chunk) => pair.upstream?.write(chunk), (n) => { totals.upBytes += n; });
    const downLink = createLink(shape, (chunk) => client.write(chunk), (n) => { totals.downBytes += n; });
    let ended = false;
    const teardown = () => {
      if (ended) return;
      ended = true;
      live.delete(pair);
      upLink.close();
      downLink.close();
      client.destroy();
      pair.upstream?.destroy();
    };
    // Bytes the client sends before the upstream is up are queued through the link as usual.
    client.on("data", (chunk) => upLink.push(chunk));
    client.on("end", () => upLink.drain(() => pair.upstream?.end()));
    client.on("error", teardown);
    client.on("close", () => upLink.drain(teardown));
    setTimeout(() => {
      if (ended) return;
      const upstream = net.connect({ host: targetHost, port: targetPort });
      pair.upstream = upstream;
      upstream.setNoDelay(true);
      upstream.on("connect", () => client.resume());
      upstream.on("data", (chunk) => downLink.push(chunk));
      upstream.on("end", () => downLink.drain(() => client.end()));
      upstream.on("error", teardown);
      upstream.on("close", () => downLink.drain(teardown));
    }, shape.rttMs);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, resolve);
  });
  const address = server.address();
  return {
    host: listenHost,
    port: address.port,
    profile: shape,
    stats: () => ({ ...totals, open: live.size }),
    resetStats: () => { totals.connections = 0; totals.upBytes = 0; totals.downBytes = 0; },
    /** Cut every open connection at once, as a dropped link does. */
    dropAll: () => { for (const pair of [...live]) { pair.client.destroy(); pair.upstream?.destroy(); live.delete(pair); } },
    close: () => new Promise((resolve) => {
      for (const pair of [...live]) { pair.client.destroy(); pair.upstream?.destroy(); }
      live.clear();
      server.close(() => resolve());
    }),
  };
}

function parseHostPort(value, fallbackHost) {
  const text = String(value ?? "");
  const index = text.lastIndexOf(":");
  if (index < 0) return { host: fallbackHost, port: Number(text) };
  return { host: text.slice(0, index) || fallbackHost, port: Number(text.slice(index + 1)) };
}

async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--profile") { opts.profile = value; i += 1; }
    else if (key === "--listen") { opts.listen = value; i += 1; }
    else if (key === "--target") { opts.target = value; i += 1; }
    else if (key === "--kbps") { opts.kbps = Number(value); i += 1; }
    else if (key === "--rtt") { opts.rttMs = Number(value); i += 1; }
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!opts.target) throw new Error("--target host:port is required");
  const listen = parseHostPort(opts.listen ?? "127.0.0.1:0", "127.0.0.1");
  const target = parseHostPort(opts.target, "127.0.0.1");
  if (listen.port === 8787) throw new Error("Refusing to listen on 8787: that port belongs to the machine's ADE brain.");
  const proxy = await startSlowProxy({
    listenHost: listen.host,
    listenPort: listen.port,
    targetHost: target.host,
    targetPort: target.port,
    profile: opts.profile ?? "lan",
    kbps: opts.kbps,
    rttMs: opts.rttMs,
  });
  console.log(JSON.stringify({ listening: `${proxy.host}:${proxy.port}`, target: `${target.host}:${target.port}`, profile: proxy.profile }));
  const finish = async () => {
    console.log(JSON.stringify({ totals: proxy.stats() }));
    await proxy.close();
    process.exit(0);
  };
  // SIGUSR2 prints the running totals without stopping (a rig reads bytes per scenario this way).
  process.on("SIGUSR2", () => console.log(JSON.stringify({ at: Date.now(), totals: proxy.stats() })));
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
