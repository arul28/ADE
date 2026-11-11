# Track H: hide ADE Cloud from accounts without access, and item 2

Helper: hide-cloud. Date: 2026-11-11. Nothing is committed; the lead commits.

## Result

Every ADE Cloud surface I found is hidden for an account that `GET /cloud/access` does not say yes for.
"Not known yet" and "the check failed" count as no. The gates are the existing ones:

- the server's `cloudAccessAllows`;
- main's `cloudAccessEnabled`;
- the renderer's `useAdeCloudEnabled()` / `adeCloudEnabled()`;
- the CLI's `cliCloudEnabled`;
- the skill roots' `adeWithheldAgentSkills()`;
- iOS's `cloudAvailable`.

No PostHog flags and no build-time flags were added.

Most surfaces were already gated. My changes close the gaps listed under "What this track changed".

**Startup ordering.** The renderer starts with `enabled = false`, and access is never read from storage.
Main caches the answer only in memory. A cached yes rides out a failed check only after a real yes earlier in the same session.
iOS starts with `cloudAvailable = false`.

The only saved ADE Cloud data is the lane-computer index (`renderer/state/adeCloudLaneIndex.ts`, localStorage). It is written only after a good read with access, so an account that was never allowed has nothing saved.
No surface draws ADE Cloud bits from saved data before the answer.

**Checks run:**
- Typecheck: `apps/desktop` clean, `apps/ade-cli` clean.
- Tests, all passing: `settings/settingsManifest.test.ts` (36), `app/SettingsPage.test.tsx` (12), `remoteMcpCommandPolicy.test.ts` (131), `remoteMcpService.test.ts` + `remoteMcpTools.test.ts` (46).
- iOS: `xcodebuild` for the iOS Simulator, using its own DerivedData (since deleted): BUILD SUCCEEDED.

**Windows and Linux:** nothing here is platform-specific. The settings finder, the CLI and the skill filter are shared code, and the skill mirror already handles Windows.

## Item 2: `ade settings find "ade cloud"` returned Cloudflare

**Cause.** The access check was not at fault. The CLI's `cliCloudEnabled` was right: `ade settings find "cloud plan"` already found the ADE Cloud page.
The fault was in `findSettingsEntries` (`apps/desktop/src/shared/settingsManifest.ts`):

1. "ade" is a filler word the finder drops, so "ade cloud" became the single word "cloud".
2. "cloud" matched inside the titles "Cloudflare" and "Cloudinary" with the same score as the whole word in "ADE Cloud".
3. The MCP catalog rows come first in the manifest, so they won the tie.

**Fix** (`shared/settingsManifest.ts`):
- `:2202`: "ADE Cloud" (also "ADE-Cloud") is kept as one phrase before the filler words are dropped.
- `:2196`: a synonym maps that phrase back to "ade cloud".
- `:2267` (new `wholeWordHits`): a whole word in a card's title now scores 9, above the same letters inside another word (8).

| Query | With access (dev CLI, owner) | Without an answer (`ade --socket /nonexistent/x.sock settings find …`) |
|---|---|---|
| `ade cloud` | ADE Cloud, then Sign-ins on ADE Cloud, then ADE Cloud lanes and computers | No setting matches |
| `cloud` | ADE Cloud first | Cloudflare, Cloudflare Docs, Cloudinary |
| `cloud plan` | ADE Cloud plans and billing, then ADE Cloud | PlanetScale, Cloudflare… |

I compared the old and new finder on every label and keyword in the manifest (1,034 queries). 34 result orders changed.
Every change is a whole word now beating a fragment: "build" leads with lane build output, not Buildkite; "custom" leads with harnesses, not Customer.io; "send" leads with diagnostics sharing, not Resend.
"providers", "dark mode", "pr chat transcripts" and "jira cloud" give the same results as before.
After the new `ade-cloud` tab landed, I ran it again. "ade cloud" finds "App › ADE Cloud" first; without access it finds nothing.

## The lead's new `ade-cloud` tab and INTEGRATION_IDS (checked)

- **All 6 entries on the tab have `group: "ADE Cloud"`, and no ADE Cloud entry sits on another tab** (checked by script).
  - So `isSettingAvailable` (`renderer/components/settings/settingsManifest.ts:41`) drops all of them for an account without access.
  - `availableSettingsTabs()` then drops the tab, for both the sidebar and the palette.
- **The sidebar list now updates when access changes.**
  - `SettingsPage.tsx:284` reads `useAdeCloudEnabled()`, and `cloudEnabled` is in the tab list's deps (`:294`).
  - Before this, the tab list was computed once, so the new tab would have been missing for the owner until something else made it recompute.
  - The command palette already depends on `cloudEnabled` (`CommandPalette.tsx:677`).
- **Old links:**
  - `ade://settings/integrations.ade-cloud` resolves to the `ade-cloud` tab, since `cloud-connection` resolves there.
  - Without access, that tab is not in `tabs`, so `resolvedTab` falls back to the default tab, and Settings opens there.
  - When the yes arrives, the same link opens the tab.
- **INTEGRATION_IDS without `cloud`:**
  - The `id !== "cloud" || cloudEnabled` filter (`IntegrationsHome.tsx:193`) and the `group !== "cloud"` filter (`settingsTabContent.tsx:227`) are now dead but harmless.
  - The `cloud` branch of `readSummary` in `IntegrationsHome.tsx` is dead too. Delete them when convenient.
- **Low risk, your file:** the `ade-cloud` tab's render (`settingsTabContent.tsx:551`) has no gate of its own; it relies on the tab being unreachable.
  - If access flips from yes to no while the tab is open and the URL has no `?tab=`, the open page stays until the user navigates away.
  - A one-line guard would close this: a wrapper that returns null when `!useAdeCloudEnabled()`.
- **iPhone settings catalog** (`apps/ios/ADE/Views/Work/WorkSettingsCatalog.swift`) is generated by `apps/desktop/scripts/generate-ios-settings-catalog.mjs`.
  - It still has the old paths ("App › Integrations › ADE Cloud") and lacks `ade-cloud.plans` / `ade-cloud.sizes`. Regenerate it.
  - Hiding does not depend on it: it only labels `ade://settings/…` links that already appear in a chat.

## What this track changed

| # | File:line | Change |
|---|---|---|
| 1 | `apps/desktop/src/shared/settingsManifest.ts:2196, 2202, 2267` | Item 2 (above) |
| 2 | `apps/desktop/src/renderer/components/app/SettingsPage.tsx:284, 294` | The sidebar tab list updates when access changes |
| 3 | `apps/desktop/src/renderer/components/settings/providers/cloud/SignInAccountCard.tsx:48, 92` | On an own computer's shared sign-in cards, "In use on ADE Cloud" shows only with access. The status marks a sign-in in use for ADE Cloud even for an account without access, so this was a real leak. |
| 4 | `apps/desktop/src/renderer/components/settings/providers/cloud/ProviderSignInsPanel.tsx:46, 88` | Copilot's GitHub CLI login row is hidden without access. It only copies the login for Copilot on ADE Cloud, and its lines name ADE Cloud. The shared sign-in cards stay, as the owner decided. |
| 5 | `apps/ade-cli/src/cli.ts:40473` | `providers accounts list --synced` asks for access (one brain request) |
| 6 | `apps/ade-cli/src/cli.ts:37091, 37110` | Without access, the `--synced` text output is titled "Sign-ins in your account" and leaves out the cloud computer row, the ADE Cloud sign-ins row and the per-sign-in cloud flags. Its JSON output is unchanged. |
| 7 | `apps/ade-cli/src/cli.ts:3956, 4635` | Two help lines no longer name ADE Cloud (the Android low-disk line, and the `--synced` line) |
| 8 | `apps/ade-cli/src/services/remoteMcp/remoteMcpProtocol.ts:14, 321` | The ADE MCP server instructions say "Before an ADE Cloud lane…" only when the `ade-cloud` skill is visible (same answer as the prompt list) |
| 9 | `apps/desktop/resources/agent-skills/ade-mcp-client/SKILL.md:46` | No `--machine cloud` steps; points to the `ade-cloud` prompt "only when it is listed" |
| 10 | `apps/desktop/resources/agent-skills/ade-android/SKILL.md:66` | "On an ADE Cloud computer…" becomes "Where the Android pane offers Grow the disk…" |
| 11 | `apps/ios/ADE/Views/Work/WorkRootComponents.swift:2217` | The "More" menu's VoiceOver hint names ADE Cloud only when the menu shows it |

Done by other helpers at my request, or alongside this track:
- **launch-fixes:** the saved ADE Cloud pick in the composer counts only with access.
  - `AgentChatPane.tsx:16793`: `adeCloudMode = adeCloudPicked && adeCloud.available`. The send path's ref follows it (`:16794`).
  - The saved pick is never cleared while the answer is unknown, so the owner keeps it across a restart.
- **client-cleanup:** removed the "New ADE Cloud machine" add-mode in Connections, and deleted `NewCloudMachineForm`, `NewCloudMachineDialog`, `CloudReadyMachinesCard`, `CloudMachinesCard` and `useCloudReadyDraftMachine`. Those surfaces no longer exist for anyone.

## Surfaces checklist: how to check each by eye with an account that is refused

Use the second (Gmail alias) account, signed in to ADE on this Mac.
Expected everywhere: no mention of ADE Cloud, and no empty or "Not available" ADE Cloud tile. Check right after sign-in too: there must be no flash before the answer.

### Desktop

| Surface | Gate (file:line) | What to look for with a refused account |
|---|---|---|
| Settings sidebar: ADE Cloud tab | `shared/settingsManifest.ts` group "ADE Cloud" → `renderer/components/settings/settingsManifest.ts:41`, `SettingsPage.tsx:284,294` | No "ADE Cloud" item in the sidebar. `ade://settings/integrations.ade-cloud` opens the default tab. |
| Settings › Integrations home | `IntegrationsHome.tsx:193` (`cloud` is also out of INTEGRATION_IDS) | No ADE Cloud tile ("Not available yet" must not appear) |
| Settings search box | `settingsManifest.ts:41` via `searchSettingsEntries` | Type "ade cloud": no results. "cloud": Cloudflare and Cloudinary only. |
| Command palette | `CommandPalette.tsx:677` + `availableSettingsTabs` | "ade cloud": no ADE Cloud tab or settings |
| Settings › Providers machine picker | `SettingsPage.tsx:659` (`offersAdeCloud`) | No "ADE Cloud" entry in the picker; `?machine=ade-cloud` shows This computer |
| Settings › Providers › a provider (shared sign-ins) | `SignInAccountCard.tsx:48,92`, `ProviderSignInsPanel.tsx:46,88` | Cards still show (owner decided), with no "In use on ADE Cloud" line. Copilot has no GitHub CLI login row. |
| Claude pass tiles | Only on cloud computers (`isClaudePassAccountId`); the ADE Cloud place is gated as above | None (the account has no cloud computers) |
| End-of-sign-in warning | `CloudSignInEndNotice.tsx:32` | No warning |
| Settings › Overview › needs attention | `useNeedsAttention.ts:336`, `machineUpdates.ts:127` | No ADE Cloud items |
| Chat composer › Run on | `useAdeCloudDraft.ts:142` (`available`), `AgentChatPane.tsx:17076` (row), `:16793` (saved pick) | No ADE Cloud row and no size menu. A draft that had ADE Cloud picked opens on a normal computer. |
| Machine setup rows in Run on | `useDraftMachineSetup.ts:78` | No ADE Cloud setup rows |
| New lane dialog (Lanes tab, PR tab, batch launch, issue launch) | `lanes/useAdeCloudLaneTarget.ts:29` (`offered`) | No ADE Cloud card or size in the machine picker |
| Automations rule builder | `automations/builder/RuleCloudField.tsx:31` | No "Run on ADE Cloud" switch |
| Connections (machines) | `remoteTargets/useCloudMachineGroup.tsx:64-65` (the cloud group and its list read) | No ADE Cloud group; no "New ADE Cloud machine" (removed) |
| Cloud lane cards / setup card | `cloudLane/CloudLaneWithoutComputer.tsx:168`, `remoteTargets/useCloudComputer.ts:21` | None |
| Chat, Android and Work-tool cloud cards (asleep, out of hours, Grow the disk) | `useCloudComputer.ts:21` | None |
| Saved chats of cloud computers | `state/cloudSavedChatsSync.ts:55` | None |
| Lane list's cloud lanes, machine chips "ADE Cloud · lane" | Data: only computers the account owns (`adeCloudLaneIndex.ts`, filled by gated reads) | None (no cloud computers) |
| Header ADE Cloud meter (lead's) | Must read `useAdeCloudEnabled()` and start its data read with it, e.g. `useCloudMachines(cloudOn, { settle: false })` as `useAdeCloudDraft` does; render nothing when false | No meter |
| Agent skill `ade-cloud` | `shared/agentSkillRoots.ts:118` (default hidden), main `withoutWithheldAgentSkillsEnv`, `claudeAgentSkillPluginRoots` | In a new Claude chat: no `ade:ade-cloud` in the skills list. See "Validated by hand" below. |

### CLI (run in a terminal on the refused account's Mac; `ade --socket /nonexistent/x.sock …` simulates "no answer")

| Command | Gate | Expected |
|---|---|---|
| `ade cloud status` | `cli.ts:23893` | `Unknown command 'cloud'. Run 'ade help'.` |
| `ade help`, `ade help cloud` | `cli.ts:1707-1712` (`withoutHiddenCloudHelp`, `helpPagesWithoutCloud`), `commandHelpText` | No cloud page. `ade help cloud` shows the general help. |
| `ade help chat`, `ade help lanes`, `ade help --json` | Same, removes `CHAT_CLOUD_READY_HELP` / `LANES_CLOUD_HELP` | No `--machine cloud` or `--machine cloud:ready` lines. Verified: the JSON catalog without an answer has no `cloud` command and no `--machine cloud` usage lines. |
| `ade settings find "ade cloud"` | `cli.ts` `findSettings` + item 2's fix | `No setting matches.` |
| `ade actions list` / `ade actions list cloud` | Brain: `adeRpcServer.ts:6415` | No `cloud.*` actions |
| `ade providers accounts list --synced --text` | `cli.ts:40473, 37091, 37110` | Title "Sign-ins in your account"; no "cloud computer" or "ADE Cloud sign-ins" rows, no "in use on ADE Cloud" flags |
| `ade skill list` (in an ADE chat) | `agentSkillCatalogService.ts:223-225` | No `ade-cloud` |
| ADE MCP server instructions | `remoteMcpProtocol.ts:321` | No "Before an ADE Cloud lane" sentence; no `ade-cloud` prompt in `prompts/list` |

### iPhone (paired to a machine signed in to the refused account)

| Surface | Gate | Expected |
|---|---|---|
| Work › "⋯" menu | `Views/Work/WorkRootScreen.swift:256` (`showsCloud = sync.cloudAvailable && sync.cloudSupported`) | No "ADE Cloud" entry. VoiceOver hint without "ADE Cloud" (`WorkRootComponents.swift:2217`). |
| Settings › Integrations | `Views/Settings/SettingsIntegrationsPage.swift:42` | No ADE Cloud card |
| ADE Cloud pane | Opened only from the two entries above (`cloudPanePresented`) | Unreachable |
| Settings chip labels | `WorkSettingsCatalog.swift` (labels only) | Not a surface (only labels a link already in a chat) |

`cloudAvailable` starts false and is asked again when the project, the host or the attach state changes (`WorkRootScreen.swift` around 1993, `SyncService+Cloud.swift:169`). An older machine, or no answer, means no.

### Web client (browser connected to a machine signed in to the refused account)

| Surface | Gate | Expected |
|---|---|---|
| Access answer | `webclient/adapter/misc.ts:1078`: `cloud.read access` on the connected machine, fallback `{enabled:false}` | Everything below follows it |
| Connections chip | `webclient/workspace/WebConnectionsChip.tsx:116` | No ADE Cloud bits |
| Settings, search and the composer | Same renderer gates as the desktop. Composer ADE Cloud is also off on the web (`useAdeCloudDraft.ts:142`, `!isWebClientMode()`). | Same as the desktop |

## Validated by hand

- **Item 2:** with the dev CLI from source (`npx tsx src/cli.ts`), with access (the owner's brain) and with no answer (`--socket /nonexistent/x.sock`), per the table above. The finder was also checked by script after the new tab landed.
- **CLI with no answer:**
  - `ade cloud status` is refused as an unknown command.
  - Top-level `ade help` is identical with and without access; it never listed `ade cloud`.
  - `ade help --json` without access has no cloud page and no cloud usage lines.
- **Skill withholding,** by running the real `withoutWithheldAgentSkillsEnv` and `claudeAgentSkillPluginRoots` on `apps/desktop/resources/agent-skills`:
  - With visibility false, the Claude plugin root is a private mirror with no `ade-cloud/` folder, and it still has `.claude-plugin/plugin.json`.
  - With visibility true, it is the original folder.
- **With access:** `providers accounts list --synced --text` shows the ADE Cloud rows, as before.

## Failure modes for /test

1. Item 2 coming back: a filler word or a word fragment beats the product name, so "ade cloud" or "cloud" finds Cloudflare for an account with access.
2. An account without access finds ADE Cloud in settings search. The check is by group, so any future entry on the `ade-cloud` tab without `group: "ADE Cloud"` leaks, and so does its tab.
3. The sidebar tab list does not recompute when access changes: the tab is missing for the owner after the yes, or stays after a no.
4. The skill mirror fails to copy and the code falls back to the unfiltered root (by design: "an extra skill costs less than no skills"), so `ade-cloud` reaches a chat without access. The failure is logged, but nothing hides the skill.
5. The CLI's access ask times out (5 s) for the owner: ADE Cloud help, `ade cloud` and settings search look absent. It fails closed, which is right for hiding but confusing for the owner.
6. A saved ADE Cloud composer pick renders a draft in ADE Cloud mode with no Run on row. Gated now (launch-fixes); this is the race to guard.
7. iPhone `cloudAvailable` stays true after the phone switches to a machine of another account, until the next project/host/attach change. Not seen; reasoned from the code.

## Still open

- **Second-account proof (lead):** run the tables above with the refused account on desktop, CLI, iPhone and web. I could not check the desktop or web UI with a refused account here.
- **Not shown:** the refused output of `providers accounts list --synced` needs a brain whose access answer is no. Its JSON output still has the `cloud` record and the `inUseOnCloud` / `onForCloud` fields; only the text output is gated.
- **Not opened by hand:** the MCP instructions. They read the same `adeWithheldAgentSkills()` answer I verified.
- **Regenerate** the iPhone settings catalog (`generate-ios-settings-catalog.mjs`) for the new tab's paths and entries.
- **Optional guard:** a gate inside the `ade-cloud` tab's render (`settingsTabContent.tsx:551`), for access flipping to no while the tab is open.
- **Dead code** to delete when convenient: the `cloud` branches in `IntegrationsHome.tsx` (`readSummary`, DESCRIPTIONS, the filter at `:193`) and `settingsTabContent.tsx:227`.
- **Deliberately not hidden:**
  - Error messages that appear only when someone types `--machine cloud` (the server refuses with "ADE Cloud isn't available on this account yet.").
  - Code comments.
  - Rows that exist only when the account owns a cloud computer: chat chips, Claude pass cards, the size-change card, saved cloud chats. A never-allowed account has none.
- **Edge case:** an account whose access is removed while it still owns cloud computers would see those computers as plain computers (the lane index is not gated). A never-allowed account has none.
- **Edge case:** the composer's saved ADE Cloud pick belongs to the project's Work state, not to the account. After switching accounts on one Mac, the owner's pick stays saved but inactive until an account with access signs in.
