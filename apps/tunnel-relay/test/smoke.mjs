// End-to-end smoke test for the tunnel relay.
//
//   npm run dev            # terminal 1: wrangler dev (127.0.0.1:8787)
//   node test/smoke.mjs    # terminal 2
//
// Drives the full path: claim → host control socket → phone /connect → the DO
// signals {t:"open",id} → we open a pipe socket + a local echo socket and pipe
// them → the phone gets its frame echoed back. Uses the `ws` package (present
// via wrangler's deps) for the server + sockets.
import { WebSocket, WebSocketServer } from "ws";
import { createHmac, randomBytes } from "node:crypto";

const BASE = (process.env.ADE_TUNNEL_RELAY_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const KEY = randomBytes(16).toString("hex");
const SECRET = randomBytes(24).toString("hex");

const sign = (base) => createHmac("sha256", SECRET).update(base).digest("hex");
const ts = () => String(Math.floor(Date.now() / 1000));
const fail = (msg) => {
  console.error("SMOKE FAIL:", msg);
  process.exit(1);
};

// A stand-in for the brain's local sync server: echoes every frame.
const echo = new WebSocketServer({ port: 0 });
echo.on("connection", (socket) => socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary })));
await new Promise((resolve) => echo.on("listening", resolve));
const echoPort = echo.address().port;

// 1. Claim the machine.
const claim = await fetch(`${BASE}/machines/${KEY}/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret: SECRET }),
});
if (!claim.ok) fail(`claim ${claim.status}`);

// 2. Host control socket: on {t:"open",id} wire a pipe socket to a local echo socket.
const controlTs = ts();
const control = new WebSocket(`${WS_BASE}/host/${KEY}?ts=${controlTs}&sig=${sign(`host:${KEY}:${controlTs}`)}`);
control.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.t !== "open") return;
  const pipeTs = ts();
  const pipe = new WebSocket(
    `${WS_BASE}/host/${KEY}/pipe/${msg.id}?ts=${pipeTs}&sig=${sign(`pipe:${KEY}:${msg.id}:${pipeTs}`)}`,
  );
  const local = new WebSocket(`ws://127.0.0.1:${echoPort}`);
  const closeBoth = () => { try { pipe.close(); } catch {} try { local.close(); } catch {} };
  // Buffer frames until the target socket opens — the relay flushes the
  // phone's buffered hello the instant the pipe attaches, usually before the
  // local echo socket is OPEN (same rule as the real tunnel client).
  const buffered = { pipe: [], local: [] };
  const send = (target, key, d, b) => {
    if (target.readyState === WebSocket.OPEN) target.send(d, { binary: b });
    else if (target.readyState === WebSocket.CONNECTING) buffered[key].push([d, b]);
  };
  local.on("open", () => { for (const [d, b] of buffered.local.splice(0)) local.send(d, { binary: b }); });
  pipe.on("open", () => { for (const [d, b] of buffered.pipe.splice(0)) pipe.send(d, { binary: b }); });
  pipe.on("message", (d, b) => send(local, "local", d, b));
  local.on("message", (d, b) => send(pipe, "pipe", d, b));
  pipe.on("close", closeBoth);
  local.on("close", closeBoth);
});
await new Promise((resolve, reject) => {
  control.on("open", resolve);
  control.on("error", reject);
});

// 3. Phone connects and expects its frame echoed back through the tunnel.
const phone = new WebSocket(`${WS_BASE}/connect/${KEY}`);
const roundTrip = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no echo within 5s")), 5000);
  phone.on("open", () => phone.send("hello-tunnel"));
  phone.on("message", (raw) => {
    clearTimeout(timer);
    raw.toString() === "hello-tunnel" ? resolve() : reject(new Error(`bad echo: ${raw}`));
  });
  phone.on("close", (code) => reject(new Error(`phone closed ${code}`)));
  phone.on("error", reject);
});

try {
  await roundTrip;
  console.log("SMOKE PASS: phone → relay → pipe → echo → phone round-trip OK");
  process.exit(0);
} catch (error) {
  fail(error.message);
} finally {
  echo.close();
  control.close();
}
