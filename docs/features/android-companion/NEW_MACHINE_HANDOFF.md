# Android companion new-machine handoff

Paste the prompt below into a new ADE chat running on branch
`ade/android-app-feasibility`. The prompt is intentionally operational: the
first job is to make the other machine capable of building and running Android,
then prove the app locally, and only then configure external services.

## Handoff prompt

You are taking over the ADE Android companion implementation on branch
`ade/android-app-feasibility`. Work only in this branch's lane worktree. Read
the worktree `AGENTS.md` first, then run `/context` with the keywords `android
companion thin sync FCM`. Do not ask me to restate the project history; recover
live state from Git, the files named below, running processes, and the Android
toolchain on this machine.

I am not familiar with Android tooling. Explain unfamiliar things in plain
language, tell me what you detected, and guide me one screen or command at a
time when human login, payment, identity verification, or 2FA is required.
Never ask me to paste passwords, private keys, service-account JSON, keystore
passwords, payment information, IDs, or 2FA codes into chat. Keep secrets out
of Git. Prefer an already authenticated browser/CLI session and secure local or
CI secret storage.

### Source of truth and current implementation

Start with these files:

- `docs/features/android-companion/SPEC.md` is the approved v1 implementation
  specification that started this work. Its product and protocol decisions are
  settled unless the current code deliberately moved beyond a milestone note.
- `docs/features/android-companion/README.md` describes the implementation as
  it exists now, including source paths, the build gate, and fragile areas.
- `apps/android/README.md` is the concise local build and release guide.
- `docs/features/sync-and-multi-device/README.md` and
  `docs/features/sync-and-multi-device/push-notifications.md` are the deeper
  sync and Attention contracts.
- `apps/push-relay/README.md` owns the FCM deployment contract.

This is not a feasibility stub. The branch already implements the Android v1
client end to end:

- A Gradle project under `apps/android/` with a pure-JVM `:sync` module and a
  native Kotlin/Jetpack Compose `:app` module.
- Clerk email-code authentication, account directory, QR/PIN and Nearby
  pairing, LAN/tailnet/Relay route racing, DPoP, sealed account adoption,
  encrypted paired-machine storage, and sign-out/forget trust separation.
- Invalidation-only thin sync with roster/catalog, command, chat, and terminal
  sub-protocols. Android deliberately never advertises `changesetAck`.
- Hub, project composer, Lanes, Work chat and terminal, personal chats,
  Settings, Attention, notification preferences, and deep links.
- Android foreground connection lifecycle, bounded WorkManager reconnect,
  boot handling, optional Companion Device Manager association, FCM token
  registration, native notifications, and credential-gated Approve/Deny.
- Brain-side support for `deviceType: phone`, `platform: android`, compact
  invalidations, current-watermark startup, and a guard preventing
  invalidation-only phones from entering the mobile replica reseed/ack path.
- Push-relay FCM HTTP v1 delivery, ownership-epoch fencing, invalid-token
  cleanup, D1 migration `0005_android_fcm.sql`, trigger updates, and tests.
- CI coverage, internal docs, logging/privacy rules, and
  `apps/web/public/.well-known/assetlinks.json`.

Preserve the security invariants in the Android README. In particular: no
plaintext direct-route account bearer, no unsigned sealed-adoption fallback,
no `changesetAck`, no arbitrary credential-bearing WebSocket host, no stale
notification action crossing account ownership, and no pairing-secret deletion
on ordinary sign-out.

### Phase 1: make this machine Android-ready before changing cloud services

This is the first task. Do not start Firebase, Cloudflare, or Play Console setup
until the local environment and emulator/device smoke test are working.

1. Detect the OS and CPU architecture. Show me what is already installed before
   installing anything. Check Git branch/upstream, Node, Java, Android SDK,
   `adb`, emulator, available SDK packages, existing Android Virtual Devices,
   disk space, and relevant running processes. ADE requires Node 22 for its
   brain/CLI; Android requires JDK 17.
2. Ensure the Android SDK contains platform 36, build-tools 36.0.0,
   platform-tools, command-line tools, and the emulator. Android Studio is
   convenient but not required; on Windows, opening `apps/android/` directly in
   Android Studio is the simplest path.
3. Install or create an Android Virtual Device only if needed. Prefer an API 36
   Google Play system image matching the host CPU (`arm64-v8a` on Apple Silicon,
   normally `x86_64` on Intel/AMD Windows). A Google Play image matters for a
   real FCM proof. Explain the download size before starting a large system
   image download. This is Android's emulator; it is the Android equivalent of
   an iOS Simulator.
4. Create ignored `apps/android/local.properties` pointing `sdk.dir` at the SDK.
   Set `JAVA_HOME`, `ANDROID_HOME`, and `PATH` for the current shell as needed,
   but do not commit machine-specific paths.
5. From `apps/android`, run the full local gate:

   ```text
   macOS/Linux: ./gradlew :sync:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:bundleRelease
   Windows:     gradlew.bat :sync:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:bundleRelease
   ```

6. Boot the AVD, confirm it is healthy with `adb devices`, install
   `app/build/outputs/apk/debug/app-debug.apk`, and launch
   `com.ade.android/.MainActivity`. Inspect the real rendered UI and Android
   logs, not just the build result. First prove launch, Continue without
   account, navigation, rotation/background/foreground, and a clean restart.
7. Then run a branch-built ADE brain/desktop host and prove actual pairing and
   thin sync. Do not pair the Android branch against an older installed ADE
   brain and then blame the phone: this branch contains required brain protocol
   changes. Use Node 22, build `apps/ade-cli`, follow the worktree `AGENTS.md`
   dev commands, verify the host owns the expected project and sync port, and
   account for emulator networking (`10.0.2.2` for the emulator's host loopback,
   or a reachable LAN/tailnet/Relay address). Prove `hello_ok`, roster/catalog,
   project open, lane/session lists, a chat send/stream, terminal subscribe and
   input, reconnect, and sign-out retaining direct pairing.
8. Capture screenshots/log evidence and report exactly what is proven. An
   emulator launch is not proof of FCM, background delivery, Play signing, or
   LAN/tailnet/Relay roaming.

The original implementation Mac had JDK 17, SDK 36/build-tools 36.0.0, and an
API 34 arm64 image, but those paths are machine-specific and must not be copied.
Its emulator was stopped and app data was cleared after the earlier proof.

### Windows execution record (2026-08-01)

Phase 1 was subsequently exercised on the AMD Windows machine in this lane:

- Installed/configured Node 22, JDK 17, Android Studio 2025.3, SDK platform 36,
  build-tools 36.0.0, platform-tools, emulator, and an API 36 Google Play
  x86_64 `medium_phone` AVD. The ignored `local.properties` uses the SDK under
  `%LOCALAPPDATA%`; no machine path or credential was committed.
- The full Android gate passed on Windows: `:sync:test`,
  `:app:testDebugUnitTest`, `:app:lintDebug`, `:app:assembleDebug`, and
  `:app:bundleRelease`. R8 emitted its existing Kotlin-metadata compatibility
  warning while producing the unsigned release bundle, but the build passed.
- A Node 22 branch-built ADE brain was run against this lane and paired from
  the emulator through `ws://10.0.2.2:8787`. Debug builds now expose that
  emulator gateway as a local Nearby entry; it is absent from release builds.
- Authenticated `hello_ok`, roster/catalog, the three real ADE lanes, the
  existing chat listing, project open, Work/Lanes rendering, background and
  foreground transitions, and force-stop/relaunch reconnect were observed in
  the real emulator. Opening the project retains the authenticated socket when
  the brain adopts it during a same-host/same-port project switch.
- The cold-start exercise found and fixed two lifecycle races: background
  catalog/roster refreshes no longer throw when a closing socket rejects a
  frame, and simultaneous UI/WorkManager reconnect attempts are serialized and
  reuse an already-active machine connection. Regression tests cover both.
- The Android shell was restyled from the iOS Swift implementation: the exact
  iOS wordmark asset, aurora/glass surfaces, compact status controls, richer
  project/lane/work cards, and capsule tab navigation are now shared visual
  language rather than a generic Compose scaffold.
- Android terminal input now follows the iOS structure instead of relying only
  on the embedded terminal widget: a visible buffered composer plus Esc,
  Tab/back-tab, arrows, Return/soft return, common control sequences, shell
  symbols, Paste, and keyboard dismissal. The emulator used here initially had
  Gboard in stylus-handwriting/floating mode; its **Show on-screen keyboard**
  action restores QWERTY and is emulator keyboard state, not an ADE setting.
- The apparent upside-down app was an emulator virtual-sensor rotation while
  the outer emulator window stayed portrait. Restoring orientation `0` fixed
  it; no app transform or manifest orientation bug was involved.
- Production Clerk email-code sign-in was proven with the user's existing
  Google-created account. The production account directory returned both
  existing account machines online (the Mac Studio and MacBook Pro) while the
  Windows machine remained a separate saved direct pairing.
- The first Android auth build accidentally selected the iOS Debug `pk_test_`
  value because the project file contains both Debug and Release Clerk keys.
  Its native JWT correctly identified the development tenant and the production
  directory rejected it. Android now uses the iOS Release `pk_live_` value, and
  the Gradle build rejects a `pk_test_` key while targeting production.
- Clerk initialization is non-blocking. Android now waits for initialization,
  refreshes the persisted client snapshot on startup, explicitly activates the
  session created by email-code verification, and bypasses Clerk's token cache
  for the one allowed directory retry after a 401. Directory errors retain only
  the Worker's bounded safe classification instead of hiding every cause behind
  a generic status.

### Windows execution record, continued (2026-08-02)

The session that produced the record above ended abruptly without writing a
handoff. The following was completed after it and is reconstructed from its
transcript plus subsequent verification. All of it is uncommitted on this
branch.

**Routing and transport**

- The route planner allowed one candidate per class (LAN, first tailnet,
  relay) and the first tailnet candidate is the `.ts.net` DNS name, so the
  working numeric Tailscale IP was dropped before dialing. A phone with
  Tailscale DNS hides this; the emulator exposes it. The planner now prefers
  literal private/Tailscale IPs over DNS aliases *within* each direct route
  class, preserving LAN -> tailnet -> relay ordering and remembered-route
  priority.
- Directory endpoints advertise both a canonical URL and a concrete host/IP.
  Android discarded the host whenever a URL existed; desktop keeps both.
  Fixed, with a regression test.
- **Relay fallback had never worked**: the relay path parsed its `wss://`
  WebSocket URL with an HTTP-only URL parser. Fixed.
- Android reached and authenticated with the Mac Studio over its direct
  Tailscale IP. The remaining blocker there is host version: the ADE runtimes
  installed on both Macs predate the Android thin-sync protocol and reject the
  session. Testing against a Mac requires running a branch-built runtime on it,
  not merely pushing this branch.

**Sync client lifecycle**

- Inbound frames arriving after `hello_ok` resolved but before `activeSocket`
  was published were **silently discarded** (`else -> Unit` in the socket
  listener). A freshly restarted host pushes its full state immediately after
  `hello_ok`, landing squarely in that window; when the dropped frame was a
  reply to a `pendingRequests` entry, the deferred never completed and the UI
  sat on "Opening ADE..." until the 120s `project_open_request` timeout. This
  was the intermittent open-project hang. Fixed with a bounded (512-frame)
  per-socket handoff buffer that is armed at `hello_ok`, drained in order on
  activation, and discarded for losing sockets.
- `activeSocket` and the negotiated codec parameters were non-`@Volatile`
  fields written by the connect coroutine and read on OkHttp reader threads,
  which could make the above window persistent for a connection rather than
  momentary. Now `@Volatile`.
- A failed send leaked its `pendingRequests`/`pendingCommands` entry; the send
  is now inside the `try`.

**CLI launch and PTY (shared desktop code, not Android-specific)**

- The `service_tier` failure observed earlier was **Codex-version-specific**.
  Codex 0.130 rejected `default` and then rejected `flex` at the subscription
  request. Codex 0.146 accepts `default`, `flex`, and `fast`. Updating Codex
  was the real fix; the interim change to emit `flex` for "fast off" was
  reverted, as was a `check_for_update_on_startup=false` flag that was
  redundant with the existing readiness gate and broke launch-command
  round-tripping.
- ADE typed the initial prompt into the CLI composer and then sent Enter on a
  **blind timer**. Codex commits bracketed pastes asynchronously and the delay
  depends on paste size, MCP server startup, and TUI redraws, so Enter was
  frequently swallowed and the session stranded at
  `> [Pasted Content N chars]` with nothing ever noticing or retrying.
  Replaced with an observed state transition: wait for the paste to appear in
  the composer, send Enter, wait for the composer to empty, and re-send Enter
  (bounded, 3 attempts) if it did not. Non-Codex providers are unchanged.

**UI**

- Dark mode was functionally broken (black-on-dark labels and quota cards);
  fixed at the theme-token level rather than per component.
- The chat transcript rendered raw protocol envelopes -- session IDs,
  timestamps, sequence numbers, token-usage payloads -- as plain text.
  Normalization now keeps transport metadata out of the transcript.
- Navigation 3's default transition left the previous screen ghosted; replaced
  with a 180ms directional transition.
- The composer's Send button sat inside the system gesture inset and was only
  tappable at its upper edge; the terminal command bar was overlaid by the IME.
  Both fixed with proper insets.
- Project open blocked navigation on a sequential refresh of chats, lanes,
  sessions, models, and attention, making it look hung. It now navigates
  immediately, paints cached data, and refreshes in the background.
- The Lanes tab removed the only creation control; an explicit "Add lane"
  action was restored.

**Environment hazards discovered on this machine (read before debugging)**

- A running `ade serve` can silently serve a **stale bundle**. The runtime in
  use was executing `apps/ade-cli/dist/cli.cjs` from the *main checkout* dated
  2026-06-02 while the branch's own bundle was hours newer. A fix that is
  present in source but absent from the running bundle looks exactly like a fix
  that does not work. Always confirm the deployed bundle contains the change
  before concluding anything about behavior.
- `C:\Program Files\nodejs\node.exe` is **Node 24**; ADE requires Node 22.
  Use `%LOCALAPPDATA%\Programs\node-v22.23.2-win-x64\node.exe`.
- Port 8787 was at one point bound only on a Tailscale IPv6 address with no
  loopback listener, which breaks the emulator's `ws://10.0.2.2:8787` route.
  A stale Tailscale port proxy from an earlier run is the likely cause. Verify
  reachability from inside the emulator, not just from the host.
- The desktop test suites have **85 pre-existing failures on Windows** caused
  by tests hard-coding Unix expectations (`/bin/bash`, `/bin/zsh`, Unix JSON
  quoting) while the harness produces `powershell.exe`. These are a
  cross-platform test defect, unrelated to Android work. Do not treat them as
  regressions, and do not let them mask real ones -- always compare against a
  true HEAD baseline.

**Later continuation (same day) — additional fixes and traps**

- **Starting the runtime:** use plain `node apps/ade-cli/dist/cli.cjs serve`. Do
  **not** pass `--port` expecting to set the mobile sync port -- `--port` is the
  local JSON-RPC endpoint, and pointing it at 8787 collides with the mobile sync
  host and makes the phone fail with "Unexpected status line". Plain `serve`
  binds `0.0.0.0:8787` for mobile sync correctly.
- **There is no `provider` column.** `terminal_sessions` stores only
  `tool_type`, and `TerminalSessionSummary` has no top-level `provider` (only
  `toolType` and a nested `resumeMetadata.provider`). `work.listSessions`
  therefore returns no provider for every row, permanently. iOS and the host
  both derive it (`providerFromTool` in `terminalSessionSignals.ts`;
  `workChatProviderFamilyFromToolType` on iOS). Android now derives it the same
  way. Do not "fix" this by adding a column.
- **Lane invalidation feedback loop (fixed at source).**
  `upsertBranchProfileForRow` in `laneService.ts` unconditionally rewrote
  `updated_at` for every lane on every sweep. `lane_branch_profiles` is a
  cr-sqlite CRR table, so writing an unchanged row still produces a changeset
  row, which became a LANES invalidation, which made clients call
  `lanes.refreshSnapshots`, which rewrote the rows again -- about 1.3 writes/sec
  with a `git status` per worktree across 14 lanes. It starved unrelated
  commands badly enough that `chat.approve` timed out, so a session parked on an
  approval could not be approved. Fixed by skipping the write when content is
  unchanged, matching the guard `lane_state_snapshots` already had. Measured
  1.31 writes/s -> 0.
  **Consequence:** there is no host-side git-status watcher. Filesystem-
  originated lane changes (the `dirty` badge) were only appearing promptly
  because that loop polled constantly. Near-live dirty state now needs a real
  watcher; the old behavior was accidental.
- **Client command diagnostics.** `:sync` now logs enqueue/sent/done/timeout/
  failed with action name, opaque request id and elapsed ms, plus
  `sync.inbound_dropped` with a reason for the silent-discard paths. Timeouts
  now name the stalled action. No content, paths, tokens or payloads are logged.
- **Action-scoped command timeouts** replace the flat 30s (iOS's pattern):
  120s for `chat.create`/`chat.send`/`work.startCliSession`/`lanes.create`,
  240s for `lanes.delete`. The old flat timeout let the phone give up while the
  host went on to succeed, leaving an error beside a session that really exists.
- **Unexplained client-side wedge, still open.** Twice, an outbound command
  (`chat.create`) or an inbound reply (`project_switch_result`) went missing
  while the same socket carried other traffic normally; host-side inspection
  proved the runtime sent the reply. Force-stopping the app cleared it both
  times and it does not reproduce on demand. The new inbound/outbound logging
  above exists specifically to catch the next occurrence.
- **Pre-existing CRR-repair defect (not from this branch).** `ade lanes list`
  once failed with invalid generated DDL in the `__ade_crr_repair_*` table
  rebuild path -- a table-level `references` emitted without `foreign key`. It
  rolled back cleanly and did not recur; the DB passed `integrity_check`.

**Known UX gap, not yet fixed**

- After a host runtime restart the app does not auto-reconnect while in the
  foreground. The Hub keeps painting stale cached data under a "No machine"
  chip and refresh does nothing visible; the user must go to
  Settings -> Reconnect.

This record does **not** yet prove ordinary sign-out retaining pairing, real
FCM delivery, physical-device behavior, Play signing/install, LAN/tailnet/Relay
roaming, or any Mac-to-Android path. Keep those as explicit remaining proofs
rather than inferring them from the successful local connection.

### Existing Clerk and Google context

ADE already has Clerk in production, including Google sign-in. Reuse the same
Clerk application and user pool; do not create a second auth system. The
production Clerk publishable key already exists in the iOS project's **Release**
build configuration and is public configuration. Do not select the first Clerk
key in the project file: Debug intentionally uses `pk_test_`, while Release uses
`pk_live_`. Supply the Release value to Android as
`ADE_CLERK_PUBLISHABLE_KEY` rather than duplicating it in a new tracked file.
Confirm Clerk Native API support for Android and test email-code sign-in first;
Google OAuth UI can be verified after basic auth.

I already have a Google Cloud account/project because Clerk's Google sign-in
uses a Google OAuth client. That does not automatically mean Firebase or FCM is
enabled. Once local testing works, inspect the authenticated Google account and
list its projects. Identify the exact ADE/Clerk OAuth project with me before
adding Firebase or creating anything. Reusing that GCP project is likely, but
do not choose based only on a similar display name.

Firebase is not the Android App Store. The mapping is:

| Apple | Android |
| --- | --- |
| App Store Connect | Google Play Console |
| TestFlight | Play Internal Testing |
| APNs | Firebase Cloud Messaging (FCM) |
| Apple profiles/certificates | Upload keystore plus Play App Signing |
| Associated Domains | Digital Asset Links `assetlinks.json` |
| Clerk | The same cross-platform Clerk application |

ADE needs only Firebase Cloud Messaging. Do not introduce Firebase Auth,
Firestore, Realtime Database, Analytics, Hosting, or another source of truth.
Without FCM, the current app intentionally still initializes and can pair/sync,
but background attention/approval notifications do not work.

### Phase 2: external configuration, in this order

After Phase 1 is proven, walk through these items with me. Resolve existing
resources before creating new ones and keep every external mutation explicit.

1. **Clerk (complete locally):** the production ADE application and Release
   publishable key are configured; Native API email-code sign-in, session
   restoration, and the production machine directory are proven on Android.
2. **GCP/Firebase client:** add Firebase to the confirmed existing GCP project
   or create a dedicated project only if we explicitly choose that. Register
   Android application ID `com.ade.android`. Obtain the client configuration
   represented by `ADE_FCM_PROJECT_ID`, `ADE_FCM_APPLICATION_ID`,
   `ADE_FCM_API_KEY`, and `ADE_FCM_SENDER_ID`. Firebase's Android client config
   is non-secret, but this project currently consumes environment/Gradle
   properties rather than committing `google-services.json`.
3. **FCM server credential:** enable the FCM HTTP v1 API and create the narrowly
   scoped service identity needed by `apps/push-relay`. Treat its JSON private
   key as a secret. Never paste or commit it. Store the full JSON as the
   Cloudflare Worker secret `FCM_SERVICE_ACCOUNT_JSON` using an authenticated
   Wrangler session or another approved secret store.
4. **Cloudflare:** verify the exact account and existing `ade-push-relay`
   deployment. The branch migration and trigger update are not yet deployed.
   Follow `apps/push-relay/README.md`; its deploy flow also checks existing Clerk
   authentication bindings and smoke tokens. Apply the D1 migration/trigger and
   deploy only after confirming target/account and impact. Then prove the
   Worker's `/health` FCM configuration flag and authenticated account route.
5. **Real push proof:** on a Google Play-enabled emulator or physical Android
   device, sign in, enable notifications, verify registration ownership, put
   the app in the background, cause a real ADE Attention event, and verify the
   visible notification, exact deep link, redaction preference, deduplication,
   and credential-gated Approve/Deny behavior. Inspect both device and Worker
   logs without printing tokens/payload secrets.
6. **Google Play Console:** I previously chose a Personal developer account.
   Help me register/verify it, but I personally handle the $25 payment, identity
   checks, Android-device verification, and 2FA. Create the app as
   `com.ade.android`, free, default locale `en-US`, and begin with Internal
   Testing. Do not claim production eligibility; a new personal account has
   additional closed-test requirements.
7. **Android signing:** generate a permanent upload keystore outside the repo,
   store it and its passwords in an agreed secure backup, and provide the four
   `ADE_ANDROID_KEYSTORE_*` inputs plus version code/name. Build and verify a
   signed AAB before upload. The existing local AAB was intentionally unsigned
   because no real upload keystore existed.
8. **Store listing:** adapt the existing Apple listing instead of starting from
   scratch. The live App Store Connect record is ADE app ID `6762759870`, bundle
   `com.ade.ios`, locale `en-US`, name `ADE - Agentic Dev Environment`, subtitle
   `Ship with coding agents`, privacy policy `https://www.ade-app.dev/privacy`,
   marketing URL `https://www.ade-app.dev`, and support URL
   `https://www.ade-app.dev/docs`. Rewrite iPhone-specific text for Android and
   make fresh Android screenshots.
9. **Play signing and App Links:** after the first Play upload enables Play App
   Signing, copy the Google-held app-signing SHA-256 fingerprint—not merely the
   local upload/debug key—into
   `apps/web/public/.well-known/assetlinks.json`. It currently contains only the
   debug fingerprint. Deploy the web app and prove Android link verification.
10. **Apple cross-platform mapping:** App Store Connect currently has no
    Android-to-iOS mapping. After the Play package/fingerprint is final, the
    authenticated `asc` CLI can add `com.ade.android` and the Play signing
    fingerprint if appropriate.

### Live Apple setup already inspected

On the original Mac, `/opt/homebrew/bin/asc auth doctor` was healthy with the
keychain-backed `ade` profile. Read-only inspection found:

- ADE iOS build `1.1.10 (51)` processed as `VALID`.
- TestFlight groups `Friends`, `Internal Testers`, and `Public Beta`.
- Main bundle capabilities: Push Notifications, time-sensitive notifications,
  Sign in with Apple, App Groups, and Associated Domains.
- Active Apple distribution certificates/profiles for the app, widgets, and
  App Clip.
- No Android-to-iOS mapping yet.

This Apple setup is useful as product/listing reference but its certificates,
provisioning profiles, APNs credentials, App Store Connect API key, and
TestFlight distribution cannot sign, authenticate, or publish Android.
Re-check `asc` authentication on this new machine rather than assuming the
original Mac's keychain moved with the branch.

### Known incomplete proofs and blockers

Do not report these complete until they are demonstrated live:

- Firebase Android registration and the four FCM client values.
- `FCM_SERVICE_ACCOUNT_JSON` installed in the production push relay.
- Remote D1 migration/trigger deployment and production Worker rollout.
- Real FCM notification delivery and background behavior.
- A permanent upload keystore and signed release AAB.
- Google Play developer/app record and Internal Testing upload/install.
- Play App Signing fingerprint in the deployed `assetlinks.json`.
- Verified HTTPS App Links from the Play-installed build.
- Full LAN/tailnet/Relay roaming and Android-version background-limit testing.

The earlier local quality/test passes found no remaining verified
correctness/security or maintainability issue in the reviewed paths. Node 22
CLI typecheck and focused sync suites passed. A full parallel CLI run once had
one five-second timeout in an existing mobile-sync ownership test; that same
test passed alone. Re-run current branch gates on this machine and treat fresh
results as authoritative.

### Working rules for the continuation

- Preserve existing changes and unrelated user work. Never edit the main
  checkout while operating in a lane worktree.
- Use Node 22 for ADE desktop/CLI tests. JDK 17 is the Android toolchain.
- Keep external setup and live proof separate: a successful Firebase console
  setup is not proof a notification arrived; an emulator build is not proof a
  signed Play bundle works.
- Stop and explain whenever I must choose an account/project, pay, verify
  identity, approve a cloud deployment, or select secret-storage/backup policy.
- Once environment, device proof, and external configuration are complete, run
  the repository's `/quality` then `/test` gates. Do not merge or release unless
  I explicitly ask; use `/ship` only after that authorization.
