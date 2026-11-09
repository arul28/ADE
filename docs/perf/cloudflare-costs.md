# Cloudflare costs

What ADE pays Cloudflare, what drives each line, and what Cloud 2 cut. Rule for
every cut: if it measures worse, it does not ship.

Base period: Oct 8 to Nov 7, 2026. "After" numbers are estimates until a release
reaches the fleet, because a cut only works once clients update and nothing was
deployed from this branch. Recheck with the queries at the end.

## The bill

| Product | What ADE uses it for | Oct 8 to Nov 7 | Included | Cost | Expected after cuts | Expected cost |
| --- | --- | --- | --- | --- | --- | --- |
| Workers plan | Everything below | 1 account | - | $5.00 | same | $5.00 |
| Durable Objects run time | Tunnel relay (497K of 533K GB-s), GitHub webhook relay | 533K GB-s | 400K | $12.50 | still over 400K at the current pace (see Relay) | $12.50 |
| Worker CPU | All Workers | 166M ms | 30M | $2.73 | lower, not measured | up to $2.73 |
| Worker requests | Push relay, account directory, webhook relay, tunnel relay | 17.4M | 10M | $2.22 | 5.7M to 7.8M | $0.00 |
| Durable Objects requests | Relay frames and connections | 8.7M | 1M | $1.16 | lower, not measured | up to $1.16 |
| D1 | Directory, push relay | inside limits | - | $0.00 | fewer reads | $0.00 |
| R2 | Diagnostics | inside limits | - | $0.00 | same | $0.00 |
| **Sum** | | | | **$23.61** (billed $22.79) | | **about $21.39** |

Durable Objects run time above 400K GB-s rounds up to whole millions at $12.50,
so anything from 400,001 to 1.4M GB-s costs the same $12.50. That line only
changes once the month stays under 400K.

The Workers `ade-share` and `ade-share-relay`, with their D1 databases and R2
buckets, were deleted on 2026-11-08 at the owner's direction.

## What sends each request

Daily production counts from the brief, with the same routes counted from Worker
logs for one hour on 2026-11-08 (about 53 to 57 computers online).

| Route | Per day | Last hour | Sent by | How often |
| --- | --- | --- | --- | --- |
| `POST /account/machines/register` | 292K | 6,369 | Each brain's directory heartbeat (`accountMachinePublisherService`) | 30 s, plus at once on sign-in, wake and relay route changes |
| `GET /attention/account/settings` | 130K | 5,976 | Each brain's settings cache tick (`accountCacheStore`) | 30 s (see the bug below) |
| `GET /attention/account/vault` | 122K | 5,437 | Each brain's vault cache tick | 30 s (same bug) |
| `POST /machines/:id/attention` | 128K | - | Each brain's activity heartbeat (`pushPublisherService`) | 30 s; carries the settings and vault change marks back |
| `POST /attention/account/presence` | 58K | 2,887 | Each open app window (`useActivitySync`) | 30 s visible, 120 s hidden |

## What was cut

| Cut | Before | After | Reaches the user how |
| --- | --- | --- | --- |
| Directory "I'm online" heartbeat 30 s to 60 s, online window 90 s to 150 s (both environments) | 6,369 registers an hour | about 3,200 an hour once clients update | A computer that stops reads offline up to 60 s later. Old clients on 30 s keep working: the window only grew. Deploy the server before the client. |
| Settings and vault change marks fixed | 11,413 GETs an hour (every brain, every 30 s) | about 1,300 an hour (one per store per 5 minutes, plus real changes) | No slower, measured below |
| Relay peers get the periodic brain status every 30 s instead of 5 s | 37 status frames in 185 s per peer | 6 in 185 s | Latency and sync-lag numbers on a relay connection refresh every 30 s. Changes go out at once, and direct connections keep 5 s. |

### The settings and vault bug

The relay has sent "newest change" marks on the activity heartbeat since #1511,
so a brain only pulls when something changed. No brain ever used them. The client
compared the relay's `accountUserId` with its own, but the relay's value is a
hash of the issuer and subject, so they never matched and every mark was thrown
away. Production logs showed each computer pulling at exactly 30.0 s. The fix is
in `pushRelayClient.ts` and needs no server change.

Measured with the real relay under `wrangler dev` (local D1) and two isolated
client processes running the real stores and real relay client, 7.5 minutes each,
side by side, one write every 71 s. "Before" drops the marks the way the old
client did.

| | Before | After |
| --- | --- | --- |
| Change reaching the other computer, 5 samples | mean 15.0 s, max 27.0 s | mean 15.0 s, max 27.0 s |
| Settings GETs on the receiving computer in 7 minutes, with changes | 15 | 7 |
| Settings GETs on the writing computer in 8 minutes | 23 | 14 |
| First sync on a new computer | value present after its first sync | same |
| Computer returning from 80 s off | value present after its first sync | same |

With no changes, a receiving computer made 2 settings GETs in its first 2 minutes,
against 5 before (only that long was measured). By design the pulls left after
that are the 5-minute safety net. The vault uses the same store code and was not timed separately.
Marks missing or older than 90 s fall back to polling, as before.

### Relay: what keeps the object active

Tunnel relay active time, Cloudflare `durableObjectsPeriodicGroups` per object per
minute, 24 hours to 2026-11-09 (202,543 active seconds, about 25K GB-s a day, or
about 760K a month at the current pace, well above the 533K of the base period).

| Frames that minute | Active seconds | Share | What it is |
| --- | --- | --- | --- |
| 12 to 100 | 82,100 | 40.5% | Connected peers sitting idle: about 18 frames a minute each, of which 12 were the periodic brain status |
| 0 | 40,176 | 19.8% | Woken with nothing forwarded. Not identified. |
| 1 | 31,843 | 15.7% | Computers with only their control socket: the `{t:"ping"}` every 180 s, about 1 s of active time each |
| 101 and over | 37,035 | 18.2% | Real chats, terminals and streams. Not touched. |
| 2 to 11 | 11,388 | 5.6% | Mixed |

Each frame costs about 0.4 s of active time at these rates, and a lone wake about
1 s. Native WebSocket pings do not wake the object.

The status cut removes about 10 frames a minute per idle relay peer. Estimated
saving: about 25% of active time, or 190K GB-s a month at the current pace. That
assumes 0.4 s a frame stays true at the lower rate. It may not, because rarer
frames wake a colder object, so treat it as an upper bound. Real frame counts came
from a real sync host under real timers. The number of GB-s saved cannot be known
until it ships.

**The goal of under 400K GB-s a month is not reached at the current pace.** About
760K less 190K is 570K, still inside the same $12.50 step.

### Not cut

- The 180 s `{t:"ping"}` on the control socket. It is the only check that notices
  a relay registration that has died while the edge still answers transport
  pings. `setWebSocketAutoResponse` would answer it without waking the object, and
  would make it blind to exactly that failure. A longer interval delays recovery
  of a wedged computer, which affects delivery. Going to 300 s would save about
  48K GB-s a month. That is the owner's call.
- The 60 s sync heartbeat. It is what clients use to notice a dead connection.
- The activity heartbeat and `POST /attention/account/presence`. They still carry
  the marks and the "you are at this computer" signal.
- Anything that carries a chat, a terminal or a stream.

## Recheck after a release

Compare these with the tables above about a week after clients update.

- Durable Objects: GraphQL `durableObjectsPeriodicGroups` (`duration` is GB-s),
  grouped by `namespaceId`, and by `objectId` with `datetimeMinute` for the frame
  histogram.
- Requests by route: Workers observability telemetry query, filtered on
  `$metadata.message`.
