# iPhone Beta app

Plan for a second iPhone app that gets the Beta builds, beside the normal app.
Status: **approved by the owner on 2026-11-01, with the name "ADE Beta".**
Built on `plan/ios-beta-app` (PR #2008).

## Why

Today one TestFlight app (`com.ade.ios`) gets every build. A Beta build
replaces the app on the owner's phone. On 2026-10-31, build 1.1.10 (10001)
came from an Xcode 26 runner without the Duo layout, and the owner's iPhone Duo
lost the Duo layout until the next build. With two apps, only the Beta app gets
a bad Beta build. The normal app keeps working.

T3 Code does the same: "T3 Code" and "T3 Code Preview" are two apps with
different bundle IDs and icons (`apps/mobile/app.config.ts` in
pingdotgg/t3code).

## Decisions

1. **Name: "ADE Beta".** T3 says "Preview", but ADE uses "Stable" and "Beta"
   as the only track names (see `beta-track.md`), so "ADE Beta" keeps one
   word for one thing. The icon is the orange Beta icon, like the desktop Beta
   build (`AppIconBeta`).
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
| A beta with iOS changes (CI) | ADE Beta | Internal Testers, Public Beta (after Apple's beta review) |
| A stable release with iOS changes (release skill) | ADE | Internal Testers, Friends, Public Beta |

Before this, a stable release gave a beta's build to more groups. Now CI
builds only the Beta app, and the release skill builds "ADE" from the stable
commit with `ios-testflight.sh`, as it already did for stable releases.

## Work

### iOS project (`apps/ios`)

- A `Beta` build configuration (a copy of `Release`) on every target. On the
  app and the widgets it sets:
  - `PRODUCT_BUNDLE_IDENTIFIER`: `com.ade.ios.beta`, `com.ade.ios.beta.widgets`.
  - `ADE_APP_DISPLAY_NAME` "ADE Beta" and `AppIconBeta` (Info.plist reads
    both; Debug and Release keep "ADE" and `AppIcon`).
  - `ADE_URL_SCHEME` `ade-beta`. `DeepLinkRouter` routes `ade-beta://` links
    like `ade://` ones. Widget and notification links still say `ade://`;
    iOS gives those to the app that owns the widget or notification.
  - `ADE.Beta.entitlements` and `ADEWidgets.Beta.entitlements`: push, Sign in
    with Apple, `webcredentials:clerk.ade-app.dev`, app group
    `group.com.ade.ios.beta`. No `applinks` and no App Clip entries.
  - `EXCLUDED_SOURCE_FILE_NAMES = ADEClip.app`, so the App Clip is not
    embedded.
  - The Swift flag `ADE_BETA_APP`. `ADESharedContainer` picks the app group
    with it. `ClipPairingHandoff` keeps the normal app's group; the Beta app
    has no App Clip to hand off from.
- The App Store update check needs no change: it looks up the app's own
  bundle ID, and the App Store has no `com.ade.ios.beta`.
- `release_channel` (Sentry tag and PostHog property) is "beta" in the Beta
  app and "stable" in the normal app, on TestFlight too. Sentry release names
  already differ by bundle ID.
- Push needs no relay change: the app sends its own bundle ID, and the relay
  already sends to each device's own bundle ID (`apps/push-relay`, including
  Live Activities).

### Machines

- The brain already gets the app's bundle ID in hello. Show "ADE Beta" next
  to that phone in the paired device list, so two entries for one phone make
  sense.

### CI and release

- `ios-testflight.yml` and `ios-testflight-ci.sh` build only the Beta app:
  the `Beta` configuration, the app found by bundle ID, Internal Testers and
  Public Beta, and the tag `ios-beta-v<mv>-build<n>`. The gate counts iOS
  changes since the newest `ios-beta-v*` tag.
- The stable release: unchanged, `ios-testflight.sh` builds "ADE" when
  `scope.sh` finds iOS changes since the last `ios-v*` tag. The release skill
  says so.

### Owner steps (once)

1. Create the app record "ADE Beta" (bundle ID `com.ade.ios.beta`, SKU
   `ADE-IOS-BETA`) in App Store Connect. The API key cannot create an app;
   only the website (or `asc web` with an Apple ID) can.
2. In Clerk (Production): add the iOS app `VQ372F39G6` /
   `com.ade.ios.beta` under Native applications, and allow the redirect
   `com.ade.ios.beta://callback` (ClerkKit's default OAuth redirect, the
   bundle ID plus `://callback`).
3. Nothing else by hand. The first Public Beta build goes to Apple's beta
   review by itself.

Done with the API key on 2026-11-01: the bundle IDs `com.ade.ios.beta` and
`com.ade.ios.beta.widgets` with push, Sign in with Apple, app groups and
associated domains. The normal app's ID also has time-sensitive
notifications, but no entitlements file asks for it, so the Beta IDs do
without (the API cannot set it). After step 1: the
"Internal Testers" and "Public Beta" groups and the test information.

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
