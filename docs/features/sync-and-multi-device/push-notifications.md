# Mobile Push & Live Activities

ADE pushes agent-state transitions to paired iPhones through a small
Cloudflare Worker relay (`apps/push-relay/`), so the phone learns
"Claude needs input" / "turn failed" / "PR merge-ready" even when the
app is closed and no direct transport exists. A companion ActivityKit
Live Activity mirrors up to three active agent runs on the lock screen
and Dynamic Island.

## Topology

```
agentChatService ─┐
ptyService.onExit ├─ pushPublisherService (brain, debounced + deduped)
prPollingService ─┘        │  HMAC-signed HTTPS
                           ▼
              ade-push-relay (Cloudflare Worker + D1)
                           │  APNs HTTP/2 (ES256 .p8 JWT)
                           ▼
                    APNs sandbox/production
                           │
                           ▼
   iPhone: alert pushes (deep links) + Live Activity updates
```

The phone never talks to the relay. It hands its APNs tokens and
notification preferences to the brain over the paired sync WebSocket
(`push.registerDevice`, `push.setPrefs`, `push.reportLiveActivityToken`,
`push.getStatus`, `push.unregisterDevice` — all runtime-scoped commands),
and the brain forwards registrations to the relay.

## Relay (`apps/push-relay/`)

- Deployed at `https://ade-push-relay.arulsharma1028.workers.dev`
  (override with `ADE_PUSH_RELAY_URL`).
- Trust model: the brain claims an unguessable 32-hex `machineKey` with a
  machine secret; every later call carries `x-ade-push-timestamp` +
  `x-ade-push-signature: sha256=HMAC(secret, "<ts>.<METHOD>.<path>.<sha256(body)>")`.
- D1 tables: `machines`, `device_registrations` (APNs token,
  push-to-start token, bundleId, apsEnvironment), `live_activity_tokens`
  (per-activity update tokens), `publish_suppression` (dedupe hashes),
  `rate_counters` (per-IP rate-limit + daily-budget windows).
- Spend + abuse controls (Cloudflare has no native hard billing cap, so the
  worker enforces its own): a per-IP limit on every route
  (`IP_RATE_LIMIT_PER_MIN`, default 120), a tighter per-IP limit on the
  unauthenticated `/claim` write (`CLAIM_RATE_LIMIT_PER_MIN`, default 10),
  and a hard daily request budget (`DAILY_REQUEST_BUDGET`, default
  500,000/day → `429` until midnight UTC once blown; sized — counting the
  guards' own ~2 D1 counter writes/request — to keep a full month ≈ $1.50 of
  overage, safely under ~$10). All three are wrangler vars. Structured JSON
  logs (`rate_limited`/`budget_exceeded`/`auth_failed`/`apns_error`/
  `claim_conflict`) via enabled observability — see `apps/push-relay/README.md`.
- APNs: ES256 provider JWT from the `.p8` (wrangler secrets `APNS_KEY`,
  `APNS_KEY_ID`, `APNS_TEAM_ID`), cached ~45 min per isolate. Pushes route
  to sandbox/production per registration and use the registration's
  bundleId as `apns-topic` (`<bundleId>.push-type.liveactivity` for Live
  Activities) so dev/TestFlight/App Store builds coexist.
- Phase-dependent TTLs: `running` → 2 h, `waiting`/`terminal` → 24 h.
- Dead tokens (410 / BadDeviceToken / Unregistered / DeviceTokenNotForTopic
  / ExpiredToken) are cleared automatically; the phone re-registers.
- Live Activity `start` pushes set `"input-push-token": 1` so ActivityKit
  mints a per-activity update token, and default `stale-date` to +10 min.

## Brain publisher (`apps/ade-cli/src/services/push/`)

Subscribes to the SAME signal sources the widget snapshot uses — it never
re-derives state:

- `agentChatService.subscribeToEvents` — `approval_request` /
  `structured_question` → waiting phases + alert; `pending_input_resolved`
  clears; failed turn statuses → alert.
- `ptyService.onSessionRuntimeSignal` — tracked CLI sessions' OSC 133-derived
  state (`running` / `waiting-input`) feeds Live Activity run rows **only**,
  never alert pushes: a CLI agent returns to its prompt after every turn, so
  alerting on waiting-input would ping once per turn. Chat-attached shells and
  untitled infra rows are filtered out (the chat run already represents them).
- `ptyService.onExit` — CLI session ended: flips the run to
  completed/failed in the aggregate; a non-zero exit also alerts.
- `prPollingService`'s `pr-notification` events — `merge_ready` /
  `checks_failing` alerts (edge-transition gated by that service).

Behavior: gated off until a device registers; trailing-edge debounce with
prompt delivery for waiting transitions; two dedupe lines (in-memory JSON
fingerprint, then the relay's `dedupeKey` content-hash suppression);
suppressed Live Activity updates never fall back to alert pushes.

Approval alerts are **actionable**: the publisher stamps top-level
`sessionId` + `itemId` and `aps.category: "ADE_APPROVAL"` on the payload,
and iOS binds Approve/Deny notification actions to that category (routed
through the same intent command registry the widgets use — `chat.approve`
with `decision: accept|decline`), so approvals resolve from the lock
screen without opening the app.

Every alert also carries `aps.badge` = the machine-wide count of runs in
`waiting_for_*` phases (`countAwaitingAttentionRuns`). When that count
changes, the publisher also emits a silent, title-less badge-only item
(`dedupeKey: "alert:badge"`, no sound) so the icon tracks *drops* too — an
approval answered on the Mac produces no alert but must still lower the
badge. That badge-only item targets every alert-enabled device that is
**not** already carrying an alert in the same flush (a muted session still
needs the fresh count even though its own alert push is skipped); the
relay's content-hash suppression absorbs unchanged resends, and the
relay accepts a title-less item only when it carries a `badge`. iOS
clears the badge on every foreground.

On daemon shutdown the publisher makes a best-effort Live Activity `end`
(`dismissalDate` now + 60 s, still-active runs re-stamped `stale`),
bounded by a short timeout so exit never hangs — dead agents don't linger
on the lock screen until the stale-date dim.

Per-device preferences are enforced brain-side before publishing: master
enable, per-session mutes, and quiet hours (evaluated in the device's
timezone; may span midnight). Live Activity updates ignore quiet hours
(silent) but honor `liveActivitiesEnabled`.

## Live Activity contract

One aggregate activity per machine (`activityId: "agent-runs"`,
`attributesType: "ADEAgentRunsAttributes"`, attributes
`{ machineName }`). Content state (JSON, mirrored by the Swift
`ActivityAttributes.ContentState`):

```json
{
  "updatedAt": 1751712000,
  "activeCount": 2,
  "runs": [
    { "id": "<sessionId>", "title": "fix-login-flow", "phase": "waiting_for_input",
      "model": "claude-fable-5", "lane": "auth-lane", "detail": "Approve the plan" }
  ]
}
```

Additive optional field: a `waiting_for_approval` row carries `itemId`
(the pending approval item), which the widget uses to render Approve/Deny
`Button(intent:)` on the lock-screen presentation. Older widgets ignore
it; the Swift decode stays lenient.

Phases: `starting | running | waiting_for_approval | waiting_for_input |
completed | failed | stale`. Runs are capped at 3 (most recent first),
`detail` at 160 chars, and a `failed` run's detail is redacted to a fixed
string before it reaches the lock screen. Stuck runs age out of the
aggregate (2 h running / 24 h waiting) so dead sessions cannot pin
`activeCount`. `start` fires on 0→N running, `end` (dismissal +5 min)
when all runs reach a terminal phase.

## One status vocabulary

`apps/desktop/src/shared/sessionCanonicalState.ts` is the canonical mapping
from session inputs to a phase + attention badge, consumed by the Work tab
(desktop and the iOS mirror). Its `needs_you` covers the Live Activity's
`waiting_for_approval`/`waiting_for_input` (wire names unchanged);
`failed`/`stale`/`running` correspond directly. Its 3-hour stale threshold
is the human-facing "running but silent" bar — distinct from the relay's APNs
delivery TTLs and the Live Activity's 10-minute lock-screen stale-date.

## iOS

- `aps-environment` entitlement + `remote-notification` background mode +
  `NSSupportsLiveActivities(FrequentUpdates)`.
- Registration happens only after pairing (never on first launch);
  re-registration on every foreground transition also re-reports Live
  Activity tokens and ends orphaned activities. Unpair/forget sends
  `push.unregisterDevice` and ends local activities.
- Alert payloads carry a top-level `deepLink` (`ade://session/<id>`,
  `ade://pr/<n>`) routed through
  `DeepLinkRouter.handleNotificationUserInfo`.
- Settings > Push delivery panel shows registration state, token suffix,
  environment, last push received, relay reachability (via
  `push.getStatus`), plus notification/Live-Activity toggles, per-session
  mutes, and quiet hours. Runtime-scoped push commands are never queued:
  when the paired machine cannot answer live `push.*` commands, the panel
  keeps the last good relay status, disables manual refresh, and renders a
  transient "connect to the machine" state instead of persisting the
  transport miss as a failed registration.
- Per-session mute is also one tap away in the Work list: the session
  row's context menu (and the open chat's header menu) offers
  "Mute notifications" / "Unmute notifications", and muted rows show a
  subtle `bell.slash` glyph. A muted session still counts toward the
  badge and Live Activity — only its alert pushes are skipped.
- Approve/Deny actions appear on approval alerts (long-press or pull
  down) and on `waiting_for_approval` Live Activity rows. On the alert,
  `ADEAppDelegate` registers the `ADE_APPROVAL` `UNNotificationCategory`
  (`ADE_APPROVE` / `ADE_DENY` actions) and its `didReceive response`
  routes those action ids to `chat.approve`. On the Live Activity, the
  buttons fire `ApproveSessionIntent` / `DenySessionIntent`, which conform
  to **`LiveActivityIntent`** (not plain `AppIntent`) precisely so the
  intent executes in the *app* process — where the command bridge is
  registered — instead of the widget extension where the bridge is nil.
  Both paths dispatch through `ADEIntentCommandRegistry`, which queues the
  command when the bridge isn't live yet; `register()` drains the queue on
  cold launch and every warm foreground also calls `drainPendingCommands()`,
  so an approval tapped while the app was dead still lands on the next open.

## What needs a physical device

Simulators cannot receive real APNs pushes or mint push-to-start tokens.
Fully verifiable on-device only: end-to-end alert delivery, Live Activity
push-to-start, background `liveactivity` updates, TTL/stale behavior.
Everything else (registration flow, command routing, publisher logic,
relay auth/suppression) is covered by unit tests and simulator builds.

## Operator setup

1. Create an APNs auth key (Apple Developer → Keys) and upload it:
   `wrangler secret put APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID` in
   `apps/push-relay` (see its README). Until then the relay's `/health`
   reports `apnsConfigured: false` and publishes return 503.
2. Nothing else — the brain self-claims its machine key on first
   registration and the phone registers itself after pairing.
