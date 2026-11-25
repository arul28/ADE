# ADE Cloud iPhone: from beta to everyone

The beta (this branch) works end to end: an owner-run beta list, usage read
from NoMac, the phone in the tools pane in 3D and flat, and every agent
driving it through `ade apple`. This plan is everything left so the launch is
one server setting, with no app release on the day.

**Superseded on billing (2026-11-25):** the plan's own iPhone minutes, extra
iPhone minutes on their own Stripe meter, the minutes warnings and test
iPhone minutes are gone. The phone draws from the account's credits at one
credit a minute, and an extra minute is an extra credit on the extra-hours
switch. The rows and sections below about minutes are kept as history only.

Feature doc: `docs/features/apple-device/ade-cloud-iphone.md`.

## Decisions (owner, 2026-11-17)

| Question | Decision |
|---|---|
| Past the plan's minutes | Superseded by credits (2026-11-25): out of credits, Free stops and paid plans keep going on extra credits. |
| Extra minute price | Superseded: one credit a minute. NoMac charges us $0.01 a minute. |
| Minutes a month | Superseded: no minutes of its own, the plan's credits. |
| Free plan | Its credits follow the free-hours checks (one free plan per computer; a GitHub account under 30 days old saves a card first). |
| Where the phone shows | Desktop (3D and flat), ADE Web and the ADE iPhone app (flat, NoMac's player). |
| Expo, React Native, Flutter | `ade apple install --app <App.app>` installs a Simulator build made elsewhere. Xcode projects still build on the phone. |
| Running low | The credit balance's emails and notices, and the credits on the ADE Cloud page. |
| Turning it on | One Worker variable. No app release. |
| Extra-use switch | Superseded: extra credits (the extra-hours switch). |
| Beta testers | Nothing special: they draw their plan's credits like everyone else. |

Revyl, for reference: Free gives up to 1,200 minutes with no card, 2 devices
at once, then stops; Pro is $0.075 a minute with a card and $20 auto-recharge.

## Status (2026-11-18)

| Item | State |
|---|---|
| 1. Launch switch and pause | Built; checked against real NoMac. |
| 2. Plan minutes and the Free rule | Removed 2026-11-25 (credits). |
| 3. Usage in D1 and NoMac's webhook | Built (`cloud_phones`, signed webhook, ten-minute check). Hourly `usage/labels` reconcile not built: the ten-minute check reads every live phone instead. |
| 4. Extra minutes on paid plans | Removed 2026-11-25 (extra credits). |
| 5. Warnings and visibility | The phone's own emails removed 2026-11-25; the credit balance's warnings cover it. |
| 6. ADE Web and the iPhone app | Subagents (see report). |
| 7. Non-Xcode apps | Built (`ade apple install --app`); not run against a real Simulator .app yet. |
| 8. Pane extras | Not started (not blocking). |
| 9. NoMac and money | `credit.low` alert and the phones' cost in the owner's cost estimate and free-use cap built. Gary: not asked yet. |
| 10. Analytics | Built (`ade_cloud_phone`: started, ended, refused). |
| 11. Before the switch | Open. |

## Work

### 1. The launch switch (account directory)

- `CLOUD_PHONE_ACCESS` Worker var: `beta` (today's behaviour: the owner's
  list), `all` (every account that passes the plan rules below), `off`.
  `GET /cloud/phone` already answers `access`, and every app reads it, so
  flipping it needs no release.
- `CLOUD_PHONES_PAUSED=1`: no new phones (running ones finish), for a NoMac
  outage or a cost spike. Same shape as `CLOUD_CREATES_PAUSED`.
- The owner's block list already refuses `/cloud/phone` (`routes.ts` checks
  it before `routePhone`).

### 2. Plan minutes and the Free rule

Removed 2026-11-25: the phone draws from the account's credits.

### 3. Usage in D1, from NoMac's webhooks

Today every `GET /cloud/phone` pages through NoMac's list of the account's
phones. At launch scale that is a NoMac call per open pane per 20 s.

- Migration: `cloud_phone_usage (phone_id pk, user_id, device, started_at,
  ended_at, billed_seconds, cost_micros, end_reason, period_start)`.
- `POST /cloud/nomac/webhook`: checks `nomac-signature` (HMAC-SHA256 of
  `t.body`, refuses one older than 5 minutes), dedupes on the delivery id,
  keeps the newest state per phone. `phone.ready` inserts, `phone.ended`
  settles billed seconds and cost.
- Cron (hourly): reconciles each active label against
  `GET /api/v1/usage/labels`, so a missed delivery cannot drift the minutes.
- Minutes used = settled seconds this period, plus the live phone's elapsed
  time (rounded up). `GET /cloud/phone` reads D1 only.
- Secret `NOMAC_WEBHOOK_SECRET`. The webhook is made once at NoMac with
  `phone.queued`, `phone.ready`, `phone.ended`, `credit.low`.

### 4. Extra minutes on paid plans

Removed 2026-11-25: an extra minute is an extra credit (the extra-hours
switch). The old Stripe product, price and meter stay in Stripe unused.

### 5. Warnings and visibility

The credit balance's warnings (`hoursWarnings.ts`) cover the phone; the
pane and the top bar show the credits left.

### 6. ADE Web and the ADE iPhone app

- Sync commands `cloudPhone.status|start|stop|view|screenshot|record` in
  `syncRemoteCommandService` (status is a viewer read; the rest need a
  controlling device), routed to the chat's machine like every pinned call.
- Web adapter namespace `cloudPhone` (`webclient/adapter`), and
  `CloudIphonePanel` shows NoMac's player in an iframe where there is no
  `cloudPhoneView` (no main process, so no 3D). `_headers` adds
  `https://nomac.app` to `frame-src`. The link is signed for the account
  (`NOMAC_EMBED_SECRET`), so a copied link opens nothing.
- ADE iPhone app: the device screen shows the same link in a `WKWebView`,
  with Start, Stop, Screenshot and the credits left.

### 7. Non-Xcode apps

- `ade apple install --app <path>` on `ios@cloud`: zips the `.app`, uploads
  it (`sync/upload` with size and sha256, name `app`), installs it with
  `app_control install`, launches it. Refuses a device build (`.ipa`) with
  a sentence saying a Simulator build is needed (EAS: `"simulator": true`).
- The skill and the feature doc say how Expo, React Native and Flutter users
  make that build.

### 8. Pane parity extras (not blocking launch)

The pane now uses the same stage, rail, strips and loading card as a Mac's
simulator. The rail hides what a cloud phone cannot do yet:

| Rail control | Cloud iPhone |
|---|---|
| Home, Screenshot, Record, View, Reset view, Switch device, Power off | Done. |
| Device tools drawer | Build on `app_control`: appearance, locale, time zone, text size, location, push, permissions, clean status bar. |
| Inspect | Build on `ui_look` with `full` (the accessibility tree as JSON). |
| Float over chat | The mini player can take the offscreen frames. |
| Hardware buttons, rotation | NoMac has no API for them: ask Gary. |

### 9. NoMac and money

- Ask Gary to raise the phone limit past 20 at once before the switch, and
  for a partner price. Prices here assume $0.90 an hour and change in one
  constant (`NOMAC_MICROS_PER_MINUTE`) if his price changes.
- `credit.low` webhook: an owner alert email. NoMac never auto-charges, so
  the prepaid credit is topped up by hand; the alert says how many hours of
  current use are left.
- Owner cost report (`costReport.ts`): phone minutes and NoMac cost per day.

### 10. Analytics and logs

PostHog (server, `analytics.ts`): `cloud_phone_started`
(plan, device, minutes left, reused), `cloud_phone_ended` (reason, billed
minutes, extra minutes), `cloud_phone_refused` (minutes out, free rule,
paused). The brain already logs `cloud_phone.*` events.

### 11. Before the switch

- `/test`: the minutes and spend-cap arithmetic, the webhook (signature,
  dedupe, out-of-order), the extra-minute report, the access switch. These are
  money and access paths; nothing else needs a test.
- Performance: measure the pane on macOS (`docs/perf/macos-baseline.md`) and
  add a row. Windows, measured: idle phone open 8.5% of a core, pane closed
  2.3%.
- Run it as a real Free, Plus and Pro account on the dev Worker, including
  running out, an extra minute on Pro, and a deleted account.

## Launch day

Done 2026-11-18: migrations 0047 and 0048 applied by the main deploy; the three NoMac secrets set on production; NoMac webhook `whk_81d6fff272eb9b0257d5c40b` to the URL below (phone.queued, phone.ready, phone.ended, credit.low; its test delivery verified); the live Stripe product `ade_cloud_extra_phone`, meter `ade_cloud_phone_minutes` and price `price_1UdF4HPWulQjqSYPydFHhXGd` (made on their own, so the existing live prices were not touched); `CLOUD_PHONE_ACCESS=all` in `wrangler.jsonc`, then set back to `beta` the same day: the owner approves each account on the beta list (`POST /cloud/owner/phone-beta`). Open: the raised NoMac phone limit (step 5) and step 6.

1. Apply the migrations; deploy the Worker with `CLOUD_PHONE_ACCESS=beta`.
2. Secrets: `NOMAC_API_KEY`, `NOMAC_EMBED_SECRET`, `NOMAC_WEBHOOK_SECRET`.
3. Make the NoMac webhook to `https://account.ade-app.dev/cloud/nomac/webhook`.
4. Stripe: create the meter and price; add it to existing paid subscriptions.
5. NoMac: the raised phone limit is in place; credit covers a week of
   expected use.
6. Flip `CLOUD_PHONE_ACCESS=all`, and in the same release set `CLOUD_PHONE_ON_WEBSITE = true` in `apps/web/src/lib/cloudPricing.ts` so the website shows it. Watch the cost report and the
   `cloud_phone_*` events the first day; `CLOUD_PHONES_PAUSED=1` stops new
   phones at once if needed.

## Not doing

- Pay as you go on Free. A card saved for the free-hours check stays an
  identity check and is never charged; Free stops at zero (owner,
  2026-11-17).
