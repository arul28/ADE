# Track I: the iPhone ADE Cloud page, and Cloud 4 P8 (iPhone and web sign-ins)

Helper: ios-web. Date: 2026-11-11. Nothing is committed by me. The lead's checkpoints 3 and 4 (`2033a3fe0`,
`5da274294`) already swept most of this track's files in mid-work; the working tree still holds the last two edits
(`webclient/adapter/providerLogins.ts` arg types, `Views/Cloud/CloudPaneSheet.swift` row layout and hour format).

## Result

- **iPhone ADE Cloud page** is now the mirror of the desktop dashboard, in its order and words, with ADEKit (flat
  cards, no materials). It has its own Settings row ("ADE Cloud", group App, after Integrations), and Work › ⋯ still
  opens it as a sheet. Both entries are behind `sync.cloudAvailable && sync.cloudSupported`.
- **Cloud 4 P8 on iPhone**: provider tiles with Signed in / Not signed in / Unknown and the account; a provider page
  with its sign-in and the account's sign-in cards ("In use here"); a banner sign-in sheet with the account note and
  the three steps (code, QR, Open sign-in page); ADE Cloud as a place with the same tiles (gated); the chat sign-in card
  uses the same steps.
- **Cloud 4 P8 on the web**: `window.ade.providerLogins` now exists in the web adapter, routed to the connected
  machine, and `window.ade.cloud.cloudSignInStatus` reads the saved keys and passes. The desktop's own Providers page,
  sign-in sheets and chat card already render on the web; they lacked this bridge.
- **One brain addition** serves both: `providerLogins.*` sync commands (below).

## Files changed, per item

### 1. iPhone ADE Cloud page

| File | Change |
|---|---|
| `apps/ios/ADE/Services/SyncService+Cloud.swift` | `CloudPhoneMachine` decodes the full list (`resources`, `lane`, `lastActiveAtMs`, `createdAtMs`, `diskUsage`, `laneWork`, `diskFull`, `shapeId`) and still the older summary. `CloudPhoneAccount` decodes the whole account (planId, extraHours, disk, computers, recentUse, billing, catalog, earnedHours, freePlan, planCleanup, timedWakesCancelled), every part optional so an older server just shows less. New: `noLane`, `currentPlanId`, lane-name display name. |
| `apps/ios/ADE/Views/Cloud/CloudPaneSheet.swift` | Rewritten. `CloudDashboardScreen`: hero (plan, hours left of N, "resets Dec 1" in UTC, `+N hours earned from invites. They never expire.`, extra hours on/off, forecast "(estimate)", disk and computers meters); notices (past due, out of hours, disk ≥80%, plan cleanup sentence, cancelled timed wakes); "Lanes and computers" (every computer, lanes first, "No lane" / "Unused" / "Safe to delete" marks, size, rate, disk, state, last run); plans side by side; sizes (`cloudTierFacts` words); sign-ins card; what agents may do alone. `CloudMachineScreen`: facts, "What uses the disk" from the computer's last measure, actions. `CloudSettingsPage` for Settings. Swift ports of `cloudTiers`, `cloudTierHoursLeftLabel`, `hoursForecast`, `formatCloudDate` (UTC), `formatGb`. Duo book and laptop layouts kept. |
| `apps/ios/ADE/Views/Cloud/CloudPreviews.swift` | New fixtures: `duo-cloud`, `duo-cloud-plans`, `duo-cloud-machine`, `duo-providers-cloud`, `duo-provider-signin` (kept `duo-cloud-limits`). |
| `apps/ios/ADE/Views/Settings/SettingsRoute.swift` | New route `.adeCloud` ("ADE Cloud", `cloud` symbol, App group, after Integrations). |
| `apps/ios/ADE/Views/Settings/ConnectionSettingsView.swift` | The row shows only with `cloudAvailable && cloudSupported`; the page body checks again; Settings asks `refreshCloudAvailability()` on open and on reconnect; observes `SyncMenuSafePublisher` so the row follows the answer. |
| `apps/ios/ADE/Views/Settings/SettingsIntegrationsPage.swift` | ADE Cloud card removed (it moved to its own row, as on the desktop). |

**Removed from the phone page on purpose** (the old add-a-computer model, gone from the desktop too): "+ New
machine", Copy, Move to a full/standard computer, Resize, and the make-job follow and approve sheet. A lane's size,
"free its computer" and "delete the lane" run the desktop's lane steps (work pushed first), so the phone says "Change
its size, free its computer or delete the lane in the ADE desktop app". The phone keeps Open its work, Sleep now,
Wake, and Delete computer for a computer with no lane. Same line the web adapter already draws (`DESKTOP_ONLY`).

### 2. Cloud 4 P8, iPhone

| File | Change |
|---|---|
| `apps/ios/ADE/Views/Settings/SettingsProvidersPage.swift` | Tiles (2 columns) instead of grouped rows; status words from the host's `signInState` as `providerSignInView.ts` does (Signed in, Unknown, Needs attention, Not signed in, Not downloaded, Off); place picker "<machine> / ADE Cloud" when the account has ADE Cloud; `SettingsProviderDetailPage` (state, Sign in / Sign in again, AI accounts link for Claude and Codex, account sign-in cards). |
| `apps/ios/ADE/Views/Settings/SettingsProviderSignIns.swift` (new) | `ProviderLoginsPhoneStatus` (decodes `providerLogins.status`, lenient per element); `ProviderLoginsModel` (read on open, writes `use`, `setCloud`, `setCloudAll`, each answer is the new status, controller only); `ProviderCloudPlace` + tiles (status, account, how it got there: "From Mac Studio", "Cloud pass", "Saved key", "Sign in on the cloud computer, or use a key"); `ProviderCloudProviderPage` (cards with "In use on ADE Cloud" / "Use on ADE Cloud" with a confirm, "On for ADE Cloud" switch); `ProviderMachineSignIns` ("In use here", "To use it here, sign in on <machine>.", "In use on ADE Cloud" only with access); `ProviderSignInCardView`; the dashboard's `CloudSignInsCard`. |
| `apps/ios/ADE/Views/Work/WorkProviderSignInSteps.swift` (new) | `providerSignInAccountNote` (the two Cloud 4 sentences), `providerSignInQRImage` (CoreImage), `ProviderSignInStepList` (✓ ADE started the sign-in · ● Approve in your browser with code, Copy code, QR, Open sign-in page that also copies the code, paste field when the provider wants a code back · ○ ADE checks the sign-in; a failed step shows ✕), `ProviderSignInSheet` (brand banner, "Sign in to X / on <machine>", Kimi region, end states "Signed in as …" read back from `ai.getStatus`, or red "This is B, not A." with Keep B / Try again; the logo turns once, off with Reduce Motion). |
| `apps/ios/ADE/Views/Work/WorkProviderSignIn.swift` | The chat card in the composer's place now shows the account note and the same step list while waiting/verifying. DEBUG fixture init for the controller. |
| `apps/ios/ADE/Services/SyncService+SettingsPages.swift` | `Connection.signInState`. |
| `apps/ios/ADE.xcodeproj/project.pbxproj` | The two new files. |

### 3. Cloud 4 P8, web, and the brain

| File | Change |
|---|---|
| `apps/desktop/src/renderer/webclient/adapter/providerLogins.ts` (new) | `window.ade.providerLogins` for the web: `status` (authoritative read, rejects when the host can't answer, so the page shows "couldn't read" instead of an empty account), `captureNow`/`use`/`setCloud`/`setCloudAll`/`setCloudBalance`/`remove` (mutations, never a fallback), `allowKeychain`/`allowGitHubCli` refuse ("Do this in the ADE desktop app on that computer…"), `onChanged` fires when the tab's connection comes back. Every member goes through `assertWebRuntimePinRoutable`. |
| `apps/desktop/src/renderer/webclient/adapter/index.ts` | Wires `providerLogins`. |
| `apps/desktop/src/renderer/webclient/adapter/cloud.ts` | `cloudSignInStatus` (gated on `access`, `cloud.read cloud_sign_in_status`, null on an older brain) and a no-op `onCloudSignInChanged`. |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` | **Brain addition (additive):** sync commands `providerLogins.status` (viewer) and `providerLogins.captureNow/use/setCloud/setCloudAll/setCloudBalance/remove` (controller only, not queueable), on the same `buildProviderLoginsDomainService()` the desktop's runtime action uses; `cloud_sign_in_status` added to `CLOUD_REMOTE_READS`. |
| `apps/desktop/src/shared/types/sync.ts`, `shared/syncMobileCompatibility.ts` | The seven new actions in the action union and the optional mobile list. |

Windows/Linux: everything on the web side and the brain is shared code with nothing platform-specific; the web
client runs the same on every OS. The Keychain action stays refused on the web (macOS-only and this-desktop-only).

## App Store compliance choice

The iPhone app never offers to buy, upgrade or change a plan, never shows a price (the payload has `priceUsd`; the
phone does not decode it), and links to no checkout or billing page. The plans card shows what each plan includes
(hours a month, disk in all, computers at a time, what happens past the hours), marks "Your plan" and a "From Dec 1"
next plan, the renewal/end date, and one neutral line: "Change your plan in the ADE desktop app." No button, no link.
Extra hours and extra disk are shown read-only (no switch: turning on paid overage is a purchase). The server's
free-plan-refused sentence names Plus's hours as a pitch, so the phone writes its own: "This computer already used
another account's free hours, so the free plan has no hours here." The sizes card leaves out the cents-per-hour line
the desktop shows. Residual risk: if App Review reads the one "Change your plan…" line as a call to action, delete
that line (`CloudPlansCard`); nothing else on the page points outside the app. The old iOS page had no plan or price
content at all, so this is the first plan content on the phone.

## Data fields added

- **None to `cloud.read`'s answers.** The page uses `cloud.read list` with `{detail: "full"}` (the web app's read,
  added in #2173), which already carries every computer's lane, resources, disk parts, last run, lane work and the
  whole account. An older brain ignores `detail` and the page shows its summary with fewer facts.
- **New reads/writes the phone and web reach:** `providerLogins.*` sync commands, and `cloud_sign_in_status` in the
  phone/web cloud read list (both above).
- **Not on the phone:** lanes kept without a computer (`lanesWithoutComputer` has no sync read), and the saved
  default size for new lanes (`cloud.read status` has `defaultSize`; I didn't spend a second list read on it, so the
  phone's Sizes card marks no default and offers no picker).

## Validated, and how

- **iOS build**: `xcodebuild -scheme ADE -destination 'generic/platform=iOS Simulator'` with DerivedData under my
  scratch dir: BUILD SUCCEEDED after the last Swift edit (first try found a name clash with a private
  `FailableDecodable` in `ADESharedModels.swift`; renamed mine `ProviderLoginsLenient`). DerivedData deleted.
- **Simulator** (the lane's own device, `ade apple start`): the build installed, each fixture opened with
  `-adePreviewScreen`, screenshots read by eye. Fixed from them: the state word wrapped letter by letter (now fixed
  width, last run under it), "+40.0 hours" (now "+40"), "422 h" breaking before "h". Showcase shots:

![ADE Cloud on iPhone: plan, hours with earned and extra hours, disk, computers, lanes with No lane / Safe to delete](ade-proof://2f1a6087-38ba-4ecd-a5e8-3ee2e7dc6698)

![Plans side by side with no price or button, and the four sizes](ade-proof://90901e66-d7b7-4276-b38e-2e940a6270fd)

![Settings › Providers with ADE Cloud as a place: tiles with Signed in / Not signed in, account, where it came from](ade-proof://c47849c0-7e53-46b2-be16-55a71d9e69ab)

![The sign-in sheet: account note, steps, code, QR, Open sign-in page](ade-proof://38050b2e-7714-47e5-b464-e64434eeddd7)

- **Web adapter**: a throwaway `tsx` harness (not committed) on `createWebProviderLoginsNamespace`: `status` →
  `providerLogins.status` with `{authoritative: true}`; `setCloudAll` and `use` → mutations `{idempotent: false}`;
  `allowKeychain` refuses with the desktop sentence; a pin to another machine throws `WebRuntimePinUnroutableError`;
  `onChanged` fires once when the connection goes connecting → ready.
- **Checks**: `apps/ade-cli` typecheck clean. `apps/desktop` typecheck: no errors in my files; three remaining errors
  belong to other in-flight work (`CloudPlans.tsx` contract import and `CLOUD_PLAN_LABELS` index, `IntegrationsHome.tsx:332`
  dead `"cloud"` comparison). Tests passed: `webclient/adapter/__tests__/adapter.test.ts` + `runtimePinGuard.test.ts`
  + `shared/syncMobileCompatibility.test.ts` (122), `ade-cli syncRemoteCommandService.test.ts` (126).

### What I could not run

- **The web client against a live machine.** ADE Web needs an ADE account sign-in in the browser (no skip), and the
  machine it connects to must run this branch's brain for `providerLogins.*` to exist; the brains on this Mac run the
  installed ADE. Signing in is the owner's to do. So the web Providers page, sign-in sheet and chat card were not
  seen in a browser; the adapter was checked by the harness above. To see it: run a dev brain from this worktree,
  `npm run dev:webclient` (port 5174) in `apps/desktop`, sign in as the owner, open Settings › Providers and
  Settings › ADE Cloud.
- **The iPhone against a real machine.** Only fixtures were shown. The access gate, the full-list decode against a
  real brain, and the providerLogins writes from a controlling phone were not exercised live.

## Remote-machine scoping (CLAUDE.md)

- Phone: every new call goes through `SyncService` to the machine the phone is connected to (`cloud.read`/`cloud.write`,
  `providerLogins.*`, the sign-in commands). The account part is the same from any brain of the person, and "In use
  here" is that machine's. The chat card keeps its existing host (the chat's machine connection).
- Web: every new member runs `assertWebRuntimePinRoutable`; a pin naming another machine (the reporting cloud
  computer of the ADE Cloud place) is refused, so the cloud part reads "no answer" rather than being answered by the
  wrong machine.

## Failure modes for /test

1. A refused account sees ADE Cloud on the phone: the Settings row, its page, the Providers "ADE Cloud" place or the
   Work ⋯ entry shows while `cloudAvailable` is false or unknown, or `cloudAvailable` stays true after the phone moves
   to a machine of another account (Settings now re-asks on open and reconnect; Work re-asks on project/host/attach).
2. The full-list decode fails on one malformed computer or account part and blanks the whole page (each part is
   `try?`; the list itself and `plan`/`hours` are required).
3. An older brain (summary list) makes rows lose their size or crash; it must fall back to the summary `size` string.
4. A phone that only watches (viewer) can flip "Share my sign-ins", "On for ADE Cloud" or "Use on ADE Cloud", or a
   brain accepts those writes from a viewer (`providerLogins.*` writes must stay `controllerAllowed` only).
5. The web `providerLogins.status` resolves a stale or empty status when the host can't answer (must reject:
   `authoritative`), or a write resolves without the host (must reject).
6. A pinned web call to another machine is served by the connected machine.
7. Dates drift by a day: "resets Nov 30" in a US timezone instead of "Dec 1" (must be UTC).
8. Plan content on iPhone grows a price, an upgrade button or a link (App Store).
9. The sign-in sheet reports "Signed in as A" when the machine signed in B, or never shows "This is B, not A" for a
   sign-in again with a known account.
10. "In use here" marks the wrong card: on an own computer it is `providers[p].local.key`, on a cloud computer the
    one in use on ADE Cloud.

## Not done

- **Recovery cards on the phone** (Cloud 4 recovery card 1, "Continue in a new thread" / "Change back to …", and
  the Claude pass approve in a cloud chat). The phone shows the chat's provider notices as plain lines; a new thread
  with the history and the pass approve are desktop flows with no phone command. The phone's sign-in card (recovery
  card 2's main way out) has the new steps.
- **Remove a sign-in from the account** on the phone (the brain command exists; no button yet).
- **Sign in on a cloud computer from the phone** for fallback providers (tiles say "Sign in on the cloud computer").
- **"Copy details for support"** on a failed phone sign-in.
- **Lanes kept without a computer**, and the **default size** picker, on the phone (see Data fields).
- **The referral code box** on iPhone: the lead's follow-up.
- The iPhone settings catalog (`WorkSettingsCatalog.swift`) labels for `ade-cloud.*` paths: generated by
  `generate-ios-settings-catalog.mjs`, not touched here.

## Follow-up: the iPhone side of the referral program (decision 4)

Built after the merge of main (`0397607d8`); every file re-read first.

| File | Change |
|---|---|
| `apps/ios/ADE/Services/SyncService+Cloud.swift` | `CloudPhoneReferral` (code, link, friendsJoined, rewardsPaid, rewardsLeft, rewardLimit, rewardMilli, hoursEarnedMilli, canEnterCode, enterCodeUntil, hasReferrer, referredState; `offersCodeBox` = `canEnterCode && !hasReferrer`), `CloudPhoneAccount.referral`, `CloudPhoneInviteOutcome`, `readCloudReferral()` (only with `cloudAvailable && cloudSupported`), `redeemCloudInvite(_:)` (`cloud.write invite_redeem {code}`; a throw becomes "ADE couldn't check that code…"). |
| `apps/ios/ADE/Views/Cloud/CloudPaneSheet.swift` | `CloudInviteCard` after Sizes, as on the desktop: the reward sentence, the link, Copy link, Share (system share sheet with the link), Friends joined / Hours earned / Rewards left N of 10, then "Were you invited?" with the box while `offersCodeBox`, or the referred line (pending / rewarded / refused). `CloudInviteCodeBox` (paste a full link, an `ade://` link or a bare code; the server's refusal sentence shown in red; disabled with a line on a phone that only watches). |
| `apps/ios/ADE/Views/Settings/SettingsAccountPage.swift` | "Invite" section with the same box, only while `offersCodeBox` and with ADE Cloud access; the referral read itself runs only with access. |
| `apps/ios/ADE/Services/ProductAnalytics.swift` | Feature `cloud_invite` with the desktop's action names (`invite_link_copied`, `invite_code_entered`) and a closed outcome list (`from_dashboard`, `shared_from_dashboard`, `accepted`, `refused_<reason>` for the six server reasons and `unavailable`). The sanitizer drops anything else, so no code, link or email can reach PostHog. A copy counts once a session; every entered code counts. |
| `apps/ios/ADE/Views/Cloud/CloudPreviews.swift` | Fixture `duo-cloud-invite`; the account fixture carries a referral. |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` | **Brain addition (additive):** `referral` in the phone/web cloud reads, `invite_redeem` in the cloud writes (controller only, so a watching phone can't enter a code). |

- **Earned hours in the top block**: already there ("+40 hours earned from invites. They never expire."); the
  sizes card counts them in "how long your hours last".
- **Gate**: the card lives on the ADE Cloud page (reachable only with access); the Account box and its read need
  `cloudAvailable && cloudSupported`. No code box on the sign-up screen (as the lead decided).
- **Share** is the system share sheet with the link; not a purchase. I log a share tap as `invite_link_copied` /
  `shared_from_dashboard` to keep the desktop's action names.
- **Not done**: opening `ade://invite/<CODE>` on the phone does not fill the box (the desktop's deep link fills
  Settings › Account; the phone has no handler for it yet).

Validated: iOS build succeeded (scratch DerivedData, deleted after); `ade-cli` typecheck clean;
`syncRemoteCommandService.test.ts` 126 passed. Fixture on the lane's simulator:

![The iPhone invite card: link, Copy and Share, counts, and the code box](ade-proof://5caa2812-0d11-49ba-b217-37b278a7f7b5)

Failure modes for /test (add to the list above):

11. The invite card or the Account box shows for an account without ADE Cloud, or the Account page reads `referral`
    without access.
12. A watching phone (viewer) can redeem a code (`invite_redeem` must stay a controller-only write).
13. A code, link or email reaches analytics (the iOS sanitizer must drop any outcome outside the closed list).
14. The box stays after the account got a referrer, or is missing inside the 30 days.
