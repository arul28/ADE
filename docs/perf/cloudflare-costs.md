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
