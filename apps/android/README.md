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
