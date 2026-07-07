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
  1,000,000/day → `429` until midnight UTC once blown; sized to keep a full
  month under ~$10 of overage). All three are wrangler vars. Structured JSON
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
- `ptyService.onExit` — CLI session ended.
- `prPollingService`'s `pr-notification` events — `merge_ready` /
  `checks_failing` alerts (edge-transition gated by that service).

Behavior: gated off until a device registers; trailing-edge debounce with
prompt delivery for waiting transitions; two dedupe lines (in-memory JSON
fingerprint, then the relay's `dedupeKey` content-hash suppression);
suppressed Live Activity updates never fall back to alert pushes.

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

Phases: `starting | running | waiting_for_approval | waiting_for_input |
completed | failed | stale`. Runs are capped at 3 (most recent first),
`detail` at 160 chars, and a `failed` run's detail is redacted to a fixed
string before it reaches the lock screen. Stuck runs age out of the
aggregate (2 h running / 24 h waiting) so dead sessions cannot pin
`activeCount`. `start` fires on 0→N running, `end` (dismissal +5 min)
when all runs reach a terminal phase.

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
  mutes, and quiet hours.

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
