# DAEX Cloud iPhone

An iOS Simulator that runs in the cloud for the DAEX account, not on one of the
person's machines. Two providers run it behind one shape, NoMac (nomac.app) and
Revyl (revyl.ai): same commands, screen text, steps and pane, with a few
abilities that differ (see **Providers**). Any machine (Windows, Linux, Mac, a
DAEX Cloud computer) drives it with the same `daex apple` commands it uses on a
Mac's simulator. The desktop tools pane shows it in 3D or flat, DAEX Web as a
flat live view, and the DAEX iPhone app from a chat's Tools menu.

It is an account-wide feature: the account server holds the provider keys,
access, credits and limits; clients only show the answer.

## Source file map

| Path | Role |
|---|---|
| `apps/account-directory/src/cloud/phones.ts` | Server routes `/cloud/phone*`, credits and the money guard. |
| `apps/account-directory/src/cloud/phoneProvider.ts`, `phoneNomac.ts`, `phoneRevyl.ts` | One record per provider; the only places that hold provider keys. |
| `apps/account-directory/src/cloud/phoneRoute.ts` | Provider order (`routeOf`), failover (`startOnRoute`), build-gap routing. |
| `apps/account-directory/src/cloud/phoneViewerPage.ts`, `phoneBeta.ts` | Revyl's viewer page; the beta list and its owner route. |
| `apps/account-directory/src/cloud/credits.ts` | Credit rate (`PHONE_CREDIT_MILLI_PER_MINUTE`) and charging. |
| `apps/account-directory/src/cloud/contract.ts`, `apps/desktop/src/shared/cloudPhone.ts` | Shared shapes, `CLOUD_PHONE_PROVIDER_ABILITIES`, idle and max-time constants. |
| `apps/desktop/src/main/services/adeCloud/cloudPhoneService.ts` | The brain's `cloud_phone` action domain; holds one phone token in memory. |
| `apps/desktop/src/main/services/adeCloud/cloudPhoneDriver.ts`, `cloudPhoneNomacDriver.ts`, `cloudPhoneRevylDriver.ts`, `cloudPhoneScreenText.ts` | One driver per provider; the screen as text. |
| `apps/desktop/src/main/services/adeCloud/cloudPhoneRun.ts`, `cloudPhoneViewHost.ts` | Run bookkeeping and chat notices; the offscreen window that paints the provider's page for the desktop pane. |
| `apps/ade-cli/src/cliCloudIphone.ts`, `cliDevices.ts` | `daex apple` verbs as `cloud_phone` actions; the `ios@cloud` device row. |
| `apps/desktop/src/renderer/components/apple/CloudIphonePanel.tsx`, `useCloudPhoneFrames.ts`, `apps/desktop/src/renderer/state/cloudPhoneLive.ts` | The tools pane, its frames, and the live state the pane and top bar share. |
| `apps/ios/ADE/Services/SyncService+CloudPhone.swift`, `apps/ios/ADE/Views/Cloud/CloudPhoneSheet.swift` | The iPhone app's sheet. |

## Gotchas / fragile areas

- **Provider keys are Worker secrets.** `NOMAC_API_KEY` and
  `REVYL_PARTNER_API_KEY` never reach a brain, CLI or renderer.
- **One phone per account.** Every chat that picked `ios@cloud` drives the same
  phone. Every command starts a phone (reads too), idle minutes count, and a
  phone stops after 5 idle minutes (`CLOUD_PHONE_IDLE_SECONDS`) or 2 hours
  (`CLOUD_PHONE_MAX_MINUTES`). Batch work.
- **`keepAlive` never starts a phone.** A brain without the token sends
  `attach`, which answers 409 `phone_not_running`.
- **Older brains** (before 1.2.131) have no `cloud_phone` domain. Clients say to
  update DAEX on that machine (`isCloudPhoneMissingAnswer`), never that the
  account lacks the phone.
- **Provider names never reach users.** Every answer passes through
  `withoutPhoneProviderNames`; differences are reported as abilities.
- **Xcode 27.0 and 27.1 ship the same Swift (6.4)**, so `#if compiler(>=6.4)`
  cannot fence iOS 27.1 APIs on Revyl's 27.0 runner. The DAEX iOS app also
  gates them on `!ADE_IOS_SDK_27_0`.
- **Every provider, both surfaces.** Agents reach the phone only through
  `daex apple`, so all 13 agent providers (chat and CLI) drive it the same way.
  There is no provider-specific phone code.

## Access

The Worker var `CLOUD_PHONE_ACCESS` decides who has it, with no app release:

- `beta` (default): only accounts on `cloud_phone_beta` (one row per `user_id`).
  Others read `access: "soon"`, and start/view calls answer 403
  `phone_not_on_account`. Removing an account from the list stops its phone.
- `all`: every account reads `access: "on"`; plan rules still apply.
- `off`, or `NOMAC_API_KEY` unset: `access: "off"`, calls answer 503, and the
  ten-minute check stops running phones. `DELETE /cloud/phone` always works.
- `CLOUD_PHONES_PAUSED=1` refuses new phones (503 `phone_paused`).

In DAEX, the iPhone tool's "Runs on" row shows the "DAEX Cloud" chip only with
access (else "DAEX Cloud soon"). Picking it equals `daex devices use ios@cloud`.

Manage the beta list with `scripts/cloud-owner.mjs phone <account> on|off`
([account-test-tool.md](../ade-cloud/account-test-tool.md)), or the owner route
`POST /cloud/owner/phone-beta` with `Authorization: Bearer <CLOUD_OWNER_TOKEN>`
and `{ email? | userId?, enabled? }` (`{}` lists the list). It is matched before
the account sign-in.

## Credits and the money guard

The phone draws from the account's one credit balance at one credit a minute
(`PHONE_CREDIT_MILLI_PER_MINUTE`): plan credits, then earned ones, then extra
credits when that switch is on. Out of credits with extra off, a start answers
402 `phone_credits_out`. A phone start runs the free-plan checks itself.

- Every phone is a `cloud_phones` row: billed seconds and cost, live or ended,
  free rules or not, counted in the period it started in. NoMac's signed webhook
  (`POST /cloud/nomac/webhook`, `NOMAC_WEBHOOK_SECRET`) settles rows and
  recovers a phone whose start answer was lost (by its `ade:<userId>` label).
  The ten-minute check re-reads every live phone.
- **Charging:** billed minutes go into `used_milli` in the same write as the row
  (`phoneCreditStatements`); `credited_milli` makes repeats add nothing. A
  running phone's unbilled time counts in the balance (`unsettledPhoneMilli`).
- **Period change:** a phone from the old period stops; its time is charged to
  the period that ends (`startFreshPeriod`).
- **The guard:** every NoMac phone starts with a spend cap and time limit equal
  to what the account may still use. When that shrinks (extra off, a computer
  using credits, new period, access removed, account blocked),
  `enforcePhoneAllowance` stops the phone or sets `stop_at`; the minute tick
  stops it then (`stopPhonesDue`). DAEX never pays a provider for a minute
  nobody pays for.
- **Free-use cap:** a free-plan start is refused (503, unexplained) once the
  month's free use reaches the owner's cap.
- **Agents:** people and attended chats use it freely within credits. Unattended
  agents (full-auto chat, automation, DAEX MCP app) only when the agent limits
  allow spending (`unattendedSpend`); plan-mode chats never. The RPC server
  stamps the caller on `CLOUD_PHONE_SPEND_ACTIONS`; `cloudPhoneAgentGuard` in
  `registry.ts` checks it.
- **What agents read:** `daex cloud status` carries `credits`, `iphone` (access,
  credits used, reset day) and `plans`. Off a Mac, the `daex-apple` skill shows
  only while the account has the iPhone (`refreshIphoneSkill` in
  `cloudAccess.ts`, cached 10 minutes).
- **Warnings and owner:** credit emails at 80%, 95% and out. Phone cost counts in
  the owner's monthly estimate and alerts. Blocking an account stops its phone.
  Analytics event: `ade_cloud_phone` (`started`, `ended`, `refused`).

## Providers

- **Order** (`routeOf`): NoMac first; Revyl only on a paid plan, as fallback when
  NoMac definitely refuses, and only when `CLOUD_PHONE_REVYL=on`. A free plan's
  refused start answers 503 `phone_busy`. A lost answer (5xx, timeout) is never
  retried elsewhere. Only providers this client can drive count (the brain names
  them in `providers` on `POST /cloud/phone`).
- **A tester's pick.** A beta account may pick `auto`, `nomac` or `revyl` for all
  its phones (beta-build toggle or `daex cloud phone-provider`; stored on the
  beta row, `POST /cloud/phone/provider`). A pick is the only provider tried
  (503 when it cannot start, 409 `phone_needs_update` when the client cannot
  drive it). Each phone row keeps its `provider`, so a running phone is never
  switched.
- **Abilities, not names** (`CLOUD_PHONE_PROVIDER_ABILITIES`): NoMac has `tests`,
  `uninstall`, `storekit`, `locale`, `timezone`, `statusBar`, `launchEnv`; Revyl
  has `perf` (`daex apple perf`), `shake`, `orientation`. `GET /cloud/phone`
  returns `abilities`; the brain's status adds `lacks`. A missing ability answers
  "This cloud iPhone can't X." (409 `phone_lacks`). `needs` never picks the
  provider.
- **Shared code.** The server owns credits, `stop_at`, the ticks, the allowance,
  the beta list and deletion. `cloudPhoneService.ts` owns start and wait,
  argument checks, packing, proof filing and chat notices, and retries once on
  a fresh phone after `CloudPhoneGoneError`. A driver owns only how one provider
  is driven.
- **NoMac.** The brain holds a per-phone token (`nmp_…`, 2 hours, cannot start,
  list or stop phones, never logged) and calls NoMac's tools directly.
- **Revyl.** Each account gets its own Revyl workspace (`ade-<userId>`, a
  synthetic `revyl+<hash>@ade-app.dev` address, never the person's email). No
  per-phone token: the brain calls `POST /cloud/phone/call {action, body?,
  query?}` with its account sign-in (`proxy.<name>` allowlist and
  `build.upload_url|start|status|logs|install`). The driver turns the
  accessibility tree into the same screen text as NoMac and acts with plain
  taps (never Revyl's AI-priced targeting). Builds run on Revyl's runners
  (`ios-macos-26-xcode-27.0`, 900 s timeout). The recording id is kept on the
  row (`recording_ref`) so any brain can stop it. Revyl has no time limit of its
  own: `stop_at` is set at start and the minute tick stops it.
- **Build tools a provider lacks** (`CLOUD_PHONE_BUILD_NEEDS`, today `metal`).
  NoMac's hosts lack Apple's Metal Toolchain. A brain whose build failed for it
  reports `missing { phoneId, need }` on its next start; the server records it
  per provider (`recordBuildGap`, `cloud_phone_build_gaps`) for a day
  (`CLOUD_PHONE_BUILD_GAP_MS`), only for the reporter's own recent phone. A start
  naming `builds: ["metal"]` then skips that provider (`routeForBuilds`) and
  swaps a live phone. A free plan is told before any minute is spent (402
  `phone_needs_paid`); with no provider left, 409 `phone_build_unavailable`. The
  brain names `metal` for a project with a `.metal` file or a past Metal build
  (`metalProjects`, in memory). Revyl's build step (`buildCommand` in
  `phoneRevyl.ts`) downloads the toolchain and retries when needed. `test` is
  never moved (Revyl has no tests).
- **Revyl's pane** is DAEX's own viewer page,
  `<server>/cloud/phone/viewer#whep=…&ws=…`: Revyl's WebRTC video with a clear
  canvas for touches; input goes over Revyl's socket, keys batched every 25 ms.
  The links stay after `#` so no server log sees them.

## Architecture

```
tools pane (CloudIphonePanel)   CLI (daex apple …)   any provider's agent
              \                         |                   /
     cloud_phone action domain on the machine's brain (cloudPhoneService)
                                  |
          account server /cloud/phone* (phones.ts, phoneRoute.ts)  <- provider keys
                                  |
                          NoMac or Revyl
```

- **Brain.** `cloud_phone` actions: `getStatus`, `start`, `stop`, `look`, `act`,
  `screenshot`, `launch`, `installApp`, `control`, `logs`, `record`, `runTests`,
  plus `view` and `keepAlive` for the pane. `getStatus` carries
  `lastActivityAt` (this brain's last call) for the idle countdown. When an agent
  chat's call starts a phone, that chat gets one notice, and another when the
  phone is found ended (`cloudPhoneRun.ts`).
- **CLI.** `cliCloudIphone.ts` maps each `daex apple` verb to one `cloud_phone`
  action on this machine's brain.
- **Desktop pane.** `cloudPhoneViewHost.ts` paints the provider's control page
  in an offscreen window and streams the cropped canvas as JPEG; input goes
  through that page's debugger (`Input.dispatch*`), because `sendInputEvent`
  lands off target on a scaled display. Frames are sent only on change plus one
  keyframe a second, and a still page paints at 4 fps. Measured on Windows (the
  perf baseline points here): idle 17.5% of a core before that change, 8.5%
  after, 2.3% with the pane closed.
- **DAEX Web** has no main process, so its pane is an iframe of the provider's
  view (no rail, no 3D). Desktop reaches `cloud_phone` by its runtime pin; web
  through `cloudPhone.*` sync commands on the chat's machine.
- **Running strip and top bar** share `renderer/state/cloudPhoneLive.ts`: model,
  time on, credits left, idle countdown (Keep on in the last 90 s). The pane
  reads every 30 s while running; the top bar on focus, every 30 s while
  running, every 2 minutes otherwise, never while hidden. The countdown is the
  earliest stop, since another machine may use the phone.
- **iPhone app.** Tools › DAEX Cloud iPhone opens a sheet over `cloudPhone.*`
  on the chat's machine, with a sandboxed web view of the player (only the
  provider's origin loads). No Record.

## CLI

```bash
daex devices use ios@cloud          # this chat's iPhone (refused without access)
daex devices                        # lists ios@cloud with the credits left
daex apple launch --machine cloud   # one command on the phone
```

- `start [--device iphone|iphone-pro-max|ipad]`, `stop`, `status` (lists
  abilities and this period's phones under `recent`).
- `snapshot`, `tap-element --label/--id [--hold-ms]`, `tap x y`,
  `long-press x y`, `type "text" [--submit]`, `key return|escape|delete|tab|space`,
  `swipe`/`scroll`, `button home`, `wait-for-element` (up to 30 s).
- `screenshot [--out]` files a PNG to proof (`--no-proof` skips; `--out` must be
  inside the project or temp folder). `record start|stop` answers an MP4 link
  valid 7 days.
- `launch [--path sub] [--scheme] [--configuration] [--env] [--clean]` packs this
  checkout and builds it there. With no `--path`, the project is found where a
  Mac's launch looks (`discoverXcodeProjectPaths`, `cloudPhoneBuildFolder`); two
  or more candidates, or none, is refused before upload. Launch arguments after
  `--` are refused on a build: build, then `relaunch --bundle-id B -- …`.
- `install --app <Simulator .app> [--no-launch]` uploads an app built elsewhere
  (Expo/EAS with `"simulator": true`, Flutter `--simulator`).
- `open-url`, `logs [--grep] [--since] [--wait-for] [--crashes]`,
  `test [--scheme] [--only]`.
- `act "<step>" …` sends steps in the screen's words: `tap "Label"`, `tap #id`,
  `fill #id text`, `scroll down`, `hold "X" 2`, `wait "Text" 10`, `gone "Text"`.
- `control <action> [value] [--app]`: launch, terminate, uninstall, open_url,
  grant, revoke, reset_permissions, location, push, storekit, appearance,
  locale, timezone, text_size, status_bar.

iPad windows, the Duo, leases and device settings are refused with one
sentence. The screen reads as one element per line, `kind "label" #id state @x,y`
in points.

## Security

- Provider keys exist only as Worker secrets.
- **View link.** `POST /cloud/phone/view` answers a 2-hour link. With
  `NOMAC_EMBED_SECRET` (`nme_…`) every link is also signed for the account
  (HS256, 10 minutes). The desktop view accepts only the provider's view URL,
  uses an in-memory partition, denies navigation and window opens, and never
  logs the URL.
- **What never goes up.** `launch` and `test` pack
  `git ls-files -co --exclude-standard` minus build output, dependency folders
  (`Pods/`, `node_modules/`, `DerivedData/`, `build/`, `.build/`, `.swiftpm/`,
  `.ade/`, …) and key files: `.env*` (except `.example`, `.sample`,
  `.template`), `*.p8`, `*.p12`, `*.pfx`, `*.pem`, `*.key`, provisioning
  profiles, keystores, SSH keys and `.netrc`.

## Limits

- Three models: iPhone 17 Pro (default), iPhone 17 Pro Max, iPad Pro 11-inch
  (M5), iOS 27, US hosts. iOS only.
- Upload at most 2 GB packed. NoMac keeps the account's workspace 48 hours after
  last use; a stop removes the phone's apps but keeps the project and build
  cache.
- NoMac allows 20 phones at once across all accounts; past that a start queues
  and gives up after 6 minutes ("No cloud iPhone was free…").
- Builds are Xcode projects only (Swift/ObjC, SwiftPM, CocoaPods from
  `Podfile.lock`, XcodeGen). Other stacks upload a Simulator build with
  `install --app`.
- Typical speed: most commands 0.5–4 s, a new phone 8–13 s, first launch on a
  new phone 11–21 s.

## Operating it

Secrets (`wrangler secret put …`, again with `--env production`):
`NOMAC_API_KEY` (required; unset means status `off` and 503 elsewhere),
`NOMAC_EMBED_SECRET` (optional), `NOMAC_WEBHOOK_SECRET`,
`REVYL_PARTNER_API_KEY` (with `CLOUD_PHONE_REVYL=on`), `CLOUD_OWNER_TOKEN`.

Phone tables come from migrations `0047_cloud_phone_beta`,
`0048_cloud_phone_usage`, `0057_cloud_phone_provider`,
`0060_cloud_phone_choice_reset` and `0070_cloud_phone_build_gaps`. Apply them
before the Worker that reads them (the production deploy script does):

```bash
npx wrangler d1 migrations apply DB --remote --env production
```

**Deleting an account.** Clerk's `user.deleted` runs `deleteAccountPhone`: it
stops the account's phones, asks the provider to forget what it kept for the
label, and removes the beta row. Billing records stay under the label (an id,
never an email). `accountErasure.ts` repeats it.
