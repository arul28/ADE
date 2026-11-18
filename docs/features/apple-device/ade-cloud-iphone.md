# ADE Cloud iPhone

An iOS Simulator that runs at NoMac (nomac.app) for the ADE account, not on a
machine of the person's. Any machine drives it with the same `ade apple`
commands it uses on a Mac's simulator: a Windows PC, a Linux box, a Mac, or an
ADE Cloud computer. The Work tools pane shows it in 3D or flat on the desktop;
ADE Web shows the same pane as a flat live view, and the ADE iPhone app shows it
from a chat's Tools menu. The launch plan is `docs/plans/ade-cloud-iphone-launch.md`.

Server: `apps/account-directory/src/cloud/phones.ts` (routes, minutes, the
guard, beta list) and `phoneBilling.ts` (extra minutes to Stripe). Brain: `apps/desktop/src/main/services/adeCloud/cloudPhoneService.ts`.
CLI: `apps/ade-cli/src/cliCloudIphone.ts`. Shapes:
`apps/account-directory/src/cloud/contract.ts` and
`apps/desktop/src/shared/cloudPhone.ts`.

## Access

The Worker var `CLOUD_PHONE_ACCESS` decides who has it, with no app release:

- `beta` (the default): only accounts the owner adds to `cloud_phone_beta`
  (migration `0045_cloud_phone_beta.sql`; one row per `user_id`, with the
  `email` the owner typed). Everyone else reads `access: "soon"`, and start
  and view calls answer 403 `phone_not_on_account`. Taking an account off the
  list stops its running phone.
- `all`: every account reads `access: "on"`. The plan rules below still apply.
- `off`, or `NOMAC_API_KEY` unset: `access: "off"`, and calls answer 503;
  the ten-minute check stops phones still running. Stopping your own phone
  (`DELETE /cloud/phone`) works whatever the access.
- `CLOUD_PHONES_PAUSED=1` refuses new phones (503 `phone_paused`); running
  ones finish.
- In ADE, the iPhone tool's "Runs on" row shows the "ADE Cloud" chip only for
  an account with access; otherwise the row keeps its "ADE Cloud soon" note.
  Picking the chip is the chat's device choice, the same as
  `ade devices use ios@cloud`; `ade devices` lists the `ios@cloud` row only
  with access.

## Minutes and the money guard

Each plan includes `phoneMinutes` a billing period (`src/cloud/plans.ts`: Free
60, Plus 80, Pro 300, Max 800). A free plan held by the free-plan checks (one
per computer, a too-new GitHub account) gets 0, as with free hours, and a start
answers 402 `phone_free_held`. A phone start settles those checks itself, as a
computer's start does, once the account may use the phone at all
(`routePhone`), so calling the phone route alone can't skip them.

- Every phone is a `cloud_phones` row (migration `0046_cloud_phone_usage.sql`):
  NoMac's billed seconds and cost, live or ended, and whether the account was on
  free rules, counted in the period it started in. NoMac's signed webhook
  (`POST /cloud/nomac/webhook`, `NOMAC_WEBHOOK_SECRET`) settles rows this Worker
  made (another environment's phones are left alone); a delivery whose work
  fails is given back, so NoMac's retry is done. The ten-minute check reads
  every live phone again, so a missed delivery can't leave one counted forever.
  Used minutes are the period's billed minutes plus the running phone's time so
  far (two hours at most). The account read (`CloudAccountState.phone`) is D1
  only.
- **Free plan:** stops at its minutes (402 `phone_minutes_out`). There is no
  pay as you go on Free; a card saved for the free-hours check is never charged.
- **Paid plans:** "Extra iPhone minutes" is its own switch in Settings › ADE
  Cloud (beside Extra Linux hours and Extra Linux disk), with a monthly limit or
  none (`POST /cloud/billing/extra-phone`). Off, the phone stops at the plan's
  minutes. On, it keeps going at 2.5¢ a minute (`EXTRA_PHONE_MINUTE_CENTS`) up
  to the limit (402 `phone_extra_limit` there). The ten-minute check reports the
  settled minutes past the plan to Stripe's meter (`STRIPE_PHONE_METER_EVENT`,
  price `STRIPE_PHONE_MINUTE_PRICE_ID` from `scripts/stripe-setup.mjs`), each
  report identified by where it starts (the minutes already sent): a crash
  after Stripe took one resends the same identifier, which Stripe drops, so a
  minute is never billed twice (at worst a few go unbilled). Minutes used under
  the settings before a change stay owed: turning the switch off, or lowering
  the limit, stops further use and never erases a minute already used
  (`phoneBilling.ts`).
- **Period changes:** a renewal, a cancel, a failed payment or going free starts
  a new period while minutes of the old one may still settle. A phone from the
  old period stops (the ten-minute check, or a new start). The old period's
  extra minutes are billed after it ends, once none of its phones runs, at its
  own plan's minutes (`phone_extra_included`, never fewer than the plan bought
  now), so a downgrade at the renewal can't bill minutes the old plan included.
  When a plan ends or its payment fails, extra minutes become "was on"
  (`phone_extra_enabled = 2`): no new minute uses them, the ended period is
  still billed for them, then they turn off, so buying a plan again never turns
  them on by itself. A `past_due` account is billed once it pays (or its plan
  ends).
- **The guard:** every phone starts with NoMac's spend cap and time limit set
  to what the account may still use (the plan's minutes left, then extra
  minutes left, two hours at most), so a phone stops by itself there. NoMac
  can't lower a running phone's limits, so when what the account may use
  shrinks (extra minutes off, a lower limit, a new period, access removed, the
  account blocked), `enforcePhoneAllowance` stops the phone at once if nothing
  is left, or sets its `stop_at` to when its minutes run out; the minute tick
  stops it then (`stopPhonesDue`). The ten-minute check runs the same for every
  live phone. ADE never pays NoMac for a minute nobody pays for.
- **Free-use cap:** a free-plan phone start is refused (503, never naming why)
  once the month's free use reached the owner's cap, as a free computer is.
- **Agents:** a person and an attended chat use the phone freely within the
  minutes. An agent nobody watches (full-auto chat, automation run, ADE MCP
  app) uses it only when the agent limits let agents spend (`unattendedSpend`,
  the same switch as hours); a plan-mode chat never. The RPC server stamps who
  is asking on the spending `cloud_phone` actions (`CLOUD_PHONE_SPEND_ACTIONS`);
  `cloudPhoneAgentGuard` in `registry.ts` checks it.
- **What agents read:** `ade cloud status` carries `iphone` (access, minutes,
  reset day, extra minutes) and `plans` (each plan's price, hours, disk, iPhone
  minutes and prices past the plan), so an agent answers plan and minutes
  questions from one read. On a machine that isn't a Mac, the `ade-apple` skill
  is shown only while the account has the iPhone (`refreshIphoneSkill` in
  `cloudAccess.ts`, cached 10 minutes like ADE Cloud's own access); on a Mac it
  always shows (its own simulators).
- **Warnings:** an email at 80% and one when the minutes run out, once each a
  period; the wording says whether extra minutes keep the phone going. Settings
  shows the minutes and the extra-minutes card.
- **Owner:** the phones' NoMac cost counts in the month's cost estimate, in
  the alerts' top accounts and, for free-plan phones, toward the free-use cap.
  Blocking an account stops its phone. NoMac's `credit.low` emails the owner. Analytics: `ade_cloud_phone` (`started`, `ended`, `refused`).

## Architecture

```
tools pane (CloudIphonePanel)     CLI (ade apple …)     any provider's agent
              \                         |                        /
        cloud_phone action domain on the machine's brain (cloudPhoneService)
                                  |
                 server /cloud/phone* (phones.ts)  <- NOMAC_API_KEY
                                  |
                        NoMac (nomac.app)  <- one simulator per ADE account
```

- **Server.** `phones.ts` is the only place that holds the NoMac account key. It
  checks the beta list, reads the period's billed seconds from NoMac, starts or
  reuses the account's phone, and mints the short-lived token a brain drives it
  with. `routes.ts` checks the account sign-in; `safety.ts` checks the owner
  token on the beta-list route.
- **Brain.** `cloudPhoneService.ts` exposes the `cloud_phone` action domain
  (`getStatus`, `start`, `stop`, `look`, `act`, `screenshot`, `launch`,
  `installApp`, `control`, `logs`, `record`, `runTests`, and `view` for the
  pane). It holds one phone's token in memory and calls NoMac's tools directly:
  the screen as text, input, screenshots, logs, recordings, builds and tests.
- **CLI.** `cliCloudIphone.ts` turns each `ade apple` verb into one
  `cloud_phone` action on this machine's brain. `cliDevices.ts` adds the
  `ios@cloud` row and the `ade devices use ios@cloud` choice.
- **Tools pane.** `CloudIphonePanel.tsx` shows minutes left, Start/Stop, and the
  phone in 3D (ADE's device body) or Flat. `useCloudPhoneFrames.ts` holds the
  picture; `cloudPhoneViewHost.ts` paints NoMac's control page in an offscreen
  window in the desktop main process and streams the cropped canvas as JPEG.
  Taps, drags, scrolls and keys go to that page through its own debugger
  (`Input.dispatch*`, CSS pixels): `sendInputEvent` lands off target on a
  scaled display. A frame is sent only when the picture changed past H.264
  noise, plus one keyframe a second; after 2 s of a still picture the page
  paints at 4 fps until it changes or input arrives (idle cost measured on
  Windows: 17.5% of a core before, 8.5% after; 2.3% with the pane closed).
  ADE Web has no main process to paint the page, so its pane skips the rail and
  puts NoMac's own view in an iframe at the phone's aspect ratio. Both clients
  reach the same `cloud_phone` domain: the desktop through its runtime pin, the
  web through the `cloudPhone.*` sync commands on the chat's machine. The
  chat's agents drive the phone with `ade apple` from every client.
- **ADE iPhone app.** A Work chat's ⋯ › Tools › ADE Cloud iPhone (also the Duo
  and iPad Tools rails) opens a sheet over the same `cloudPhone.*` commands,
  sent to the chat's machine: minutes left, Start and Stop, why it ended, and
  the live phone in a sandboxed web view of NoMac's player (only
  `https://nomac.app` may load), with Screenshot. Status is read every 3 s
  while starting, every 20 s while off, every 30 s while live (so a phone that
  stopped by itself shows Start again).
  (`apps/ios/ADE/Services/SyncService+CloudPhone.swift`,
  `apps/ios/ADE/Views/Cloud/CloudPhoneSheet.swift`)
- **Every provider.** Agents reach the phone only through `ade apple`, so all 13
  providers, chat and CLI, drive it the same way. There is no provider-specific
  phone code.

## Request flow

1. `ade devices use ios@cloud` makes the chat's iPhone the cloud one (or one
   command takes `--machine cloud`). `ade apple status` reads
   `cloud_phone.getStatus`: `on`, the minutes, the live phone, and
   `capabilities`.
2. Any command that needs the phone starts it when none runs. The brain sends
   `POST /cloud/phone`; the server checks the list and the minutes, asks NoMac
   for a session labelled `ade:<userId>` (reusing a live one), sets the idle
   timeout, the 2-hour ceiling and the spend cap, and answers the phone plus a
   token and NoMac's tool base.
3. The brain waits up to 6 minutes for `ready`, then calls the phone's tools.
   `look` reads the screen as text; `act` sends the same words as steps;
   `launch` packs this checkout, uploads it, unpacks only what changed into the
   account's workspace, and builds it there with Xcode 27.2. A small app's first
   build takes about 11 s; the next, about 4 s.
4. `screenshot` downloads a full-size PNG to `--out` (inside the project or the
   temp folder; any other path is refused) or a temp file, and files
   it in the proof drawer with the caption "ADE Cloud iPhone screenshot";
   `--no-proof` skips that. The tool's own link to the file lasts 7 days, as a
   recording's MP4 does.
5. The desktop pane asks for a view link (`POST /cloud/phone/view`, a control
   link by default), keeps it fresh a minute before it expires, and sends taps,
   scroll and keys back in device points.
6. `ade apple stop` (or the pane's Stop) ends the phone. Its apps and their data
   go; the project and its build cache stay for the next one.

## CLI

```bash
ade devices use ios@cloud          # this chat's iPhone (refused without access)
ade devices                        # lists ios@cloud with the minutes left
ade apple launch --machine cloud   # one command on the phone
```

`status` lists the phone's capabilities; every other verb is one `cloud_phone`
action on this machine's brain:

- `start [--device iphone|iphone-pro-max|ipad]`, `stop`, `status`.
- `snapshot [--find]` reads the screen; `tap-element --label/--id [--hold-ms]`,
  `tap x y` and `long-press x y [--duration-ms]` press it.
- `type "text" [--submit]`, `key return|escape|delete|tab|space` (no
  shortcuts), `swipe`/`scroll up|down|left|right [--label/--id]`,
  `button home`, and `wait-for-element --label/--id --timeout-ms` (up to 30 s).
- `screenshot [--out]` files a PNG to the proof drawer (`--no-proof` skips it;
  `--out` must be inside the project or the temp folder);
  `record start|stop` answers an MP4 link valid 7 days.
- `launch [--path sub] [--scheme] [--configuration] [--env] [--clean]` packs
  this checkout and builds it there; `launch --no-build --bundle-id B [-- …]`,
  `relaunch --bundle-id B [-- …]` and `terminate --bundle-id B` use an app
  already on the phone. `install --app <path to a Simulator .app>
  [--no-launch]` uploads and installs an app built elsewhere (Expo/EAS with
  `"simulator": true`, React Native, Flutter `--simulator`); `install` with no
  `--app` builds this checkout like `launch`.
- `open-url URL`, `logs [--grep] [--since] [--wait-for] [--crashes]`, and
  `test [--scheme] [--only]`.
- `act "<step>" …` sends the screen's own words as steps: `tap "Label"`,
  `tap #id`, `fill #id text`, `type text`, `scroll down`, `swipe left "Row"`,
  `hold "X" 2`, `set #slider 50`, `back`, `home`, `key return`,
  `wait "Text" 10`, `gone "Text"`.
- `control <action> [value] [--app]`: `launch`, `terminate`, `uninstall`,
  `open_url`, `grant`, `revoke`, `reset_permissions`, `location`, `push`,
  `storekit`, `appearance`, `locale`, `timezone`, `text_size`, `status_bar`.

Anything else (iPad windows, the Duo, leases, device settings) is refused with
one sentence. The screen reads as text: one element per line,
`kind "label" #id state @x,y`, in points.

## Security

- **Key custody.** The NoMac account key (`NOMAC_API_KEY`, `nmk_…`) exists only
  as a Worker secret. It is never sent to a brain, a CLI or a renderer.
- **Phone token.** A brain gets a token for one phone (`nmp_…`, 2 hours). It can
  drive that phone and cannot start, list or stop phones. The brain keeps it in
  memory and never logs it.
- **View link.** `POST /cloud/phone/view` answers a NoMac link with 2 hours. With
  `NOMAC_EMBED_SECRET` set (`nme_…`), every link is also signed for the
  account's label (HS256, 10 minutes), so a copied link opens nothing. The
  desktop view accepts only `https://nomac.app/simulator-use/view/…`, paints it
  in an in-memory partition, denies navigation and window opens, and never logs
  the URL.
- **What never goes up.** `launch` and `test` pack what git tracks or would
  track in the checkout (`git ls-files -co --exclude-standard`, gitignore kept),
  minus build output, dependencies, version control and key files: `.env*`
  (except `.example`, `.sample`, `.template`), `*.p8`, `*.p12`, `*.pfx`, `*.pem`,
  `*.key`, `*.mobileprovision`, `*.provisionprofile`, `*.keystore`, `*.jks`,
  `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519` and their `.pub`, and `.netrc`.
  `Pods/`, `node_modules/`, `DerivedData/`, `build/`, `.build/`, `.swiftpm/`,
  `.ade/` and the other dependency folders are skipped whole.

## Limits

- One phone per account: every chat that picked `ios@cloud` drives the same
  phone, and every lane of an account shares the plan's minutes.
- A phone stops after 5 minutes with no tool call or person's input, and runs at
  most 2 hours. A new one starts after that; the workspace stays.
- Three models: iPhone 17 Pro (default), iPhone 17 Pro Max, and iPad Pro
  11-inch (M5), on iOS 27, on US hosts. iOS only: there is no Android here.
- The upload is at most 2 GB packed. NoMac keeps the account's workspace for 48
  hours after its last use, then deletes it.

## Operating it

**Secrets** (`wrangler secret put …`, and again with `--env production`):

- `NOMAC_API_KEY` (`nmk_…`) is required. Unset, the status read answers `off`
  and the other phone routes answer 503 "not set up".
- `NOMAC_EMBED_SECRET` (`nme_…`) is optional. It signs every view link for the
  account; without it the link itself is the permission (2 hours, that phone
  only).

**Migration.** Apply `0045_cloud_phone_beta.sql` and `0046_cloud_phone_usage.sql`
before the Worker that reads them
deploys (the production deploy script does):

```bash
npx wrangler d1 migrations apply DB --remote --env production
```

**The owner route.** `POST /cloud/owner/phone-beta` takes
`Authorization: Bearer <CLOUD_OWNER_TOKEN>` (secret; unset answers 503, a wrong
token 401). It is matched before the account sign-in; no account bearer reaches
it.

```bash
# Add by email (looked up in Clerk once; the list keeps the Clerk user id)
curl -X POST https://account.ade-app.dev/cloud/owner/phone-beta \
  -H "Authorization: Bearer $CLOUD_OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"email":"a@b.c"}'

# Add by Clerk user id, or remove one
curl -X POST https://account.ade-app.dev/cloud/owner/phone-beta \
  -H "Authorization: Bearer $CLOUD_OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"userId":"user_…"}'
curl -X POST https://account.ade-app.dev/cloud/owner/phone-beta \
  -H "Authorization: Bearer $CLOUD_OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"email":"a@b.c","enabled":false}'

# List the beta list
curl -X POST https://account.ade-app.dev/cloud/owner/phone-beta \
  -H "Authorization: Bearer $CLOUD_OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
```

An email answers `{ ok: true, added: [user_id…] }` or 404 when Clerk has no
account with it; `enabled: false` answers `{ ok: true, removed: […] }`; `{}`
answers `{ ok: true, users: [{ user_id, email, added_at }] }`.

**Deleting an account.** Clerk's `user.deleted` runs `deleteAccountPhone`: it
stops the account's phones, asks NoMac to forget what it kept for the label
(saved states, replays, workspace), and removes the row from the beta list.
NoMac's billing records stay under the label, which is an id, never an email.

## Known gaps

- Builds on the phone are Xcode projects only: Swift and Objective-C, SwiftUI
  and UIKit, Swift packages, CocoaPods from `Podfile.lock`, and XcodeGen
  `project.yml`. An app built elsewhere goes up as a Simulator build:
  `ade apple install --app <path to a Simulator .app>` uploads the whole
  bundle, installs it and launches it. Expo/EAS needs `"simulator": true`;
  Flutter needs `flutter build ios --simulator`.
- No Android. The cloud phone is iOS only.
- **ADE Web.** The hosted web client's phone is a flat iframe of NoMac's view,
  without the 3D body or the rail: Home, Screenshot and Record stay in the
  desktop app. Agents on the web still drive the phone with `ade apple`.
- The ADE iPhone app's sheet has no Record (the desktop rail has it).
- NoMac's beta allows 20 phones at once across all ADE accounts. Past that, a
  start waits in line and gives up with "No cloud iPhone was free" after 6
  minutes.
