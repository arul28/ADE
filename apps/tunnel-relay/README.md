# ADE Tunnel Relay

Cloudflare Worker + Durable Object that pipes ADE **sync** WebSocket frames
between a phone and an ADE machine runtime (brain) when there is no direct
LAN / Tailscale path. The brain holds a persistent outbound control socket to
the relay; phones dial the relay; the relay pairs each phone with a dedicated
brain-side pipe socket and passes bytes through 1:1.

This is a **separate worker** from `apps/push-relay` and `apps/webhook-relay`:
different trust model and lifecycle. It uses Durable Objects with SQLite storage
(one instance per `machineKey`) and the WebSocket Hibernation API.

## Architecture

```
                         Cloudflare
  ┌─────────┐   wss    ┌──────────────────────────┐   wss   ┌──────────┐
  │  phone  │ ───────► │  TunnelDurableObject      │ ◄────── │  brain   │
  │ (sync   │ /connect │  (idFromName = machineKey)│ /host   │ control  │
  │  client)│          │                           │  socket │  socket  │
  └─────────┘          │  client socket ◄─┐        │         └────┬─────┘
                       │                  │ pair   │              │ {t:"open", id}
                       │  pipe socket ◄───┘ by id  │ /host/:key/  │
                       │        ▲                  │  pipe/:id    ▼
                       └────────┼──────────────────┘        opens pipe + local
                                │                            ws://127.0.0.1:<syncPort>
                                └── frames pass through untouched
```

1. The brain claims a `machineKey` and opens a signed **control** socket
   (`/host/:machineKey`). Only one control socket per machine; a newer one
   supersedes the old (close `4505`).
2. A client dials `/connect/:machineKey` (no **Worker-level** client auth — the
   `machineKey` is unguessable). ADE's bridged sync listener still requires a
   paired/PIN/DPoP handshake plus a fresh same-account proof for every Relay
   connection. The DO mints
   a short `connectionId`, holds the phone socket, and signals the brain
   `{t:"open", id}` over the control socket.
3. The brain opens a signed **pipe** socket (`/host/:machineKey/pipe/:id`) plus
   a local socket to its sync server, and pipes bytes between them. If it cannot
   service the open, it sends `{t:"reject", id, code, reason}` on the control
   socket so the DO can close the waiting client immediately. Older DOs ignore
   this unknown message type; newer DOs still work with older brains that do
   not send rejections. A successful listener validation is reusable for 30
   seconds: pipe and local dials start immediately while revalidation runs in
   parallel, and a failed revalidation tears the new bridge down.
4. The DO pairs the phone socket and the pipe socket by `connectionId` and
   relays every frame (text and binary) verbatim in both directions. No frame
   wrapping — the sync protocol, including its chunked/binary frames, is
   untouched.
5. Multiple phones per machine work simultaneously (each is its own
   phone/pipe pair). Max 16 concurrent tunnels per machine (close `4503`).

## Auth

Same claim + HMAC design as `apps/push-relay`:

- `POST /machines/:machineKey/claim { secret }` — first writer wins; re-claim
  with the same secret is idempotent (`claimed:false`); a different secret is a
  `409`. The secret lives only in the DO's SQLite storage.
- **Host control** upgrade `/host/:machineKey?ts=<unix>&sig=<hex>` where
  `sig = HMAC_SHA256(secret, "host:<machineKey>:<ts>")`, `±5 min` skew.
- **Pipe** upgrade `/host/:machineKey/pipe/:id?ts=<unix>&sig=<hex>` where
  `sig = HMAC_SHA256(secret, "pipe:<machineKey>:<id>:<ts>")`.
- **Client** `/connect/:machineKey` — no Worker-level auth beyond `machineKey`
  unguessability. This is only transport admission; ADE authorizes the socket
  after it reaches the host.

## Trust model — read this

The relay is a **trusted intermediary for frame contents**. Brain→CF and
phone→CF are both TLS (`wss`), but Cloudflare terminates TLS on each leg, so the
relay can read the sync frames it pipes. The normal ADE sync protocol is
plaintext-over-WS, and this tunnel does **not** add end-to-end payload
encryption — that is future work.

What the relay's position does **not** grant:

- It cannot impersonate a device to the brain: pairing uses per-device secrets
  and DPoP-bound hellos. The in-process relay bridge also requires a fresh
  short-lived Clerk proof whose subject matches the account currently signed in
  on the host. Direct LAN/tailnet hellos do not carry this proof.
- The claim `secret` is scoped to opening tunnels for one `machineKey`; it
  carries no project data and grants no access to any brain internals beyond the
  sync port the brain itself bridges to.

## Known limits (accepted)

- `/connect` is unauthenticated at the Worker by design (ADE authenticates and
  authorizes after transport setup), so anyone who learns a `machineKey` can hold up to the 16
  concurrent-tunnel cap until the 10-minute idle sweep closes them — a bounded,
  self-healing DoS. They still cannot authenticate to the brain.
- Legacy phone frames are buffered in DO memory (bounded, 64 frames / 256 KiB)
  while the host dials the pipe socket. If that volatile legacy buffer is lost
  to hibernation, the relay closes the pair explicitly so the phone reconnects
  instead of silently losing a protocol frame. Ready-v2 phones do not send ADE
  frames until the relay confirms the pipe and local bridge are ready, so their
  first frame never depends on volatile DO memory.

Treat the relay like any other network hop you don't fully control: fine for
transport, not a place to rely on for confidentiality until E2E payload
encryption lands.

The brain opens the host control socket only while its ADE account lease is
current. Sign-out, account switch, expiry, or refresh failure closes the control
socket and active Relay peers. A connecting client must present a fresh
same-account token inside its ADE hello; the relay Worker does not validate or
store that token, but it can read it because TLS terminates at Cloudflare.

The brain sends a native WebSocket protocol ping every 30 seconds and requires
a pong within 10 seconds. A missed pong terminates the control socket and enters
the same jittered reconnect state machine as any other disconnect. These are
protocol control frames handled at the Cloudflare edge: they do not become JSON
`{t:"ping"}` messages, wake a hibernated DO, or add billed DO messages.

## Close codes

| Code | Where | Meaning |
|---|---|---|
| `4501` | phone `/connect` | Host unavailable: no usable control socket or local sync listener |
| `4502` | pipe/phone | Idle > 10 min, closed by the alarm sweep |
| `4503` | phone `/connect` | Machine already at 16 concurrent tunnels |
| `4504` | pipe | Pipe arrived but its phone had already disconnected |
| `4505` | host control | Replaced by a newer host control socket |
| `4506` | phone `/connect` | Pre-pipe frame buffer exceeded 64 frames or 256 KiB |
| `4507` | phone/pipe | Brain rejected the open because bridge validation/setup failed |
| `4000` | pipe/phone/local bridge | Partner closed without an application close code |

For pipe/phone and brain pipe/local boundaries, application close codes in
`4000`–`4999` and sanitized reasons (bounded to the WebSocket 123-byte limit)
are preserved. Non-application close codes fall back to `4000`. Reject messages
use their valid application code, or `4507` when the supplied code is invalid.

Auth failures on `/host` and `/host/.../pipe` are rejected **before** the
upgrade with an HTTP status (`401` bad/expired signature or unknown machine,
`426` missing `Upgrade: websocket`), not a WebSocket close code.

## Idle / GC

Pipe pairs with no traffic for 10 minutes are closed by a Durable Object
`alarm` that runs every 5 minutes (last-activity is tracked in each socket's
hibernation attachment, throttled to a 60s write granularity). Alarms are only
scheduled or rescheduled while at least one non-control socket exists, so an
idle machine with only its hibernated control socket causes no recurring alarm
wakes. The brain reconnects its control socket with jittered exponential
backoff (first retry within about 1s, 60s cap, reset after a successful open).

## Observability

`observability` is enabled, so structured single-line JSON logs are queryable
in the dashboard (Workers → **ade-tunnel-relay** → Logs) and stream live via
`npx wrangler tail ade-tunnel-relay`. Only lifecycle/rejection events are
logged — never per-frame, so a busy tunnel stays cheap: `host_registered`,
`connect_rejected` (`reason: host_offline | too_many | bridge_rejected`), `auth_failed`
(`role: host | pipe`). Cost is already gated by design (signed upgrades, one
control socket per machine, the max-tunnels cap, and the idle sweep above), so
no request-budget limiter is needed here — unlike `apps/push-relay`, whose
request-driven surface carries the in-worker spend cap.

## Deploy

```bash
cd apps/tunnel-relay
npm install
export CLOUDFLARE_API_TOKEN=$(ade secrets get CLOUDFLARE_API_TOKEN --text)
export CLOUDFLARE_ACCOUNT_ID=$(ade secrets get CLOUDFLARE_ACCOUNT_ID --text)
npx wrangler deploy
curl https://ade-tunnel-relay.arulsharma1028.workers.dev/health
```

Durable Objects with **SQLite** storage classes (the `new_sqlite_classes`
migration) are available on the **free** plan, so `wrangler deploy` succeeds
there. However, **WebSocket connection duration** on Durable Objects requires
**Workers Paid** in production — idle hibernation keeps costs down, but a paid
plan is required for real tunnel traffic at scale. No secrets beyond the machine
claims are needed.

## Local dev + end-to-end smoke test

`wrangler dev` runs Durable Objects and WebSockets locally. A scripted smoke
test lives at `test/smoke.mjs`: it starts a local WS echo server (a fake sync
host), a fake brain that holds the control socket and bridges pipes to the echo
server, connects a phone WS to `/connect/<key>`, and asserts an echo round-trip.
The script rejects every non-loopback relay URL before doing network work, so
it cannot be pointed at production.

```bash
npm run dev            # terminal 1: wrangler dev on 127.0.0.1:8787
node test/smoke.mjs    # terminal 2: drives claim → host → connect → echo
```

`npm test` runs both the cheap FakeState/FakeSocket suite and Cloudflare's
supported workerd Vitest pool. The workerd suite uses the real Wrangler config,
Durable Object namespace, `WebSocketPair`, attachment serialization, and
deterministic `evictDurableObject()` hibernation, ordered routing, and old/new
relay compatibility. The manual smoke remains useful for a full local
Wrangler-dev round trip.

```bash
npm test              # fake unit tests, then real workerd tests
npm run test:unit     # FakeState/FakeSocket + pure helpers
npm run test:workerd  # Cloudflare workerd Durable Object/WebSocket tests
npm run typecheck
```
