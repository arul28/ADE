# Android companion

ADE Android is a native Kotlin and Jetpack Compose controller for an ADE brain.
It can sign in, discover or pair a machine, open the machine/project Hub, manage
lanes, create and continue chats or CLI sessions, stream terminals, and read or
act on account Attention. The phone never runs agents and Android v1 keeps no
cr-sqlite replica.

## Source file map

- `apps/android/app/` — Android application, Compose screens, lifecycle,
  account/directory clients, pairing, encrypted machine storage, and FCM.
- `apps/android/app/src/main/java/com/ade/android/MainViewModel.kt` — UI-facing
  owner for remote commands, live chat/terminal streams, cached thin-client
  projections, Attention presence, and analytics consent reconciliation.
- `apps/android/app/src/main/java/com/ade/android/pairing/` — QR/PIN and Nearby
  pairing, route construction, companion-device association, and account
  adoption wiring.
- `apps/android/app/src/main/java/com/ade/android/connection/` — connected-device
  foreground service, boot handling, and network-constrained reconnect work.
- `apps/android/app/src/main/java/com/ade/android/push/` — FCM data-message
  presentation, deep links, and approval/denial notification actions.
- `apps/android/sync/` — pure-JVM wire, crypto, pairing, route racing,
  invalidation, chat, terminal, roster, catalog, and remote-command client.
- `apps/ade-cli/src/services/sync/syncHostService.ts` — brain-side phone thin-sync
  negotiation, compact invalidations, pairing/adoption, and stream routing.
- `apps/desktop/src/shared/types/sync.ts` — shared TypeScript wire source of truth,
  including the Android peer platform value.
- `apps/push-relay/src/attention.ts`, `fcm.ts`, and
  `migrations/0005_android_fcm.sql` — Android device registration and FCM HTTP v1
  delivery.
- `.github/workflows/ci.yml` — JVM sync tests plus Android lint and debug APK
  assembly on SDK 36.
- `SPEC.md` — approved v1 scope and protocol decisions. Treat the code and this
  README as the description of current behavior when the implementation has
  moved beyond a milestone instruction in the spec.
- `NEW_MACHINE_HANDOFF.md` — copyable continuation prompt that starts with
  Android toolchain/emulator proof, then walks through Clerk, Firebase/FCM,
  Cloudflare, signing, Play Internal Testing, and verified App Links.

## Thin-client architecture

Android identifies as `deviceType: "phone"`, `platform: "android"` and
advertises `invalidationOnlyV1`, `compactInvalidationV1`,
`chunkedEnvelopes`, and `relayReauthorizeV1`. It deliberately does not
advertise `changesetAck`: the phone has no replica to acknowledge and the brain
must not enter the mobile-reseed path for an invalidation-only peer.

After `hello_ok`, the app performs a full domain refresh. Later compact
invalidations are debounced and mapped to command-backed lane, session, chat,
usage, project, roster, and Attention refreshes. Roster and project catalog
have live wire sub-protocols; chat and terminal output use their dedicated
streams. The last good roster, catalog, lanes, sessions, per-machine Hub layout,
and composer draft are cached locally for immediate cold-start paint, but they
are not authoritative offline replicas.

Every mutation is gated by the brain's advertised command descriptors. A phone
may stay connected to an older brain in limited mode, but unsupported actions
must remain unavailable rather than being queued optimistically.

## Connection and trust

Connection candidates are ranked LAN, tailnet, then Relay and raced with a
bounded stagger. Saved pairing uses a per-device secret plus a P-256 DPoP key
from Android Keystore; an invalidated key forces re-pairing. First pairing uses
the v3 ADE QR payload or Nearby discovery and the user-configured six-digit
host PIN.

Signed-in users can adopt a directory machine without a PIN. Direct LAN or
tailnet adoption is allowed only when the directory supplied the host's
Ed25519 identity key. The client verifies the signed `ade-adopt-v1` challenge,
negotiates signed `chacha20-poly1305` or `aes-256-gcm`, and seals both the
account hello and returned pairing credentials. An unsigned legacy directory
entry is Relay-only. Clerk access tokens are fetched at use time rather than
persisted as Relay credentials.

Sign-out disconnects account and Relay access and best-effort removes this
installation's FCM registration. It intentionally preserves the direct pairing
secret, machine profile, and DPoP key so LAN reconnection remains possible.
Only explicit Forget removes direct trust.

## Product surfaces

- **Access and pairing** — Clerk email-code sign-in, continue without account,
  account machine directory, CameraX/ML Kit QR scanning, Nearby discovery, and
  PIN entry.
- **Hub** — machine project catalog and roster, nested attached shells,
  per-machine project order/collapse state, project open/create/clone, and a
  cross-project Chat/CLI composer with model, permission, reasoning, and image
  attachment controls.
- **Lanes** — lane summaries and detail, create through the Work composer, and
  capability-gated rename, sync, archive/restore, and delete actions.
- **Work** — canonical session list, chat transcript/history and live events,
  send/stop/approval actions, attachment display, and terminal subscribe,
  history, input, resize, and Ctrl-C.
- **Personal chats** — machine-scoped, projectless chat list and creation,
  archived-chat lifecycle actions, cached summaries, dedicated stream scope,
  history, attachments, send, and approval actions.
- **Settings and Attention** — connection and account controls, appearance,
  analytics opt-out, notification preference, account Attention, exact deep
  links, and notification approval/denial actions.

PRs, Files, CTO, a local CRR replica, SSH bootstrap pairing, widgets, and an
App Clip equivalent remain outside Android v1.

## Background connection and push

Opening or launching active work may start a connected-device foreground
service. Its persistent notification includes Disconnect. When there is no
active work the app removes foreground presentation without discarding the
live client solely for that reason. WorkManager performs bounded,
network-constrained reconnect work; boot handling does not turn it into an
unbounded background socket loop.

The pairing flow makes a best-effort self-managed Companion Device Manager
association only when Android actually grants its protected permission. A
normal Play/debug install may not receive that grant; pairing remains valid and
the optional association is skipped. Android's standard CDM chooser cannot
model ADE's LAN/tailnet/Relay desktop because it accepts Bluetooth, BLE, or
Wi-Fi scan results rather than an authenticated IP endpoint.

Signed-in installs register an FCM token and monotonic ownership epoch with the
Attention relay. The relay sends high-priority data-only FCM HTTP v1 messages,
applies the same notification policy and receipt deduplication as APNs, and
removes tokens that FCM reports as unregistered. Android builds the system
notification locally so it can honor exact ADE deep links and expose safe
Approve/Deny actions. Those actions launch an unexported credential-gate
activity and dispatch only after device authentication; devices without a
secure lock screen do not receive inline approval actions. Each immutable
action is bound to the current owner hash, ownership epoch, and source machine,
then revalidated after unlock so stale notifications cannot authorize work.

Android reports foreground Attention presence, and reports visible item ids
only while the account Attention drawer is actually open. Background presence
must never claim those items as visible.

## Analytics and privacy

Android has no PostHog SDK or capture token. App-open and coarse screen events
use the brain's allowlisted `analytics.capture` command, and the DataStore
analytics preference is reasserted through peer-scoped
`analytics.setClientEnabled` after each connection. Prompts, transcripts,
terminal bytes, paths, raw errors, sync frames, retries, and FCM payload details
are not analytics events. See [`../../logging.md`](../../logging.md).

Pairing secrets and DPoP material are excluded from Android backup/transfer.
FCM, Clerk, signing, and Play credentials are build/deploy environment inputs,
not repository files.

## Build and release

The Gradle root is `apps/android/`. It uses JDK 17, compile/target SDK 36, and
minimum SDK 26. The CI-equivalent local gate is:

```bash
./gradlew :sync:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:bundleRelease
```

A distributable internal-track bundle requires the four
`ADE_ANDROID_KEYSTORE_*` values plus Clerk/Firebase production configuration.
After Play App Signing is enabled, add the Play signing SHA-256 fingerprint to
`apps/web/public/.well-known/assetlinks.json` and deploy the web app before
claiming verified App Links in the Play build.

JVM tests and lint do not prove system notification presentation, background
limits, Nearby behavior on each Android API level, real FCM delivery, or
LAN/tailnet/Relay roaming. Those require an Android device or complete emulator
image; signed Play delivery additionally requires the real upload key and Play
account.

## Fragile areas

- Never add `changesetAck` while Android is invalidation-only, and keep the
  brain's reseed predicate guarded against all invalidation-only peers.
- Sealed adoption is cross-platform crypto. The host identity, client identity,
  selected AEAD, and context string must remain inside the signed/AEAD-bound
  transcript; there is no plaintext direct-route fallback.
- Every credential-bearing route is revalidated before dialing: Relay must use
  `wss://`, while direct `ws://`/`wss://` routes are restricted to loopback,
  private/link-local LAN, Tailscale, or local-name hosts.
- Nearby service TXT attributes are optional. Route discovery must still work
  when Android returns an empty TXT record and authenticated `hello_ok` remains
  the source of the brain identity.
- Roster and live streams have independent sequence/cursor state. Reconnect must
  resume from the last acknowledged sequence and an authoritative snapshot must
  reset its corresponding watermark without duplicating visible content.
- FCM registration ownership uses the same monotonic epoch fence as APNs. A
  delayed request from an old account must not reclaim the installation. The
  encrypted owner transition is committed before sign-out revocation; a failed
  deletion is superseded by the next account's higher epoch, and signed-out
  clients discard any late FCM payload locally.
