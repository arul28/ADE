# /quality fix: iOS (apps/ios only)

Branch `ade/cloud-5-dashboard-and-fixes` (PR #2177). Nothing committed; the lead commits.

## Findings

### qb-ui B-I1: split `CloudPaneSheet.swift` (1,569 lines)
Split by responsibility. No logic changes: the code moved by line range, and a script checked that every original non-blank line landed exactly once. The only line dropped was the `// MARK: - Small pieces` header.
- `Views/Cloud/CloudPaneSheet.swift` (289): the sheet, `CloudSettingsPage`, `CloudPaneStore`.
- `Views/Cloud/CloudDashboardCards.swift` (~670): `CloudDashboardScreen`, hero, mini meter, notices, lanes card and row, plans, sizes, invite card, invite code box, agents card.
- `Views/Cloud/CloudMachineScreen.swift` (257): machine screen, facts, disk parts, controls, chips, pick prompt, `CloudFlowRow`.
- `Views/Cloud/CloudLimitsScreen.swift` (99): limits screen and `CloudSectionLabel`.
- `Views/Cloud/CloudPhoneFormat.swift` (~265): the hours notes and forecast, the machine mark, line, last-run and state-tone helpers, `CloudPhoneTier`, `cloudPhoneTiers`, shapes, and every `cloud*` text helper.
- All new files are added to `ADE.xcodeproj/project.pbxproj` (PBXBuildFile, PBXFileReference, the Cloud or Services group, and the ADE Sources phase). IDs are `C10D000000000000000{A,B}000{1-6}`. `plutil -lint` reports OK.

### qb-ui B-I2: `ProviderLoginsLenient` replaced by `ADELossyArray`
`signIns`, `providers` and `claudePasses` now decode through `ADELossyArray<…>` and `.wrappedValue`, and the wrapper is deleted. The behavior is unchanged: a malformed element drops on its own, a malformed or missing list still gives `[]` (or `nil` for `claudePasses`).

### qb-ui B-I3: `SettingsProviderSignIns.swift` (725 → ~480 lines)
- `ProviderLoginsPhoneStatus`, with its `read` and `write`, moved to `Services/ProviderLoginsPhoneStatus.swift`.
- `CloudSignInsCard` moved to `Views/Cloud/CloudSignInsCard.swift`.
- The settings file keeps the words, tiles, views and `ProviderLoginsModel`. Its header names where the other two parts now live.

### qb-ui B-I4: lenient decoding boilerplate
Added `KeyedDecodingContainer.lenient(_:forKey:)` next to `ADELossyArray` in `Models/RemoteModels.swift`. It is `try? decodeIfPresent`: nil when the field is missing, null or shaped differently.
- Used for the optional fields of `CloudPhoneMachine` and `CloudPhoneAccount` (24 fields), and for the six optional fields of `ProviderLoginsPhoneStatus.SignIn`. Each is one line per field.
- The fields that threw before still throw: `instanceId`, `state`, `name`, `machineKey`, `type`, `plan`, `hours`.
- The defaulted fields keep their `?? default`.

### qa-ui #4: `cloudAvailable` reset while access is unknown
`Services/SyncService.swift` now clears `cloudAvailable` in two places:
- **Connection:** the `connectionState` `didSet` clears it whenever the state leaves `.connected`.
- **Host change:** a new `activeHostProfile` `didSet` clears it whenever `hostIdentity` changes.

Both are guarded with `if cloudAvailable`, so nothing is republished when it is already false.

In `refreshCloudAvailability()`, an answer that lands after the phone left the machine, or moved to another host, is now dropped. The read that the new connection starts decides instead; Work's `.task` re-runs it on `isAttached` and on host change.

I updated the `ConnectionSettingsView` comment. Its claim, "Until the answer, the ADE Cloud row stays hidden", is now true.

Remote check: this only gates the phone's own UI on the machine it drives. No new call was added.

### qa-ui #5: plans card call to action removed
Deleted the line "Change your plan in the ADE desktop app." and its icon from `CloudPlansCard`. The card's doc comment and the page header now say the page states facts only (App Store 3.1.1/3.1.3).

### qb-ui note: refused free plan sentence
`cloudHoursNotes` now shows the server's `freePlan.sentence` when it is present and not empty. The phone's own sentence is used only when the server sends none.

**Flag for the lead:** the server's sentence today is `CLOUD_FREE_PLAN_REFUSED_SENTENCE`: "This computer already used another account's free hours. Plus gives you 500 hours a month." On the iPhone, "Plus gives you 500 hours a month" may read as an upgrade nudge, the same App Store risk as qa-ui #5. The removed comment said the phone avoided it on purpose. I followed the brief. If App Review is the concern, either drop the server sentence on iOS or give the server a separate sentence for the phone.

### qb-ui Low: the invite reward falls back to "20"
`CloudInviteCodeBox` now takes a required `rewardMilli` from its caller's referral: the dashboard card and Settings › Account both pass `referral.rewardMilli`. The words use `outcome.referral?.rewardMilli ?? rewardMilli`. The literal "20" is gone.

### Relay from fix-server: `mutual` refusal reason
Added `mutual` to `refusalReasons` in `Services/ProductAnalytics.swift:93`, so `refused_mutual` passes the invite outcome sanitizer. It now matches the server's `CLOUD_INVITE_REFUSAL_REASONS`. The words shown are still the server's `message`. Added after the build; it is a one-word change to a string array.

## Build and check
- **Build:** one `xcodebuild build` (scheme ADE, Debug, generic iOS Simulator, its own DerivedData in my scratch dir): **BUILD SUCCEEDED**. No warnings in the touched files; the one warning shown is the existing `CursorCloudAgentDetailScreen.swift:295`. Afterwards I deleted the DerivedData. `df` showed 742 GiB free on /Volumes/Dev and 64 GiB on the data volume.
- **By eye:** I installed the build on the lane's simulator (`ADE · Cloud 5: dashboard and fixes`) and opened two fixtures:
  - `-adePreviewScreen duo-cloud-plans`: the plans card ends at the "An hour is…" note, with no "Change your plan" line.
  - `-adePreviewScreen duo-cloud`: hero, hours notes, disk and computers meters, and lane rows all render as before.
- I filed no proof and deleted the screenshots. I took a device lease and could not release it without its token; it expires on its own at 16:51Z.
- No tests reference the changed symbols or copy (I grepped ADETests and ADEUITests).

## Left / not done
- `CloudSignInsCard`'s hint under the switch is still inverted (`enabled ? "Off: …" : "On: …"`), as is the desktop's `CloudSignIns.tsx:121` (qb-ui Track A note). It was not in my brief and the behavior was kept. If the desktop helper rewords it, iOS should match.
- Typecheck and tests were not run for other packages: iOS only.

## Follow-up: Greptile 4540477228 (ADE Cloud notices on iPhone)

**The bug.** `CloudPhoneAccount` decoded `timedWakesCancelled` as `{ sentence }`. The server sends `{ at, count, reason }`, so the notice never showed. `planCleanupDone` was not decoded at all.

**What changed:**
- **Decoding** (`Services/SyncService+Cloud.swift`). The shared `Sentence` struct is replaced by three:
  - `PlanCleanup { sentence, dueAt }`: the server does send `sentence`.
  - `PlanCleanupDone { at, planId, freed[{ name, branch }], kept[{ name }] }`.
  - `TimedWakesCancelled { at, count, reason }`.

  Each is still read with `lenient`, so a mismatch drops only that notice.
- **Words** (`Views/Cloud/CloudPhoneFormat.swift`). The phone now builds the sentences itself, copied word for word from `contract.ts`:
  - `cloudTimedWakesCancelledSentence` (`timedWakesCancelledSentence`).
  - `cloudPlanCleanupDoneSentence` (`planCleanupDoneSentence`). It returns nil when nothing was freed or kept.
  - `cloudPlanSentenceName` (`CLOUD_PLAN_SENTENCE_NAMES`).
- **Notices** (`CloudNotices` in `CloudDashboardCards.swift`), in the desktop's `PlanNotices` order:
  - The plan cleanup warning now adds the desktop's "This happens on <date>. To choose which go, delete computers yourself before then." when `dueAt` is set.
  - A new neutral notice, "ADE freed computers for your plan. <sentence>".
  - The timed wake-ups warning now shows.

**Build.** One `xcodebuild build` (same setup as before): **BUILD SUCCEEDED**. The DerivedData is deleted.

**Not checked.** I did not look at the notices on the simulator, because no fixture carries them; that needs a fixture or a live account with one of them set.

**Flag for the lead.** Two of the server's sentences, now shown on the iPhone, mention buying: "Once you delete a computer or get Plus" (`over_plan_disk`) and "or you add hours" (`out_of_hours`). This is the same App Store 3.1.1 question as the free plan sentence above. I kept the server's words, as the brief asked.

## Follow-up: no mention of buying anywhere on the iPhone (lead's rule)

**Rule.** The iPhone never points at a purchase. Plan names may still appear as facts.

This replaces the two "flag for the lead" notes above. Both are resolved now.

**What changed:**
- **Timed wake-ups cancelled.** `cloudTimedWakesCancelledSentence(_:resetsAt:)` now uses the phone's own words:
  - Over the free plan's disk: "… Once you delete a computer, each computer sets its next timed wake-up again …".
  - Out of hours: "… When your hours reset on <billing.periodEnd date>, each computer sets …". Without a period end it says "When your hours reset".
  - The server's "get Plus" and "add hours" are gone.
- **Refused free plan.** The phone always uses its own sentence again ("…so the free plan has no hours here."). This undoes the earlier switch to the server's `freePlan.sentence`, which says "Plus gives you 500 hours a month."
- **Plans freed (`planCleanupDone`).** Already built in the phone's own words. They name the plan only as a fact ("To fit the free plan, …").
- **New safety net for server text.** `cloudPhoneWords(_:)` in `CloudPhoneFormat.swift` drops every sentence of a server message that mentions a purchase: "get Plus/Pro", "get a paid plan", "paid plan", "upgrade", "add hours", "buy", "extra hours", "extra disk". It returns nil when nothing is left.
- **Where the safety net applies:**
  - The `planCleanup` sentence. The server's text names plans as facts today ("Plus allows 40 GB"), so nothing in it is dropped.
  - A computer's `diskFull`. For example, "A paid plan gives more." and "…or turn on extra disk in Settings." are dropped; "This computer's disk is full." and the free-disk fact stay.
  - Every `cloud.write` error the page shows (sleep, wake, delete, limits). An example is `overPlanDiskSentence`'s "Delete a computer, or get Plus.", which keeps only its first sentence. If nothing is left, the page says "ADE Cloud couldn't do that."
- **Checked:**
  - Invite refusal messages mention no purchase, so they are unchanged.
  - A grep of `apps/ios` finds no phone-written words that mention a purchase.
  - I ran the filter on five sample server messages; each came out as intended.

**Build.** One `xcodebuild build`: **BUILD SUCCEEDED**. The DerivedData is deleted.

**Not checked.** I did not look at the notices on the simulator, because no fixture carries them.
