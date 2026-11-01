# iPhone Beta app

Plan for a second iPhone app that gets the Beta builds, beside the normal app.
Status: **plan, waiting for the owner's approval.** Nothing here is built yet.

## Why

Today one TestFlight app (`com.ade.ios`) gets every build. A Beta build
replaces the app on the owner's phone. On 2026-10-31, build 1.1.10 (10001)
came from an Xcode 26 runner without the Duo layout, and the owner's iPhone Duo
lost the Duo layout until the next build. With two apps, only the Beta app gets
a bad Beta build. The normal app keeps working.

T3 Code does the same: "T3 Code" and "T3 Code Preview" are two apps with
different bundle IDs and icons (`apps/mobile/app.config.ts` in
pingdotgg/t3code).

## Decisions to approve

1. **Name: "ADE Beta".** The owner said "Preview", and T3 says "Preview". ADE
   uses "Stable" and "Beta" as the only track names on the desktop (see
   `beta-track.md`), so "ADE Beta" keeps one word for one thing. The icon is
   the orange Beta icon, like the desktop Beta build.
2. **The app variant is not the machine track.** Both apps connect to every
   machine, Stable or Beta. The app only decides which iPhone build runs. See
   "Mixed tracks" below.
3. **Separate data.** The two apps share nothing: their own app group, their
   own keychain items, their own pairing with each machine. A Beta bug cannot
   damage the normal app's data.
4. **Links and the App Clip stay with "ADE".** `https://ade-app.dev/...`
   links, the camera pairing QR, and the App Clip open "ADE". The Beta app
   pairs with its own QR scanner, and it gets the `ade-beta://` scheme.
5. **One build-number sequence.** Brains refuse an iPhone build older than
   `MIN_SUPPORTED_MOBILE_APP_BUILD` for its marketing version
   (`apps/desktop/src/shared/syncMobileCompatibility.ts`). Both apps take the
   next number from the higher of the two apps, so that gate works the same
   for both.

## What goes where

| Event | App | TestFlight groups |
|---|---|---|
| A beta with iOS changes | ADE Beta | Internal Testers, Beta public link |
| A stable release with iOS changes | ADE | Internal Testers, Friends, Public Beta |

Today a stable release gives the same build to more groups. With two apps, a
stable release builds "ADE" again at the stable commit. That commit is the
commit of the gated beta, so the code is the same as the Beta app ran.

## Work

### iOS project (`apps/ios`)

- Add a `Beta` build configuration (a copy of `Release`) for the app and the
  widgets:
  - `PRODUCT_BUNDLE_IDENTIFIER`: `com.ade.ios.beta`, `com.ade.ios.beta.widgets`.
  - Display name "ADE Beta", the orange app icon set.
  - `ADE.Beta.entitlements`: push, Sign in with Apple,
    `webcredentials:clerk.ade-app.dev`, app group `group.com.ade.ios.beta`. No
    `applinks` and no App Clip entries.
  - A Swift flag `ADE_BETA_APP`.
- Read the app group from one place. Today `ADESharedContainer.swift` and
  `ClipPairingHandoff.swift` hard-code `group.com.ade.ios`.
- Leave the App Clip out of the Beta app. If Xcode cannot skip the embed per
  configuration, a build phase removes `AppClips/` before the app is signed.
- Turn off the App Store update check (`AppUpdateAdvisor`) in the Beta app.
- Sentry and PostHog get an `app: beta` tag, so Beta crashes do not look like
  Stable ones.
- Push needs no relay change: the app sends its own bundle ID, and the relay
  already sends to each device's own bundle ID (`apps/push-relay`, including
  Live Activities).

### Machines

- The brain already gets the app's bundle ID in hello. Show "ADE Beta" next
  to that phone in the paired device list, so two entries for one phone make
  sense.

### CI and release

- `ios-testflight.yml` and `ios-testflight-ci.sh`: an `app` input (`beta` or
  `stable`) picks the configuration, the App Store Connect app, the groups and
  the tag (`ios-beta-v<mv>-build<n>` or `ios-v<mv>-build<n>`).
- `beta.yml`: builds the Beta app.
- The stable release: builds "ADE" when iOS changed since the last `ios-v*`
  tag. The release skill and `docs/playbooks` change to match.

### Owner steps (once)

1. Create the app record "ADE Beta" (bundle ID `com.ade.ios.beta`) in App
   Store Connect. The API key cannot create an app; only the website (or
   `asc web` with your Apple ID) can.
2. Add `com.ade.ios.beta` to Clerk's native application settings for Sign in
   with Apple. I check first whether I can do this with the Clerk API.
3. Approve the first Beta app build for the public link. Apple reviews the
   first external build of each version.

I create the bundle IDs and their capabilities with the API key.

## Mixed tracks

Each machine has its own track (`~/.ade/update-track.json`). Nothing needs
every machine on one track.

| From | To | Works? |
|---|---|---|
| ADE or ADE Beta (iPhone) | A Stable or a Beta machine | Yes |
| The web client | A Stable or a Beta machine | Yes |
| A Stable desktop app | A Beta machine | Yes |
| A Beta desktop app | A Stable machine | Yes |
| A Beta machine | A Stable machine (commands from one chat) | Yes |

Why it works:

- Every app and every brain speaks sync protocol 1. A change to the protocol
  may only add things (the additive wire rule in `beta-track.md`).
- When the newer side asks for a feature that the older machine does not
  have, it shows "needs a newer ADE on this machine" instead of an error.
- The older side does not know the new features, so it does not show them.
- Only a protocol minimum raise would block a connection, and then both sides
  say which one to update. No release has done that.

The web client deploys from `main` on every merge
(`.github/workflows/deploy-web.yml`), so it is newer than both tracks. It
follows the same rule.

## Checks before it is done

- A TestFlight dry run of each app on the `xcode-27` runner.
- On the owner's phone: both apps installed, both paired with one Stable and
  one Beta machine, a push to each app, the Duo layout in each app.
- The normal app keeps its data after the Beta app is installed and removed.
