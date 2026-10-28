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
- **Prewarm** `GET /prewarm/:machineKey` — same stance as `/connect`. Returns
  `{ok:true, control:<bool>}` saying whether a host control socket is currently
  registered. Reaching the object is the point: a client that expects to connect
  shortly pays the un-hibernation cost up front. It is inert — no storage, no
  alarm, no attachment migration, and no signal to the host — so it can never
  perturb a live tunnel. `/health` is answered by the Worker and never reaches a
  DO, so it cannot be used for this.

## Placement

A Durable Object lives wherever the request that created it landed, for the life
of the `machineKey`. The Worker therefore derives a `locationHint` from
`request.cf` (continent, split on longitude for the two-region continents) and
passes it on `claim` and `/host` only — the machine's own routes. A phone's
location must never decide where a machine's object lives, so `/connect`,
`/prewarm`, and `/pipe` never carry a hint. Cloudflare applies a hint only when
it creates the object, so this steers new machines and leaves existing ones
exactly where they are.

## ADE MCP

The same Durable Object also carries a machine's remote MCP server
(`docs/features/ade-mcp/README.md`). HTTP requests under
`/m/<endpointKey>/` (and the OAuth discovery URLs
`/.well-known/{oauth-protected-resource,oauth-authorization-server,openid-configuration}/m/<endpointKey>[/mcp]`)
are sent to the brain over its **control socket** as `{t:"http", rid, …}` and
answered with `{t:"http_res", rid, status, headers, body}`. No pipe, no second
socket, no session object.

- The endpoint key is not the `machineKey`: the brain derives it from its
  relay secret and sends it in `mcp_state`; the object named
  `mcp-endpoint:<endpointKey>` stores which machine it belongs to (first
  writer wins, reached only through the Worker's internal
  `/__mcp-endpoint` path), and the Worker caches that mapping. So the URL an
  AI app holds cannot dial `/connect` or `/prewarm` for the machine.
- The brain sends `{t:"mcp_state", enabled, endpointKey, account?}` on every control open and toggle;
  the DO keeps it in the control socket's attachment. Off (or a brain that
  never says) → `404 ade_mcp_off` without waking the machine.
- No control socket → `503 offline`. Over 16 in flight or 300 a minute →
  `429`. Request bodies over 1 MiB → `413`. A request with no answer in 11
  minutes → `504`; a control socket that closes or is replaced fails its
  pending requests with `503` at once.
- Only `authorization`, `content-type`, `accept`, `mcp-protocol-version`,
  `mcp-session-id`, `user-agent` and `x-ade-mcp-via` (set by a brain that
  forwards a call to another computer; the target refuses a second hop) go to
  the brain; only a fixed list of response headers comes back. Every answer carries permissive CORS, and
  `OPTIONS` is answered by the Worker.
- `GET /oauth/callback` is ADE sign-in's one registered return address. The
  `state` names the machine before the dot; the request goes to that brain as
  `/oauth/account-callback`.
- The relay authenticates nothing here: tokens, OAuth and the ADE sign-in check
  that proves a person approved all live on the brain, which redeems ADE's
  sign-in code with a verifier only it holds. The relay can read the traffic
  (TLS ends at Cloudflare) but cannot mint access.

### The account address

One address serves every computer on an ADE account that has ADE MCP on:
`/a/<accountKey>/<rest>` (brain path `/<rest>`, encoded as for `/m/`), plus
`/.well-known/{oauth-protected-resource,oauth-authorization-server,openid-configuration}/a/<accountKey>[/<suffix>]`
(brain path `/.well-known/<kind>[/<suffix>]`). `OPTIONS` is answered by the
Worker with the same CORS. The ADE sign-in callback stays per-machine
(`/oauth/callback`, state `<endpointKey>.<nonce>`), so it returns to the
computer holding the pending sign-in.

- **Joining.** The brain adds `account: {secret}` to `mcp_state`. The secret is
  the account's ADE MCP secret (32 random bytes, base64url, from the account
  vault). The machine object checks its shape (base64url, 32–128 chars), derives
  `accountKey = hex(HMAC-SHA256(utf8(secret), "ade-mcp-account")).slice(0, 40)`
  itself (a key the brain names is never trusted), and adds its machine to the
  object `mcp-account:<accountKey>`. It remembers the key on the control
  socket's attachment and in its own storage, so a restarted brain can still
  leave the account it joined. The secret is never stored or logged.
- **Leaving.** `enabled: false`, no `account`, a malformed secret, or a secret
  for another account removes the machine from the account it joined before. A
  control socket that closes does not leave: an offline computer is skipped.
  Membership messages are applied one at a time, in the order sent.
- **The account object** stores `members` (machine relay keys, at most 32, most
  recent registration last; the oldest drops out past 32) and `front` (the
  machine that last answered). Internal paths, never routed publicly:
  `GET /__mcp-account` → `{members, front}`;
  `PUT /__mcp-account` `{machineKey, op: "add"|"remove"}`;
  `POST /__mcp-account/front` `{machineKey}` (members only).
- **Failover.** The Worker reads the account object and tries the front first,
  then the others newest-first. Each try goes to that machine's object with the
  internal header `x-ade-mcp-mount: a/<accountKey>`; any client copy of that
  header is dropped first, on every MCP route, so a client cannot fake a mount.
  The machine object passes it to the brain as
  `mount: {kind: "account", key}` on the `http` message, never as a header, and
  answers only when this machine is on that account (`mcpAccountKey` on its
  control socket); a machine still listed on an account it has left refuses.
  When the machine object refuses **before** the brain could see the request
  (`503 offline`: no control socket or the send failed; `404 ade_mcp_off`: off
  there, or not on this account), it marks the answer with the internal
  `x-ade-mcp-undelivered` header and the Worker tries the next machine. The
  body is buffered (1 MiB cap, `413` above it) so it can be sent again. Any
  other answer is final and returned as is, including a `503` for a request
  whose brain went away mid-call and a `429`: a request a brain may have
  received is never sent to a second one, and a Durable Object failure on that
  hop is not retried either (`fetchDurableObject`, `retry: "never"`). If the
  machine that answered is not the front, it becomes the front (`waitUntil`).
  No members, or every machine off → `404 ade_mcp_off` ("ADE MCP is off for
  this account…"); at least one offline and none answering → `503 offline`
  ("None of your computers with ADE MCP on are online…", `Retry-After: 30`).
  Rate limits and the other limits above stay per machine object.
- **Trust.** The account address adds no authority to the relay. Account
  tokens, OAuth and the sign-in check still live on the brains, which check the
  `mount` key against the account key they derive themselves. The account key
  in the URL is public and grants nothing; the secret behind it reaches the
  relay only over a brain's signed control socket. A compromised relay could
  add a rogue member to an account only by using a secret it already relays,
  and a rogue member would still have to answer requests whose tokens it cannot
  verify: it gains the traffic it could already read, not access to any brain.

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
- Host frames that reach a pipe before its pair is ready are held in DO memory
  (in order; 64 frames / 4 MiB per pipe, 16 MiB across every pipe of one
  machine) and sent to the phone right after its `{t:"ready"}`. 4 MiB fits the
  stream's first config + keyframe with margin: real screens measured 30-190
  KB, full-screen noise (the worst case) 1.1-1.9 MB on an iPhone 17 Pro and up
  to 1.3 MB on the iPhone Duo's inner panel. The brain's own pre-open buffer
  matches it (`MAX_PENDING_TUNNEL_BYTES`). This is the Apple device stream: its loopback socket
  speaks first, so its config and keyframe can reach the pipe before the
  brain's `ready` reaches the control socket. A lost buffer (hibernation) or an
  overflow closes the pair instead of forwarding a stream with a gap in it.

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
| `4504` | pipe | Pipe arrived, or sent pre-ready data, after its phone had disconnected |
| `4505` | host control | Replaced by a newer host control socket |
| `4506` | phone/pipe | Pre-ready buffer exceeded its cap: phone side 64 frames / 256 KiB; pipe side 64 frames / 4 MiB per pipe or 16 MiB per machine |
| `4507` | phone/pipe | Brain rejected the open because bridge validation/setup failed |
| `4508` | pipe | Pipe epoch or id did not match a pending client |
| `4509` | phone/pipe | One side could not receive a forwarded frame |
| `4510` | phone | Ready-v2 client sent data before relay readiness |
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
(`role: host | pipe`), `mcp_account_joined` / `mcp_account_left` (machine and
account key prefixes only), `mcp_account_rejected` (`reason: bad_secret`, never
the secret), `mcp_account_sync_failed`, `cloudflare_transient` (a Durable Object restarting under
Cloudflare: "storage is no longer accessible", "instance is no longer active",
"internal error; reference = …"). The Worker retries such a failure once on a
fresh stub when the request can be sent twice (a `GET`, a prewarm, a claim),
never for a WebSocket upgrade or an MCP call, and otherwise answers `503` with
`Retry-After: 5`; the brain and the phone reconnect on a failed upgrade with
their usual backoff (`src/cloudflareTransient.ts`). Cost is already gated by design (signed upgrades, one
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
