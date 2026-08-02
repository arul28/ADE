# ADE Android

Native Kotlin/Compose companion client. The Android app uses the pure-JVM
`:sync` module and intentionally keeps no CRDT replica.

## Local checks

```bash
./gradlew :sync:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:bundleRelease
```

`local.properties` is machine-local and must point at the Android SDK. Build
configuration that talks to ADE services is read from Gradle properties or the
same-named environment variables:

- `ADE_CLERK_PUBLISHABLE_KEY`
- `ADE_FCM_PROJECT_ID`
- `ADE_FCM_APPLICATION_ID`
- `ADE_FCM_API_KEY`
- `ADE_FCM_SENDER_ID`

The account directory is production, so `ADE_CLERK_PUBLISHABLE_KEY` must be the
`pk_live_` value from the iOS **Release** build configuration. The iOS project
also contains a Debug `pk_test_` value for its isolated development directory;
Android rejects that mismatch at build time rather than producing an APK whose
account-directory requests will always return 401.

The build also fails when the key is missing so an account-disabled APK cannot
accidentally replace a working development install. Set
`ADE_ALLOW_ACCOUNT_DISABLED_BUILD=true` only when that build is intentional.

On the standard Android emulator, the host machine's loopback is `10.0.2.2`,
not `127.0.0.1`. Debug builds expose a **Local ADE brain** entry in Nearby so a
branch brain listening on host port `8787` can be paired without depending on
mDNS crossing the emulator NAT. That convenience route is compiled out of
release builds.

The Compose UI reuses the canonical iOS `BrandMark.imageset` through the
Android main asset source set. Keep the source-set mapping instead of copying
the same binary into a second tracked asset directory.

Terminal sessions do not depend solely on the embedded emulator view for text
entry. The explicit composer buffers visible text before Return, and the two
scrollable key rows mirror iOS with Esc, Tab/back-tab, arrows, Return/soft
return, common control sequences, shell symbols, Paste, and Hide. This also
keeps terminal input usable when an emulator's hardware-keyboard forwarding is
disabled or unreliable.

## Internal Play build

Keep the upload keystore outside the repository and provide all signing values
through the environment:

```bash
export ADE_ANDROID_VERSION_CODE=1
export ADE_ANDROID_VERSION_NAME=1.0.0
export ADE_ANDROID_KEYSTORE_PATH=/absolute/path/to/ade-upload.jks
export ADE_ANDROID_KEYSTORE_PASSWORD=...
export ADE_ANDROID_KEY_ALIAS=ade-upload
export ADE_ANDROID_KEY_PASSWORD=...
./gradlew clean bundleRelease
```

The signed bundle is written to
`app/build/outputs/bundle/release/app-release.aab`. Upload it to the Play
Console internal testing track, copy the Play App Signing SHA-256 fingerprint
into `apps/web/public/.well-known/assetlinks.json` alongside the debug
fingerprint, and deploy `apps/web`. Internal testing is available immediately;
production access on a new personal account still requires Play's closed-test
eligibility period.

The connected-device foreground service is started only after the user opens
or launches active work. The persistent notification always exposes a
Disconnect action; WorkManager is limited to network-constrained reconnect
attempts and never substitutes for the live connection service.

Pairing also attempts a self-managed Companion Device Manager association when
the installed Android build is granted the platform's protected
`REQUEST_COMPANION_SELF_MANAGED` permission. Stock third-party installs can
withhold that permission; ADE then keeps the authenticated pairing and skips
the optional association instead of crashing. Standard CDM discovery is not a
substitute because it only associates Bluetooth, BLE, or Wi-Fi scan results,
while ADE's desktop link is authenticated independently over IP.
