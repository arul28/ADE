# ADE Cloud iPhone

An iOS Simulator that runs in the cloud for the ADE account, not on a machine of
the person's. Two providers can run it, NoMac (nomac.app) or Revyl
(revyl.ai), behind one shape: the same commands, screen text, steps and pane
for both, with a few abilities that differ (see **Providers**). Any machine drives it with the same `ade apple`
commands it uses on a Mac's simulator: a Windows PC, a Linux box, a Mac, or an
ADE Cloud computer. The Work tools pane shows it in 3D or flat on the desktop;
ADE Web shows the same pane as a flat live view, and the ADE iPhone app shows it
from a chat's Tools menu. The launch plan is `docs/plans/ade-cloud-iphone-launch.md`.

Server: `apps/account-directory/src/cloud/phones.ts` (routes, credits, the
guard), one record per provider behind `phoneProvider.ts` (`phoneNomac.ts`,
`phoneRevyl.ts` for Revyl's workspaces and calls), `phoneRoute.ts` (which
provider: the lock, the router, failover), `phoneViewerPage.ts` (the
viewer page for Revyl's stream) and `phoneBeta.ts` (the owner's beta list).
Brain:
`apps/desktop/src/main/services/adeCloud/cloudPhoneService.ts`, with one driver
per provider (`cloudPhoneDriver.ts`, `cloudPhoneNomacDriver.ts`,
`cloudPhoneRevylDriver.ts`, `cloudPhoneScreenText.ts`).
CLI: `apps/ade-cli/src/cliCloudIphone.ts`. Shapes:
`apps/account-directory/src/cloud/contract.ts` and
`apps/desktop/src/shared/cloudPhone.ts`.

## Access

The Worker var `CLOUD_PHONE_ACCESS` decides who has it, with no app release:

- `beta` (the default): only accounts the owner adds to `cloud_phone_beta`
  (migration `0047_cloud_phone_beta.sql`; one row per `user_id`, with the
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

## Credits and the money guard

The phone has no minutes of its own: it draws from the account's one credit
balance at one credit a minute (`src/cloud/credits.ts`,
`PHONE_CREDIT_MILLI_PER_MINUTE`): the plan's credits, then earned ones, then
any minute while extra credits (the extra-hours switch, paid plans) are on.
Out of credits with extra credits off, a start answers 402
`phone_credits_out`. A phone start settles the free-plan checks itself, as a
computer's start does, once the account may use the phone at all
(`routePhone`), so calling the phone route alone can't skip them.

- Every phone is a `cloud_phones` row (migration `0048_cloud_phone_usage.sql`):
  NoMac's billed seconds and cost, live or ended, and whether the account was on
  free rules, counted in the period it started in. NoMac's signed webhook
  (`POST /cloud/nomac/webhook`, `NOMAC_WEBHOOK_SECRET`) settles rows this Worker
  made, and recovers a phone with no row (its start's answer was lost) when its
  `ade:<userId>` label names a live account here (another environment's phones
  are left alone); a delivery whose work
  fails is given back, so NoMac's retry is done. The ten-minute check reads
  every live phone again, so a missed delivery can't leave one counted forever.
- **Charging:** a phone's billed minutes go into the account's `used_milli` in
  the same write as its row (`phoneCreditStatements`); `credited_milli` holds
  what is already in, so a repeated answer adds nothing. A running phone's
  time its provider hasn't billed yet counts in the balance too
  (`unsettledPhoneMilli`), so a computer can't spend it. Rows from before
  credits (`credits = 0`, the old iPhone minutes, gone since 2026-11-25) are
  history only: they charge nothing and count nothing. The account read
  (`CloudAccountState.phone`, with `creditsUsedMilli`) is D1 only.
- **Period changes:** a phone from the old period stops (the ten-minute check,
  or a new start); its time so far is charged to the period that ends
  (`startFreshPeriod`), and nothing of it to the new one.
- **The guard:** every phone starts with NoMac's spend cap and time limit set
  to what the account may still use (the credits left, then with extra credits
  on two hours at most), so a phone stops by itself there. NoMac can't lower a
  running phone's limits, so when what the account may use shrinks (extra
  credits off, a computer using credits, a new period, access removed, the
  account blocked), `enforcePhoneAllowance` stops the phone at once if nothing
  is left, or sets its `stop_at` to when its credits run out; the minute tick
  stops it then (`stopPhonesDue`). The ten-minute check runs the same for every
  live phone. ADE never pays NoMac for a minute nobody pays for.
- **Free-use cap:** a free-plan phone start is refused (503, never naming why)
  once the month's free use reached the owner's cap, as a free computer is.
- **Agents:** a person and an attended chat use the phone freely within the
  credits. An agent nobody watches (full-auto chat, automation run, ADE MCP
  app) uses it only when the agent limits let agents spend (`unattendedSpend`,
  the same switch as hours); a plan-mode chat never. The RPC server stamps who
  is asking on the spending `cloud_phone` actions (`CLOUD_PHONE_SPEND_ACTIONS`);
  `cloudPhoneAgentGuard` in `registry.ts` checks it.
- **What agents read:** `ade cloud status` carries `credits` (the iPhone's
  rate), `iphone` (access, the credits it used this period, reset day) and
  `plans` (each plan's price, credits and price past the plan), so an agent
  answers plan and credit questions from one read. On a machine that isn't a Mac, the `ade-apple` skill
  is shown only while the account has the iPhone (`refreshIphoneSkill` in
  `cloudAccess.ts`, cached 10 minutes like ADE Cloud's own access); on a Mac it
  always shows (its own simulators).
- **Warnings:** the credit balance's emails (80%, 95% and out), once each a
  period; the ten-minute check sends them to accounts that used the phone,
  with the iPhone's wording. Settings shows the credits.
- **Owner:** the phones' NoMac cost counts in the month's cost estimate, in
  the alerts' top accounts and, for free-plan phones, toward the free-use cap.
  Blocking an account stops its phone. NoMac's `credit.low` emails the owner. Analytics: `ade_cloud_phone` (`started`, `ended`, `refused`).

## Providers

NoMac and Revyl run the phone behind one shape, so either can be dropped, or
both used, without changing anything an agent or a person sees.

- **Which one.** One fixed order (`routeOf` in `phoneRoute.ts`): NoMac
  first, then Revyl, and Revyl only on a paid plan, as the fallback when
  NoMac definitely refuses. A free plan's phone is NoMac's alone: when NoMac
  refuses it (or can't start here), the start answers 503 `phone_busy` ("busy
  right now because of heavy use… move to a paid plan for priority access").
  A lost answer (a NoMac 5xx or timeout, which may hide a phone it made) is
  never retried elsewhere. A start's `needs` never picks the provider: a phone
  that lacks an ability says so. Only providers that can start here
  (`CLOUD_PHONE_REVYL=on` for Revyl) and that this client can drive count.
- **A tester's pick.** An account on the beta list may pick one provider for
  every phone of theirs (`auto`, `nomac` or `revyl`), from the toggle an ADE
  beta build shows, or `ade cloud phone-provider`. It is stored in the beta
  row's `provider` (`POST /cloud/phone/provider`, 403 for anyone else, and
  `CloudAccountState.phone.providerChoice` tells a tester's apps). A pick is
  the only provider tried, never a quiet fallback; when it can't start, 503;
  when the client can't drive it, 409 `phone_needs_update`. The owner no
  longer sets providers (`phone <account> on|off` only puts an account on the
  list). The route (`choice`, `default`, `failover`) and provider go in the
  `cloud.phone_started` log line and PostHog's `ade_cloud_phone`. Each phone
  row keeps its `provider`, so a running phone is never switched, and a Revyl
  phone is still read and stopped with the switch off. `phoneRoute.ts` owns
  the order (`routeOf`) and the failover (`startOnRoute`).
- **Abilities, not names.** Agents and people never see a provider's name:
  every answer and error passes through `withoutPhoneProviderNames`. What
  differs is listed as abilities (`CLOUD_PHONE_PROVIDER_ABILITIES` in
  `contract.ts`): NoMac has `tests`, `uninstall`, `storekit`, `locale`,
  `timezone`, `statusBar`, `launchEnv`; Revyl has `perf` (the launched app's
  CPU, memory and frame rate, `ade apple perf`), `shake` and `orientation`
  (`portrait`/`landscape`). `GET /cloud/phone` returns `abilities` (the live
  phone's, or what a new one could have); the brain's status adds `lacks`
  and leaves out `capabilities` it can't do. A phone without an ability a
  command needs answers "This cloud iPhone can't X." (409 `phone_lacks` from
  the server for a running phone); `needs` never changes which provider a new
  phone starts on. `ade apple status`, `ade devices
  use ios@cloud` and `ade apple --help` on the cloud iPhone print the
  ability lines.
- **What is shared.** The server owns the credits, `stop_at`, the minute tick, the
  allowance, the ten-minute checks, the beta list and deletion for both. The
  brain's `cloudPhoneService.ts` owns starting and waiting, argument checks,
  packing a checkout or an app, screenshots and recordings to the proof drawer,
  and the chat's start and end lines; on a phone that ended between the check
  and the first call (`CloudPhoneGoneError`), it runs the call once more on a
  fresh phone. A driver owns only how one provider is driven. A fix in the
  service reaches both.
- **NoMac.** The brain holds a per-phone token and calls NoMac's tools
  directly. Its phone has NoMac's own spend cap and time limit.
- **Revyl.** Each ADE account gets its own Revyl workspace, made with ADE's
  partner key (`REVYL_PARTNER_API_KEY`) under `ade-<userId>` and a synthetic
  `revyl+<hash>@ade-app.dev` address (never the person's email). The server
  mints short session credentials and keeps them in memory only. There is no
  per-phone token: the brain calls `POST /cloud/phone/call {action, body?,
  query?}` with its account sign-in, and the server passes Revyl's answer
  back as it is. Actions are `proxy.<name>` (an allowlist of Revyl's device
  calls) and `build.upload_url|start|status|logs|install`. The driver turns
  the iOS accessibility tree into the same screen text NoMac answers
  (`kind "label" #id state @x,y` in points; `focused` marks the field with the
  keyboard) and runs the same `act` steps with plain taps, swipes and typing;
  it never uses Revyl's AI-priced targeting. `launch` uploads the packed
  checkout and builds it on Revyl's runners (about 60 s for a small app);
  `installApp` sends a prebuilt `.app` through the same runner. A recording's
  id is kept on the phone row (`recording_ref`), so any brain of the account
  can stop it. Revyl's phone has no time limit or spend cap of its own:
  `stop_at` is set at start, capped at `CLOUD_PHONE_MAX_MINUTES`, and the
  minute tick stops it. Its billed seconds run from `started_at`.
- **Build tools a provider lacks.** A build tool can be missing from one
  provider's hosts for a while (`CLOUD_PHONE_BUILD_NEEDS`: `metal`, Apple's
  Metal Toolchain). A brain whose build failed for want of it (the build's
  own "missing Metal Toolchain") reports it on the next start (`missing`
  `{ phoneId, need }` on `POST /cloud/phone`); the server records it for the
  phone row's provider, never the brain's word, and only for a phone of the
  reporter's own from the last 3 hours (`recordBuildGap`,
  `cloud_phone_build_gaps`, migration 0070: one row per provider and need,
  for every account, with no account in it). For a day after the last
  report (`CLOUD_PHONE_BUILD_GAP_MS`), a start that names the tool
  (`builds: ["metal"]`) leaves that provider out (`routeForBuilds`), and a
  live phone there is swapped for one of the same model that has it (stopped
  only once the new start may go there). The shared row only moves a paid
  plan's starts; a free plan is refused only on its own report (the phone
  row's `build_gap`, its day from `build_gap_at`), so a false report can't block another account's
  builds, only send paid Metal builds to Revyl for a day (logged with who
  sent it). Past the day, one start tries the provider again, so a
  provider that added the tool gets the work back by itself; a new failure
  starts the day again. Only a paid plan's route has Revyl, so a free plan
  is told, before any phone minute when the gap is known, "This app needs a
  cloud iPhone that can build apps with Metal shaders, and right now only the
  paid plans' iPhones can…" (402 `phone_needs_paid`), and its live phone
  stays. With no provider left (Revyl off, or a paid plan past its Revyl
  limit, which is never named), 409 `phone_build_unavailable` says to build
  on a Mac; a gap-free provider that lacks an asked ability (Revyl and
  `--env`) is named as both at once (409 `phone_lacks`). A tester's pick is
  never filtered. The brain names `metal` for a project with a `.metal` file
  in its build folder, or whose build here needed it before (`metalProjects`,
  in memory, 200 builds, keyed by checkout, folder and scheme: a Swift
  package's shaders show only in a build). The retry runs only under the
  account the first build ran under.
  `launch` then builds once more on the swapped phone, its answer led by
  "Moved to another cloud iPhone…"; a refusal leads the first build's
  failure with the server's sentence. `test` is never moved (Revyl has no
  tests); it gets the plain sentence. Logs: `cloud.phone_build_gap`,
  `cloud.phone_build_swap`, and `builds` on `cloud.phone_started`.
- **The pane.** For a Revyl phone, the view link is ADE's own viewer page,
  `<server>/cloud/phone/viewer#whep=…&ws=…`. It shows Revyl's WebRTC video
  as it is, with a clear canvas over it that takes touches (copying each frame
  into a canvas cost the iPhone app's web view about 3× the CPU; see
  `docs/perf/macos-baseline.md`). Touches, keys and Home go over Revyl's input
  socket, so the desktop view host, ADE Web's iframe and the iPhone app's web
  view open it the way they open NoMac's page. Revyl types at a point, so keys
  go to the last place tapped, sent together every 25 ms; Enter and Backspace
  are keys of their own. A hidden input with no on-screen keyboard
  (`inputmode="none"`) takes the focus on a touch, so a hardware keyboard on
  an iPad or a Mac and pasted text reach the phone. The stream and socket
  links stay after `#`, so no server log sees them. A web view that wants a
  tap before video plays (the iPhone app's) shows "Tap to show the phone."

## Architecture

```
tools pane (CloudIphonePanel)     CLI (ade apple …)     any provider's agent
              \                         |                        /
        cloud_phone action domain on the machine's brain (cloudPhoneService)
                                  |
                 server /cloud/phone* (phones.ts, phoneNomac.ts)  <- NOMAC_API_KEY
                                  |
                        NoMac (nomac.app)  <- one simulator per ADE account
```

- **Server.** `phoneNomac.ts` is the only place that holds the NoMac account key. It
  checks the beta list, reads the period's billed seconds from NoMac, starts or
  reuses the account's phone, and mints the short-lived token a brain drives it
  with. `routes.ts` checks the account sign-in; `safety.ts` checks the owner
  token on the beta-list route.
- **Brain.** `cloudPhoneService.ts` exposes the `cloud_phone` action domain
  (`getStatus`, `start`, `stop`, `look`, `act`, `screenshot`, `launch`,
  `installApp`, `control`, `logs`, `record`, `runTests`, and `view` and
  `keepAlive` for the pane). It holds one phone's token in memory and calls
  NoMac's tools directly: the screen as text, input, screenshots, logs,
  recordings, builds and tests. `getStatus` carries `lastActivityAt`, this
  brain's last tool call to the live phone, so the pane can show the idle stop
  coming (`CLOUD_PHONE_IDLE_SECONDS`); `keepAlive` is one cheap call that resets
  NoMac's idle clock and never starts a phone: a brain without the phone's
  token asks the server with `attach` (`POST /cloud/phone {attach: true}`),
  which answers 409 `phone_not_running` instead of starting one (a server from
  before `attach` that starts one anyway gets it stopped at once). When an
  agent chat's call starts a new phone, that chat gets one quiet notice, and
  one more when the phone stops (a stop, or found ended on a later read: idle,
  its 2-hour limit, the credits used up). The end is noticed only when
  something reads this brain (a pane, the top bar, the next phone call), so a
  phone a terminal agent started may tell its end late. The notice and run
  bookkeeping live in `cloudPhoneRun.ts`.
- **CLI.** `cliCloudIphone.ts` turns each `ade apple` verb into one
  `cloud_phone` action on this machine's brain. `cliDevices.ts` adds the
  `ios@cloud` row and the `ade devices use ios@cloud` choice.
- **Tools pane.** `CloudIphonePanel.tsx` shows the credits left, Start/Stop, and the
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
- **Running strip and top bar.** While the phone runs, the pane's strip says
  its model, how long it has been on, the credits left (about how many minutes) and when the
  idle stop comes; in its last 90 s it counts in seconds and offers Keep on
  (`cloud_phone.keepAlive`: one cheap call NoMac counts as use) beside Stop.
  The top bar shows a phone icon only while a phone starts or runs (a dot for
  its state), and opens the same facts with Keep on, Stop and a link to the
  credits. Both read one shared state (`renderer/state/cloudPhoneLive.ts`):
  every read of `getStatus` is published there, the pane reads every 30 s
  while the phone runs, and the top bar reads on focus, every 30 s while a
  phone runs and every 2 minutes while none does, never while the window is
  hidden. The idle countdown runs from the later of the brain's last call
  (`lastActivityAt` on the status) and the person's last input in this
  window's pane; another machine's agent may also be using the phone, so it is
  the earliest it can stop, and the pane reads again before it says so. A read
  through a brain that didn't drive the phone answers no `lastActivityAt` and
  never erases a known one; a read well past the stop time that still finds
  the phone on means something else uses it, so the countdown hides. Keep on
  stays while the phone reads ready, past the estimate too. A tab bound to ADE Cloud has no brain to
  read through, so its top bar shows only what a tools pane reads.
- **Older machines.** A brain from before 1.2.131 has no `cloud_phone`
  domain. The pane's "Runs on" row and the pick-a-Mac screen, `ade devices`
  and `ade devices use ios@cloud` say to update ADE on that machine
  (`isCloudPhoneMissingAnswer`), never that the account lacks the phone.
- **ADE iPhone app.** A Work chat's ⋯ › Tools › ADE Cloud iPhone (also the Duo
  and iPad Tools rails) opens a sheet over the same `cloudPhone.*` commands,
  sent to the chat's machine: the credits left, Start and Stop, why it ended, and
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
  this checkout and builds it there. With no `--path` (`--project` is the
  same flag), the brain finds the project in the files that go up, where a
  Mac's own launch looks (`discoverXcodeProjectPaths`): the top, each top
  folder and `apps/*`, by a `.xcodeproj`, `.xcworkspace` or `project.yml`
  (`cloudPhoneBuildFolder`). A folder's workspace carries its project, and a
  top `Package.swift` counts when the top has no project. Two or more things
  to build (two projects in one folder, a top project and a nested one),
  none, or a `--path` that isn't a folder or bundle that goes up is refused
  before the upload, naming `--path`. Revyl's build takes any folder name
  but `..`, an absolute path, a control character or a backslash (`SUB_PATH`).
  Launch arguments after `--` are refused on a build (the phone starts the
  app without them): build, then `relaunch --bundle-id B -- …`, which a Revyl
  phone refuses with a sentence (its launch takes no arguments); `launch --no-build --bundle-id B [-- …]`,
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
  most 2 hours. A new one starts after that; the workspace stays. Those idle
  minutes count, and every command starts a phone (reads too), so a few
  short visits cost more than one batch. `GET /cloud/phone` answers this
  period's phones (`recent`: start, end, minutes, how it ended; NoMac's own
  idle stop or limit reads `on_its_own`), and `ade apple status --text`
  lists them, so a person can see where the minutes went.
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

**Migration.** Apply `0047_cloud_phone_beta.sql` and `0048_cloud_phone_usage.sql`
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
(saved states, replays, workspace), and removes the row from the beta list
and its pending invite. NoMac's billing records stay under the label, which is
an id, never an email. The repeats of the deletion (`accountErasure.ts`) run
it again.

## Speed (measured 2026-11-19, from a Mac)

ADE's part is small; the phone's own steps take the time:

| Command | Time |
|---|---|
| `status` | 0.5 s |
| `start` (new phone) | 8–13 s |
| `snapshot` | 0.7–1.1 s |
| `act` (one tap) | 2–3 s; 11–21 s for an app's first launch on a new phone |
| `launch --no-build` (Safari) | 14 s (10 s of it the app's launch) |
| `open-url` | 2 s |
| `screenshot` (to the proof drawer) | 3.7 s |
| `stop` | 1.3 s |

An `act` answers some seconds after the steps it reports ("1 step done in
5.9 s" took 11.4 s): NoMac waits for the screen to settle and reads it. A step
right after a navigation can say the content "can't be read" while the page
loads; a `snapshot` a moment later reads it. The `ade-apple` skill tells agents
to read with `snapshot`, batch steps in one `act`, and mind the idle stop.

## Known gaps

- Builds on the phone are Xcode projects only: Swift and Objective-C, SwiftUI
  and UIKit, Swift packages, CocoaPods from `Podfile.lock`, and XcodeGen
  `project.yml`. An app built elsewhere goes up as a Simulator build:
  `ade apple install --app <path to a Simulator .app>` uploads the whole
  bundle, installs it and launches it. Expo/EAS needs `"simulator": true`;
  Flutter needs `flutter build ios --simulator`.
- **Metal shaders.** Xcode 26 and later ship the Metal compiler as a separate
  download (`xcodebuild -downloadComponent MetalToolchain`, about 870 MB for
  27.2). NoMac's build hosts don't have it (seen 2026-11-27; asked to add
  it), and its `app_run` takes no build command, so a project that compiles a
  `.metal` file (the ADE iOS app does, through SwiftTerm's `Shaders.metal`)
  fails there. Revyl's runner has it (a Metal test app built there
  2026-11-27), and its build step, which ADE writes (`buildCommand` in
  `phoneRevyl.ts`), fetches it anyway when a build fails for want of it (at
  most 420 s, bounded by the shell, inside the build's 900 s) and builds
  once more; the first build's toolchain line is left out of the output, so
  a later error is never blamed on it. A named workspace still gets its
  folder's `pod install`. What ADE does
  about it is in **Build tools a provider lacks**.
- No Android. The cloud phone is iOS only.
- **ADE Web.** The hosted web client's phone is a flat iframe of NoMac's view,
  without the 3D body or the rail: Home, Screenshot and Record stay in the
  desktop app. Agents on the web still drive the phone with `ade apple`.
- The ADE iPhone app's sheet has no Record (the desktop rail has it).
- **Abilities differ by phone.** Revyl's phone has no app tests, uninstall,
  StoreKit, locale, time zone or status bar overrides, and passes no launch
  `env`; NoMac's has no perf, shake or orientation. See **Abilities, not
  names**. Network capture is not offered: Revyl's `network_requests`
  answered an empty list on every partner session we tried.
- **Older brains.** A brain names the phones it can drive (`providers` on
  `POST /cloud/phone`); one from before Revyl names none. A router account
  then gets NoMac; a Revyl-locked account gets "Update ADE".
- NoMac's beta allows 20 phones at once across all ADE accounts. Past that, a
  start waits in line and gives up with "No cloud iPhone was free" after 6
  minutes.
