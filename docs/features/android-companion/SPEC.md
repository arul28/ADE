# ADE Android Companion App — v1 Specification

**Status:** Approved for build (2026-07-31). Research complete; all decisions below are settled with the project owner unless explicitly marked "open."
**Audience:** an implementing agent with no prior context. This document is self-contained, but the reference docs in [§12](#12-reference-documents) are the deep protocol ground truth — read them before writing sync code.

---

## 1. Context: what ADE is and what this app is

ADE is a local-first development environment: an Electron desktop app plus a runtime ("the brain") that manages dev **lanes** (git worktrees), AI agent **chats** (Claude/Codex/etc.), GitHub **PRs**, terminals, and files on the user's Mac. There is an existing, mature **iOS companion app** (`apps/ios/`, SwiftUI, ~148k LOC) and a **hosted web client** (`apps/desktop/src/renderer/webclient/`, ~4.9k LOC TS) — both are remote clients of the same brain.

**This project builds the Android companion app.** It is the *third* client of a twice-proven protocol. The architecture questions are settled; this is a client port with a known destination.

### The two existing clients, and what Android takes from each

- **iOS app** = the **visual and UX spec**. Same layout, same tab structure, same interaction patterns, translated to Android/Material conventions where sensible. iOS renders from a local SQLite replica + live streams.
- **Web client** = the **data-architecture spec**. It runs "invalidation-only" thin mode: no local CRDT replica, full refetch after connect, sync messages act as refetch hints. Android v1 copies this.

**Android v1 = iOS-grade transport + web-grade thin sync + iOS-matching native UI.** This exact combination exists in no current client but is composed entirely of proven halves (verified in code — see §5).

### Sync topology (critical orientation)

The sync authority is **not** the Electron renderer — it is the `ade serve` runtime in `apps/ade-cli/src/services/sync/` (~40 files). The desktop renderer, iOS, and web are all peers of it. Server-side files referenced throughout live there. `apps/desktop/src/main/services/sync/*` are one-line re-exports.

---

## 2. Settled decisions (do not relitigate)

| Decision | Choice | Why |
|---|---|---|
| Stack | **Native Kotlin + Jetpack Compose** | Google is Compose-first since I/O 2026; near-1:1 conceptual map to SwiftUI; best AI-agent corpus. CMP/Flutter/RN/Skip all rejected for specific reasons (Skip: no `UIViewRepresentable`/custom control styles; RN: no Node builtins, no WASM in Hermes; CMP: iOS UI already written). |
| Data architecture | **Thin client (invalidation-only mode), no local CRDT replica** | Deletes ~7k LOC of CRDT work from v1. Matches web client. CRR replica (port of iOS's pure-SQL emulation) is a v2 option, additive. |
| Transport | **Port iOS's `SyncConnectionRace`** — LAN / Tailscale / relay, raced concurrently | Sync mode is orthogonal to transport (verified). Native Android has none of the browser constraints that force web to relay. |
| v1 scope | **Hub + Settings + Work (Chats) + Lanes**, fully working | PRs / Files / CTO tabs deferred. |
| Terminal | **`org.connectbot:termlib`** (Apache-2.0, Maven Central, Compose component over native libvterm) | Fallback: Termux `terminal-view` (Apache-2.0, confirmed by maintainers in termux-app issue #4257). |
| Auth SDK | **Official Clerk Android SDK** (`com.clerk:clerk-android-api`, GA since 2025-09) + custom Compose UI | Mirrors iOS pattern (ClerkKit API + custom glass UI). Do NOT hand-roll FAPI/PKCE. Pin exact versions — SDK churns fast (1.0.x, patches near-daily). |
| Wire types | **Hand-write the ~30–40 Kotlin types v1 needs** from the TS source of truth | Full TS→Swift+Kotlin codegen deferred until Android tracks the broader command surface. |
| Repo location | **`apps/android/`** in this monorepo, alongside `apps/ios/` | |
| Play account | **Personal** ($25, ~24h). Internal testing works day one; production later requires a 12-tester/14-day closed test | User decision 2026-07-31. |
| Deferred from v1 | SSH bootstrap pairing, Live Activities/widgets, relay-diagnostics panel, App Clip equivalent, PRs/Files/CTO tabs, local CRR replica | User signed off 2026-07-31. |

**Model policy for sub-agents on this project:** use Claude **Opus 5 (medium)** for any spawned agents. Do not use Fable-tier subagents or route work to Codex — explicit user instruction for this effort, overriding CLAUDE.md defaults.

---

## 3. Build environment

### This Mac (agent's machine)
- JDK 17 at `/Library/Java/JavaVirtualMachines/jdk-17.0.5.jdk` (default via `/usr/libexec/java_home`).
- Android SDK at `~/Library/Android/sdk` — **already updated**: platform `android-36`, build-tools `36.0.0`, platform-tools r37 (adb), cmdline-tools latest, licenses accepted. Emulator binary present with an `android-34` arm64 system image (an API-36 image is a deferred ~1.5GB download, only needed for on-device smoke tests).
- No Android Studio here and none needed: build with the Gradle wrapper (`./gradlew assembleDebug`, `./gradlew test`, `./gradlew lint`). Unit tests run on the plain JVM, no device.
- `ANDROID_HOME` is not exported globally; generate `apps/android/local.properties` with `sdk.dir=/Users/arul/Library/Android/sdk` (this file is machine-local — gitignore it).

### The user's Windows machine
Has Android Studio; will open `apps/android/` directly. The Gradle wrapper guarantees identical builds. Keep everything CLI-first and IDE-agnostic.

### Project config baseline
- `compileSdk = 36`, `targetSdk = 36` (Play requires 36 by 2026-08-31 — compliant from day one), `minSdk = 26` (termlib needs 24; Clerk needs 24; 26 is a comfortable floor).
- Compose BOM `2026.04.01`+ (Compose 1.11), Kotlin 2.3.x, Navigation 3. Known forward bump: Compose 1.12 will force `compileSdk 37` + AGP 9.
- Kotlin serialization (`kotlinx.serialization`) for wire types; OkHttp for WebSockets; Tink (or BouncyCastle) for the adoption AEADs.
- **Structure the sync layer as a pure-Kotlin (JVM-only, zero Android imports) Gradle module** (e.g. `:sync`), consumed by the `:app` module. This keeps it testable on JVM and shaped like a future KMP `commonMain`.

---

## 4. Server-side changes required in THIS repo (Milestone M0)

These are prerequisites in the TypeScript codebase, all small, all verified against current code:

1. **Add `"android"` to `SyncPeerPlatform`** — union at `apps/desktop/src/shared/types/sync.ts:132` (currently `macOS | linux | windows | iOS | unknown`), validated in three places: `apps/ade-cli/src/services/sync/syncService.ts:258`, `apps/ade-cli/src/services/sync/deviceRegistryService.ts:72`, `apps/ade-cli/src/services/sync/brainProjectActionsSyncHandler.ts:257`. Without this, an Android peer degrades to `"unknown"` (breaking `isMobilePairingRecord` at `syncHostService.ts:1598-1600`).
2. **Relax the invalidation-only gate** — `isInvalidationOnlyBrowserPeer` at `apps/ade-cli/src/services/sync/syncHostService.ts:1112-1117` requires `deviceType === "browser"`. Change to accept `"phone"` too (or key purely on the `invalidationOnlyV1` capability). This single predicate covers all four call sites: initial cursor (`:1076-1078`), adoption cursor clamp (`:1104-1106`), `hello_ok.features` advertisement (`:1351-1365`), and compact-invalidation substitution (`:4447-4451`, `:5690-5694`).
3. **Guard the reseed/ack deadlock (latent bug)** — a `"phone"` peer is `isMobileChangesetPeer` (`syncHostService.ts:306-308`). If it advertised `changesetAck` + `chunkedEnvelopes`, `peerSupportsMobileReplicaReseed` (`:4423-4427`) triggers a full-state reseed whose sent-branch sets `peer.pendingChangesetBatch` unconditionally (`:5608-5612`) and then waits forever for a `changeset_ack` an invalidation-only peer never sends. Fix both sides: add an invalidation-only guard to `peerSupportsMobileReplicaReseed`, **and** ensure the Android client never advertises `changesetAck` (the web client doesn't — `webclient/sync/connection.ts:772-786`).
4. *(M4, separate workstream — see §8)* FCM support in `apps/push-relay`.

Note: no command-policy change is needed — `syncRemoteCommandService.ts` (5,507 lines, 284 actions) never branches on deviceType; per-action policy is `viewerAllowed`/`requiresApproval`/`localOnly`/`queueable` descriptors that the client reads from `hello_ok` and gates UI against.

Also verify at M1 test time: `MOBILE_CHANGESET_EXCLUDED_TABLES` (`syncHostService.ts:270-277`) narrows invalidation hints for phone peers (excludes `operations`, `attempt_transcripts`) — harmless for v1 scope since chat transcripts arrive via `chat_subscribe`, not table hints. `isMobilePeer` (`:5822-5827`) blocks external file workspaces for phones — fine, Files tab is out of scope. Usage attribution buckets `"phone"` → `mobile` (`apps/desktop/src/main/services/usage/usageStatsStore.ts:235-241`) — correct.

---

## 5. Protocol & connection layer (the `:sync` module)

**Ground truth docs (read these before implementing):** `docs/features/sync-and-multi-device/README.md` (2,189 lines), `ios-companion.md` (2,611), `remote-commands.md` (915), `crdt-model.md` (469), `push-notifications.md` (445), `docs/features/web-client/README.md` (1,040 — effectively the thin-client architecture spec). Wire types: `apps/desktop/src/shared/types/sync.ts` (~2,007 lines, 207 exports, ~45 envelope types). Codec: `apps/ade-cli/src/services/sync/syncProtocol.ts`. Reference implementations: Swift `apps/ios/ADE/Services/SyncService.swift` (20k lines — the exhaustive one) and TS `apps/desktop/src/renderer/webclient/sync/{client,connection}.ts` (the thin one — **mirror this one's shape**).

### 5.1 Envelope protocol
JSON envelopes over WebSocket. Protocol version interval `1...1`, strict integers, additive-within-range: **unknown envelope types must be ignored, not fatal** (this is how clients coexist with desktop-only `rpc_*`/`fwd_*` extensions). Implement `envelope_chunk` framing with bounded reassembly for oversized envelopes, and negotiated deflate compression (offer parsing in `syncProtocol.ts:42`).

### 5.2 Transport: three route classes, raced
Routes ranked `lan < tailnet < relay`:
- **Direct LAN / Tailscale** — plain `ws://host:port` from mDNS discovery, QR `addressCandidates`, or persisted candidates.
- **Cloudflare tunnel relay** — `apps/tunnel-relay/` Worker + Durable Object per `machineKey`. Client dials `wss://…/connect/:machineKey?ready=2`; the DO pairs it with the brain's outbound control socket and passes frames verbatim. Implement ready-v2 negotiation with epoch binding and `relay_reauthorize` (see web client `connection.ts:530-536`, `:930-936`). Max 16 tunnels/machine.
- **Race** (port from `apps/ios/ADE/Services/SyncConnectionRace.swift`): 250ms candidate stagger, ≤3 concurrent sockets, 10s budget, ~300ms relay join delay, first `hello_ok` wins, losers cancelled, per-network route memory. Do NOT copy the web client's sequential fallback loop.

**Verified:** sync-mode negotiation is transport-independent — capability list is sent identically on every route (`webclient/sync/connection.ts:772-786`, `:952-957`); host acceptance is a pure function of deviceType+capabilities (`syncHostService.ts:1112-1117`, `:1351-1365`).

### 5.3 Identity & auth
- **Peer identity:** `deviceType: "phone"`, `platform: "android"` (after M0). This inherits all mobile-tier server behaviors free: 6-missed-heartbeat grace (`syncHostService.ts:1060-1064`), changeset exclusions, 30-min command-result dedupe.
- **DPoP:** Android Keystore P-256 (StrongBox preferred, software fallback), signature over `ade-dpop-v1\n deviceId\n sha256(pairedSecret)\n ts\n nonce`. Server: `apps/ade-cli/src/services/sync/syncDpop.ts` (264 lines). iOS analogue: `DpopKeyService.swift`. Keystore trap: keys are irreversibly invalidated if the user disables their lock screen — catch `KeyPermanentlyInvalidatedException`, delete alias, force re-pair.
- **PIN pairing:** 6-digit PIN, PBKDF2-hashed host-side (`~/.ade/secrets/sync-pin.json`). Returns a durable per-device secret; reconnects never re-ask.
- **QR pairing:** payload codec `apps/desktop/src/shared/pairingQr.ts` + iOS `Services/PairingQrPayload.swift`. Canonical form: `https://ade-app.dev/pair#<base64url(JSON)>` ("smart URL"), `requiredVersion = 3`, 8KB cap, fields `{version, hostIdentity{deviceId, siteId, name, platform, deviceType}, port, addressCandidates[{host, kind}], relayUrl, claimToken, pinConfigured}`. The PIN is never in the QR. Accept bare base64url/JSON defensively.
- **Clerk account:** email-code OTP (`Clerk.auth.signInWithOtp { email = … }` → `currentSignIn?.verifyCode(code)`), plus OAuth buttons (Google/GitHub) later. Session JWTs via `Session.fetchToken()` — **TTL is ~1 minute; fetch fresh at the instant of relay auth**, never cache (iOS: `AccountService.swift:940-945`).
- **Account directory:** `apps/account-directory/` Worker. `GET {directory}/account/machines` → machine list with `reachableEndpoints[{kind: lan|tailnet|relay, url, host, port}]`, `online`, `pubkey`. `PATCH …/machines/{machineKey}` for rename (`{customName}`, ≤80 chars, bearer Clerk JWT, retry-once on 401).
- **Sealed adoption `ade-adopt-v1` — implement exactly** (spec: `sync-and-multi-device/README.md:1881-1955`; iOS flow: `ios-companion.md:45-72`): X25519 ECDH + Ed25519 host signature verified against the directory-published pubkey; client advertises AEAD list (`chacha20-poly1305`, `aes-256-gcm`), host picks first mutual and **signs the selection inside the challenge** (downgrade protection); the negotiated AEAD seals the account hello and the paired credentials in `hello_ok`. LAN/Tailscale adoption only when the directory row carries the host signing key; unsigned legacy hosts are relay-only. Plaintext account bearer is rejected on all direct routes.
- **Trust separation:** sign-out kills relay routes + directory visibility but must NOT delete the paired secret / DPoP key / machine profile (they survive for LAN reconnect). Only explicit **Forget** deletes them.

### 5.4 Thin sync mode
Advertise capabilities `[relayReauthorizeV1, invalidationOnlyV1, compactInvalidationV1, chunkedEnvelopes]` — and **never `changesetAck`** (see §4.3). Hard-require `invalidationOnlyV1` + `compactInvalidationV1` echoed in `hello_ok.features` or terminally error (web: `connection.ts:223-226`).

Data flow after `hello_ok`:
1. Emit a synthetic full invalidation over all UI domains (web: `FULL_INVALIDATION_TABLES` at `connection.ts:72-80`) → every domain refetches.
2. Live `invalidation_batch` frames carry `{fromDbVersion, toDbVersion, tables[], fullRefresh}` (caps: 16KiB envelope, 128 tables — `sync.ts:69-71`; malformed ⇒ treat as `fullRefresh`). Map table names → UI domains (web: `adapter/infra/invalidation.ts:60-90`), **debounce 250ms**, then refetch that domain via commands.
3. Cursor starts at the current watermark (no history replay) — server handles this via the relaxed gate.

**Cold-start cache (required):** persist the last good responses of `lanes.refreshSnapshots`, `work.listSessions`, roster snapshot, project catalog (plain JSON via Room/DataStore — no CRDT) and render them instantly on launch while the socket connects. This recovers iOS's instant-paint feel; it is exactly what iOS's replica provides for these surfaces anyway.

### 5.5 Sub-protocols (all replica-free, all verified working in thin mode)
| Surface | Mechanism | Reference |
|---|---|---|
| Remote commands | `sendCommand` envelope, actions from the 284-action surface | web `client.ts:646`; required-set contract: `apps/desktop/src/shared/syncMobileCompatibility.ts:32-90` |
| Chat streaming | `chat_subscribe` / `chat_event`; history via `chat.getChatEventHistory(Page)` | web `client.ts:715-743`; iOS `SyncService.swift:9940` (identical) |
| Terminal/PTY | `terminal_subscribe`, input, resize, history | web `client.ts:745-846` |
| Roster (Hub) | `roster_subscribe {sinceSeq}` → `roster_snapshot` + `roster_delta`; types `sync.ts:612-710` | machine-wide, cross-project, no project activation needed |
| Project catalog / switch | `project_catalog_request`; `project_switch_request` → result **may hand back a new host/port/credential to re-dial** (`sync.ts:712-736`) | |
| Capability gating | read `hello_ok` `commandDescriptors`; implement `supportsRemoteAction` / `canInvokeRemoteAction` equivalents (iOS `SyncService.swift:12958-12990`) and gate every action button on them | |

---

## 6. App surfaces (v1 scope, iOS as visual spec)

### 6.1 First-run / auth flow (screens Android must build)
iOS reference: launch gate `ContentView.swift:142-159`; screens in `Views/Account/` and `Views/Settings/`.
1. **Access gate** — brand, "Your agents, anywhere.", Sign in / Continue without account (`MobileAccessGateView.swift`).
2. **Sign-in** — email field (+ OAuth buttons), then 6-digit email code. Custom Compose UI over Clerk SDK (iOS deliberately does custom UI over ClerkKit — `AccountSignInView.swift:4-9`).
3. **Your machines** — directory list, tap to connect (sealed adoption), or Done.
4. **Pairing entry** (also Settings' `pairingOnly` mode): Scan QR / Find nearby / (SSH deferred).
5. **QR scanner** — CameraX + ML Kit barcode; parse v3 smart URL.
6. **Nearby machines** — NSD/mDNS list; on API 37 prefer `DiscoveryRequest.FLAG_SHOW_PICKER` (system picker; addresses from it are connectable **without** `ACCESS_LOCAL_NETWORK` — verified against Google docs); pre-37 use `NsdManager` + `NEARBY_WIFI_DEVICES` (declare with `neverForLocation`). NsdManager gotchas: use `getHostAddresses()` (not deprecated `getHost()`), debounce service found/lost flapping, don't rely on TXT records (long-standing empty-TXT bug).
7. **PIN entry** — 6 boxes, shake-on-error, "Connecting to <host>" pre-state; **PIN-setup help sheet** when host advertises `pairingPinConfigured=false` or returns `pin_not_set`.

### 6.2 Hub (home screen)
iOS reference: `apps/ios/ADE/Views/Hub/` (HubScreen 702, HubComponents 1022, HubComposerDrawer 1245, HubQuickConnect 262 lines). The Hub is the root when no project is open; opening a project swaps to the tab scaffold.
- Top bar: brand, connection pill (status dot + machine name, crossfades to "Opening <project>…"), add-project, settings gear, personal-chats icon with awaiting-input badge.
- Project cards from the catalog + roster: icon, name, "N lanes · M chats", expandable → lane sections → chat rows (provider logo, title, relative time; context menus: open/archive/close). Attached shell rows nest under their chat.
- Drag-to-reorder projects; layout state (order, collapsed sets) persisted **per machine**.
- **Bottom composer** (big piece — iOS drawer is 1,245 lines): collapsed pill → expands with Project▸Lane destination picker (auto-create-lane sentinel), Chat/CLI switcher, model/mode/reasoning row, attachments, send. Creates cross-project via `targetProjectId`/`targetProjectRootPath` (`createLane`, `createChatSession`, `startCliSession`) without switching the active project. Draft + preferences persisted locally.
- No-machine state: status pill + quick-connect cards (top 2 online machines, one-tap connect with stage text and PIN fallback).
- Add-project sheet commands: `machineProjectDefaultParentDir`, `openMachineProject`, `createMachineProject`, `cloneMachineProject`, `browseMachineProjectDirectories`, `listMachineGitHubRepos`.
- **Known thin-mode design point (the one place you can't copy iOS):** iOS merges an active-project local-replica overlay into the roster to keep the active card fresh (`buildActiveProjectLocalRoster` + `mergedHubRoster`, `HubScreen.swift:435-607`). Thin client instead: drive the active card purely off `roster_delta` and send an eager `requestRosterSnapshot()` nudge after any local mutation (iOS already nudges — `HubScreen.swift:116`). Accept slightly higher latency; design refresh affordances accordingly.

### 6.3 Lanes tab
Data: `lanes.list`, `lanes.refreshSnapshots`, `lanes.getDetail` commands (the same ones that hydrate iOS's DB — `SyncService.swift:8267-8300`). Render list + detail + lane actions per iOS `Views/Lanes/` (9.5k LOC). All actions capability-gated via command descriptors.

### 6.4 Work (Chats) tab — the biggest UI block
iOS reference: `Views/Work/` (51k LOC — budget accordingly). Session roster via `work.listSessions`; transcripts via `chat_subscribe` live stream + history paging (**transcripts never travel via CRDT on any platform** — server excludes them from phone changesets). Includes: chat transcript rendering (streaming tokens, tool events, approvals with approve/deny, diffs), composer (model catalog via `chat.modelCatalog`, per-session mute), session management (start chat / CLI session), and the **termlib terminal surface** (`org.connectbot:termlib`: pipe terminal_subscribe frames into `writeInput(ByteBuffer)`, render `Terminal(...)`, wire `resize`, use `onInterceptKey` for keys the chat UI owns). Known termlib risk: CJK IME composition (issue #43) — irrelevant for v1's single user, check before broad release.

### 6.5 Settings (sheet, not a tab — mirror iOS)
iOS reference: `ConnectionSettingsView.swift` (1,176 lines) + `Views/Settings/Settings*.swift`. Sections and their v1 treatment:
- **Account card** — Clerk identity, sign out. *(build)*
- **Connection header** — status/route badge, host, disconnect/reconnect, error banner, PIN fallback, host-compatibility banner from `commandDescriptors`. *(build)*
- **Machines list** — directory + saved hosts deduped, ranked current→online→offline, tap-to-connect, long-press rename. *(build)*
- **Add machine** — QR / nearby / SSH(deferred). *(build minus SSH)*
- **Appearance** — System/Light/Dark. *(build, DataStore)*
- **AI usage quotas** — `usage.refreshQuota` command, capability-gated; per-provider windows with progress + reset countdown. *(build)*
- **Connection details / About** — route info, versions, device identity. *(build)*
- **Push prefs** — see §8. *(build with FCM leg)*
- **Relay diagnostics panel** — *(defer; no account-REST equivalent exists)*
- **Additions iOS lacks (build them):** an **analytics opt-out toggle** (iOS's consent alert promises one that doesn't exist) and a **"Forget machine"** action (server API exists; iOS's `forgetHost()` has zero UI callers — Android should expose it as the trust-deletion boundary).

### 6.6 Deep links
Android App Links for `https://ade-app.dev/pair` (+ future deeplink routes; iOS `DeepLinkRouter.swift` is 676 lines — port incrementally). `assetlinks.json` on the domain; never trust a custom-scheme arrival with a pairing token (any app can claim a scheme) — treat as untrusted until confirmed on the authenticated channel.

---

## 7. Background execution & connection lifecycle

- **Foreground service** with `foregroundServiceType="connectedDevice"` for active sessions (untimed, boot-startable — decisively better than iOS's ~30s background grace). **Must also declare `CHANGE_NETWORK_STATE`** (or another qualifying permission) or `startForeground()` throws — verified requirement. Precedent: KDE Connect ships exactly this on Play at targetSdk 37 (verified from their manifest).
- Do **NOT** use `dataSync` type (6h/24h cap, boot-blocked).
- **Hold no long-lived wake lock.** Play's battery-quality enforcement (live since 2026-03-01) delists apps averaging ≥2h screen-off wake locks — and it counts locks held under an FGS. Google's prescribed pattern: acquire only after packets arrive, release after processing.
- Add a CompanionDeviceManager association during pairing (background-start exemptions + reviewer legibility).
- FCM `android.priority: "high"` messages must produce user-visible notifications or FCM deprioritizes the sender; `POST_NOTIFICATIONS` is a runtime permission (API 33+) with a hard prompt cap — use a priming screen.
- WorkManager only for reconnect backoff/health checks — it cannot hold a connection.
- Play review risk: `connectedDevice`-for-a-desktop is accepted (KDE Connect) but companion apps report occasional "need more details" rejections on updates. Prep: demo video (user action → visible notification → stop → session ends), listing language "not a VPN, no routing, user-initiated, stoppable."

---

## 8. Push / attention (Milestone M4 — includes server workstream)

**Client-agnostic today (use immediately):** the account attention REST API on `apps/push-relay` — `GET /attention/account/snapshot?since=`, `POST …/ack`, `POST …/presence`, `GET|PUT …/preferences`, `PATCH …/preferences/devices/{deviceId}` (routes: `apps/push-relay/src/attention.ts:3255-3312`; iOS client: `Services/AccountDirectory.swift:300-600`). The attention drawer UI is fully driven by snapshot+ack — no replica, no push required to render it. Device records carry a monotonic `ownershipEpoch`; HTTP 409 `staleOwnership` must not be retried.

**Blocked on server work (delivery only):** the relay is APNs-only end to end — `apps/push-relay/src/apns.ts` (hard-coded Apple endpoints, ES256 .p8 auth), D1 schema `apns_token`/`aps_environment NOT NULL CHECK(sandbox|production)` (`migrations/0003_account_attention.sql:57-88`), platform whitelist `macOS|iOS|web|unknown` rejects `"android"` (`attention.ts:2654-2662`), registration requires valid `apsEnvironment` (`:2935-2943`). Required: generic `push_provider`/`push_token` (or nullable `fcm_token`), accept `platform: "android"`, relax the `aps_environment` constraint, and an FCM HTTP-v1 sender (OAuth2 service account) beside `apns.ts` in the `deliverAttentionNotifications` fan-out (`attention.ts:846-970`). FCM messages: **data-only** with the same keys as the APNs payload (`category`, `sessionId`, `itemId`, `deepLink`), client maps to channels + `ADE_APPROVE`/`ADE_DENY` notification actions (iOS contract: `ADEAppDelegate.swift:29-52,110-162`). Skip Live-Activity push-to-start (no FCM counterpart). FCM is free/unlimited; quiet hours and body-redaction ("Hide details") are enforced relay-side and work unchanged.

**Free upgrade:** the account prefs blob is richer than iOS exposes (per-event-kind `eventPolicies` over 11 `AttentionEventKind`s — `apps/desktop/src/shared/types/attention.ts:21-32` — `desktopFirstEnabled`/delay, `soundsEnabled`, account-level `mutedSessionIds`). Android can ship a fuller notification-prefs screen than iOS; desktop reference UI: `apps/desktop/src/renderer/components/attention/AttentionSettingsPopover.tsx`.

---

## 9. Milestones

- **M0 — Server prep** (this repo, TS): §4 items 1–3 + tests. Small PR.
- **M1 — Walking skeleton** (proving milestone): `apps/android/` Gradle scaffold + pure-Kotlin `:sync` module: Keystore DPoP, QR/PIN pairing, sealed adoption, connection race, invalidation-only hello, roster subscription — connecting to a **real brain** and streaming roster deltas. When this works, every architectural bet is validated. JVM tests for codec/DPoP/QR-parse/race logic.
- **M2 — Hub + Settings + Lanes**: first-run auth flow, Hub with composer, machines/quick-connect, lanes list/detail/actions, appearance/about, cold-start snapshot cache.
- **M3 — Work/Chats**: chat streaming UI, approvals, session roster, composer, termlib terminal. Biggest UI block.
- **M4 — Push**: push-relay FCM workstream (server) + Android channels/actions + attention drawer + notification prefs.

Definition of done for v1: Hub + Settings + Work + Lanes at functional parity with iOS (minus the settled defers), on the Play **internal testing** track (100 testers, no review, minutes to publish, no build expiry).

## 10. Testing & verification approach

- JVM unit tests in `:sync` for: envelope codec (round-trip against captured real frames), DPoP signature vectors (cross-check against `syncDpop.ts` — consider generating vectors with a small Node script), QR payload parsing (v3 + defensive forms), race logic (fake clock), invalidation table→domain mapping.
- Integration: run a real brain locally (`ade serve` from this repo) and connect the skeleton to it — this is the M1 exit criterion. The desktop app on this Mac can serve as the pairing host (QR/PIN available in its UI).
- UI: Compose previews + a small set of instrumentation tests later; emulator smoke tests once the API-36 image is pulled.
- The existing test conventions in this repo (vitest for TS changes in M0/M4) apply to the server-side PRs; run from `apps/desktop` / `apps/ade-cli` respectively.

## 11. Known risks & watch items

1. **Play review** of the foreground service (mitigations in §7). Not a build blocker — internal testing is unaffected.
2. **termlib is v0.1.0**, single maintainer — pin exact version; vendor/fork is cheap (Apache-2.0) if it stalls. CJK IME open issue.
3. **Clerk Android churns** — pin exact version; its dokka API docs lag, confirm signatures against the artifact.
4. **Hub active-card freshness** in thin mode (§6.2) — the one designed-fresh area; validate feel early in M2.
5. **12-tester/14-day closed test** stands between the personal Play account and production — irrelevant until public launch; plan tester recruitment then.
6. **Wire-type drift** — hand-written Kotlin types have the same drift risk iOS proved (its `LaneSummary` already disagrees with TS in both directions). Keep every Kotlin wire type annotated with a comment pointing at its exact TS source; revisit codegen when type count grows past v1's ~40.
7. **Compose 1.12 → compileSdk 37 / AGP 9** bump coming; don't chase it mid-project.

## 12. Reference documents

| Doc | Path |
|---|---|
| Sync & multi-device (protocol bible) | `docs/features/sync-and-multi-device/README.md` |
| iOS companion (client behavior bible) | `docs/features/sync-and-multi-device/ios-companion.md` |
| Remote commands | `docs/features/sync-and-multi-device/remote-commands.md` |
| CRDT model (why thin mode; v2 replica path) | `docs/features/sync-and-multi-device/crdt-model.md` |
| Push notifications | `docs/features/sync-and-multi-device/push-notifications.md` |
| Web client (thin-client architecture spec) | `docs/features/web-client/README.md` |
| Wire types (source of truth) | `apps/desktop/src/shared/types/sync.ts`, `types/lanes.ts`, `types/attention.ts`, `shared/syncMobileCompatibility.ts`, `shared/pairingQr.ts` |
| Reference clients | `apps/ios/ADE/Services/SyncService.swift` (full), `apps/desktop/src/renderer/webclient/sync/` (thin — mirror this) |
| Workers | `apps/tunnel-relay/`, `apps/account-directory/`, `apps/push-relay/` |
