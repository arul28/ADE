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
