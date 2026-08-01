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

### Existing Clerk and Google context

ADE already has Clerk in production, including Google sign-in. Reuse the same
Clerk application and user pool; do not create a second auth system. The
production Clerk publishable key already exists in the iOS project configuration
and is public configuration, but supply it to Android as
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

1. **Clerk:** reuse the production ADE application, enable/confirm Native API,
   set `ADE_CLERK_PUBLISHABLE_KEY`, and prove sign-in on Android.
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

- Production Clerk config in the Android build on this machine.
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
