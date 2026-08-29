# Handoff: iOS plugin pane is empty while the same plugins work on desktop

Date: 2026-08-28
Severity: P0 for plugin-on-iPhone. Overflow shows the plugin; the sheet says it has not published anything.
Lane / branch: plugin-platform (worktree alpha-build-1b4714f3)
Do not “fix” the plugins for this. HN and Focus are publishing real panels with mobile: true on the brain. The phone never receives those rows. This is host / sync / iOS sheet, not authoring.

After this is fixed in ADE, we will rebuild this Debug iOS build onto the iPhone 16 Pro and re-run the checklist at the bottom. Do not treat a Mac-only doctor-green as done.

## One-sentence bug

On a live Alpha pairing, iOS Work overflow can list and invoke HN / Focus (RPC), then opens PluginPaneSheet, which reads only the local CRR table plugin_panels, finds zero mobile rows, and shows “No panels yet” / “<plugin> has not published anything to show here.” The same panels are present and healthy on the Mac.

## Why this matters

The plugin platform’s iPhone story is: install on the machine, the phone grows a native pane from replicated plugin_panels. If that table never lands, every third-party plugin looks like a stub. Built-in overflow still works because it is a different data path. Users (correctly) conclude “the plugin is broken” or “I’m on the wrong ADE.” Neither is true here.

We already dogfooded two real plugins against Alpha. Both fail the same way on device. That is the product bug, not two bad plugins.

## Environment (repro machine)

- Mac: MacBook Pro (97) — ComputerName. Alpha and Stable would both show this string. It is not an Alpha/Stable discriminator.
- ADE app under test: ADE Alpha.app 1.0.0-beta.1, ADE_HOME=~/.ade-alpha
- Brain: pid 44556 (at time of dogfood), sync port 8787, deviceId 73bb1e93-bd05-4ebb-9295-a87ea3003e15
- Account directory: HTTP 403 pairing_authentication_required — “Sign in to your ADE account again.” Orthogonal. Header actions still ran.
- Project: ADE /Users/arul/ADE (also registered: Versic, crumb). Panels were read from the ADE project.
- iPhone: iPhone 16 Pro (iPhone17,1), CoreDevice id 727ED3EC-8218-5BCF-922F-97A03CFFEAAE, hardware UDID 00008140-00116D8A3802201C
- iOS binary: Debug com.ade.ios from this lane, CFBundleShortVersionString 1.1.10 / CFBundleVersion 4, built+installed 2026-08-28 13:24. No Swift changes after that install.
- Plugins: hn 1.0.0 (plugins/hn), pomodoro 1.0.1 display name Focus (plugins/pomodoro, still untracked in git). Both enabled and running.

Proof the phone was on this Alpha, not “some other MacBook Pro”:
ade plugin doctor hn → Last run: openStories.
ade plugin doctor pomodoro → Last run: openTimer.
Those invocations hit this Alpha brain at the moment the user tapped overflow on the 16 Pro (about 15:20–15:27 local on 2026-08-28). Settings copy was “Connected to MacBook Pro 97.” That is this machine’s name.

ade sync status often showed connected peers 0 during the same window. Do not use that counter as “the phone is not attached.” RPC invoke succeeded. toSyncPeerConnectionState drops peers with no hello metadata (syncHostService.ts); a phone can still have been on the socket. Treat action Last run + iOS “Connected to <ComputerName>” as ground truth for pairing.

## Repro (exact)

1. ADE Alpha on MacBook Pro (97), plugins hn and pomodoro installed, enabled, running.
2. Debug ADE 1.1.10 (4) from plugin-platform on iPhone 16 Pro, Settings shows Connected to this Mac.
3. Open Work, open any chat, tap the header overflow.
4. Tap HN (or Top/New/Ask). Sheet: “No panels yet” / “hn has not published anything to show here.” (wording uses display name if presence catalog has it; we also saw the id).
5. Repeat for Focus. Same empty sheet.
6. On the Mac, immediately (use Alpha CLI, not PATH ade):

    ADE_HOME=~/.ade-alpha
    ade plugin doctor hn --text
    ade plugin doctor pomodoro --text
    ade actions run plugin.getPanel --input-json '{"pluginId":"hn","panelId":"stories"}'
    ade actions run plugin.getPanel --input-json '{"pluginId":"pomodoro","panelId":"timer"}'

Doctor: both running; 1/1 HN panels published; Focus 4 published / 3 in manifest (stale extra row, see below).
getPanel: both return full vocab bodies with "mobile": true. HN stories updated ~19:26Z on the day of the repro; Focus timer the same.

Desktop Work: HN and Focus header actions navigate to a real panel (tools pane / overlay). This is not “the plugin never published.”

## Expected vs actual

Expected: Overflow invoke returns { navigate: { panelId } }. iOS presents PluginPaneSheet for that plugin/panel. Sheet reads a local plugin_panels row with mobile != false, parses vocab, draws the list / timer.

Actual: Invoke works (doctor Last run). Sheet presents. PluginPaneStore.load() → sync.pluginPanels(pluginId:) → database.fetchPluginPanels filtered by .mobile → empty → resolvePresentation() returns .missing → empty state in PluginPaneSheet.

The empty-state copy is actively misleading. The plugin has published. The phone replica does not have the row. The user is told the plugin is empty.

## Architecture (this split is the bug)

Two sources, documented in iOS itself, and they disagree in production.

### Path A — “is this plugin here?” (works)

- PluginPresenceGate + plugins.list / plugins.presenceList over the live socket.
- Chat header overflow (PluginChatHeaderMenuItems in PluginSocketViews.swift) is built from manifest socket declarations returned by plugins.list, merged with any plugin_contributions rows.
- Doctor on both plugins: “0 rows published right now” for places, and iPhone ✓ chat-header-action. Overflow does not need CRR plugin_contributions.
- Tap → invokeChatHeaderPluginAction → invokeSocketContribution → plugins.invoke on the brain → plugin returns { navigate: { panelId } } (Focus also { openWebview: { surfaceId: "timerDial" } }, which iOS ignores by design).
- presentedPluginPane = PluginPaneRequest(...) unconditionally if navigate is present. No check that local panels exist.

HN (plugins/hn/index.js): { navigate: { panelId: "stories" } } and it must not await the HN fetch before returning that (host would leave Work / flash empty).
Focus (plugins/pomodoro/index.js): { openWebview: { surfaceId: "timerDial" }, navigate: { panelId: "timer" } } so desktop gets the dial overlay and iOS is supposed to get the vocab timer panel.

### Path B — “what do I draw?” (fails)

- PluginPaneSheet / PluginPaneStore.load() only reads the local SQLite mirror.
- SyncService.pluginPanels (apps/ios/ADE/Services/SyncService.swift ~9535):

    func pluginPanels(pluginId: String? = nil) -> [PluginPanelRecord] {
      database.fetchPluginPanels(pluginId: pluginId).filter(\.mobile)
    }

- .mobile is not a SQL column. Frozen CRR shape. Flag lives in schema_json (PluginRecords.mobileFlag(inSchemaJSON:)). Missing key defaults true (back-compat).
- Host seeds mobile in pluginHostService.seedDeclaredPanels via pluginPanelShowsOnMobile(surface). HN stories is a tab surface → mobile. Focus timer has no surfaces[].panelId === "timer" (webview is timerDial) → seeder treats unnamed panels as mobile true. Confirmed on the wire by getPanel.
- There is no plugin.getPanel RPC fallback on iOS when the local row is missing.

### Path C — puzzle-piece entry menu (related, not this repro)

PluginEntryListModel.refresh() drops any installed plugin with panelCount == 0 (PluginEntryMenu.swift ~48–51). If plugin_panels is empty, the root puzzle-piece should hide HN/Focus entirely. Our repro used Work chat overflow, which does not apply that guard. That is why overflow can show the plugin and the sheet can still be empty. If you only test the puzzle piece, you will think “plugins are not installed on iOS” and miss this.

## Root-cause candidates (ranked)

The Mac has the rows. The phone sheet does not. Something in outbound plugin CRR or apply is dropping them and then advancing the phone’s cursor anyway, so incremental export never sends the skipped range again.

### 1. Mobile replica reseed retry without plugin tables (most likely on a large ADE project)

apps/ade-cli/src/services/sync/syncHostService.ts ~4844–4905.

Reseed scan is capped (MOBILE_REPLICA_RESEED_MAX_ROWS = 10_000, MAX_BYTES = 4 MiB in mobileReplicaReseed.ts). If the first pass is too_large, the host retries with SYNC_PLUGIN_TABLES excluded, then still reseeds the phone to targetDbVersion.

The file already states the hazard: excluding plugin tables from the build looks safer and is not. The reseed advances a phone’s cursor all the way to targetDbVersion, so a phone that CAN apply plugin rows would skip every one in the reseeded range and never see them again.

The retry pass does exactly that for every phone, including ones that advertised pluginTables. ADE’s project DB is large. This machine is a realistic too_large victim.

Logs to grep on the Alpha brain (not ade search, which only hits the repo):

- sync_host.mobile_replica_reseed_started
- sync_host.mobile_replica_reseed_retrying_without_plugins
- sync_host.mobile_replica_reseed_ready / _skipped
- sync_host.mobile_replica_reseed_sent
- changeset nack / changeset_apply_failed / FOREIGN KEY

If you see retry-without-plugins for this iPhone’s device/site id, that is the smoking gun. Fix: never advance a pluginTables peer’s cursor past versions that contained plugin rows you chose not to send. Either fail reseed, send a plugin-only follow-up batch, or keep those table clocks out of the watermark.

### 2. Fail-closed pluginTables gate + cursor still advancing

SYNC_PLUGIN_TABLES = plugin_presence, plugin_panels, plugin_collections, plugin_contributions (apps/desktop/src/shared/types/sync.ts ~170).
peerAcceptsPluginTables / isPluginChangeAllowedForPeer in syncHostService.ts ~387–428. Comment: outbound filter drops rows and the peer’s ack watermark still advances through the filtered versions.

This Debug iOS build does advertise pluginTables in hello (SyncService.swift ~16795–16808). Confirm in host logs that the actual hello from this phone included it. If a previous pairing (TestFlight / older Debug) connected without the capability, the cursor may already be at head with plugin rows filtered. Same device identity + updated binary does not rewind the cursor. Then a pluginTables phone still never receives historical plugin_panels.

Fix: capability upgrade must re-export plugin tables from 0 (or from last version that included them), not inherit a watermark taken while the peer was incapable.

### 3. Apply failure on the phone (FOREIGN KEY / missing table / extra column)

iOS uses stock SQLite + SQL CRR (Database.swift, DatabaseBootstrap.sql). A changeset naming a table/column the phone cannot apply nacks the batch. Historical ADE iOS bugs included FOREIGN KEY on changeset_batch when CRR order violated phone FKs that desktop does not enforce.

If apply fails, you should see nacks and a stuck cursor, not a quiet empty table with a live UI. Still check the phone DB:

    Application Support/ADE/ade.db
    SELECT plugin_id, panel_id FROM plugin_panels;
    SELECT plugin_id FROM plugin_presence;

Expected after a good sync: at least hn|stories and pomodoro|timer (and Focus prefs / timerDial). If the table exists and is empty while chats/lanes did replicate, plugin tables were filtered. If the table is missing, bootstrap/capability is wrong.

### 4. Wrong-project replica (less likely here)

plugin_panels is per-project ade.db. Phone mirrors the attached machine’s current project. We invoked against ADE and getPanel was ADE. If the phone’s replica were Versic/crumb with no plugin seed, you could get this UI. Check the phone’s project id vs ADE (project_474a7274395793c28…). Still, overflow plugins.list is machine-scoped installs; empty panels on the active project is the reported shape.

## What we already ruled out

- Plugins never published panels — getPanel + doctor Panels rung green; mobile: true
- HN/Focus marked desktop-only — seeder + getPanel; HN tab defaults mobile; Focus timer has no webview surface
- User on Stable ADE — openStories / openTimer Last run on Alpha (ADE_HOME=~/.ade-alpha)
- Need a new iOS IPA for plugin changes after 13:24 — plugin UX (Focus 1.0.1) is CRR/RPC. Swift was not changed. Rebuilding the same 1.1.10 (4) will not fill plugin_panels
- iOS doesn’t support chat-header-action — doctor: iPhone ✓ chat-header-action. Overflow is how we opened the sheet
- work-rail-pane missing on iOS — expected. Doctor: iPhone ✗ work-rail-pane. Phone is supposed to use header → pane, not a tools rail
- openWebview on iOS — ignored by design. Focus also returns navigate.panelId = timer for that reason
- Directory 403 — blocked account directory / machine list. Did not block LAN/Tailscale invoke
- “Just delete the iOS app” as a user workaround — only helps if the next reseed includes plugin tables. If too_large retries without them, you reset the replica and still skip plugins, then park the cursor at head again

## Code map (start here)

iOS empty sheet:

- apps/ios/ADE/Views/Plugins/PluginPaneSheet.swift ~137–142 — .missing copy
- apps/ios/ADE/Views/Plugins/PluginPaneStore.swift ~156–164, ~210–211 — load + .missing when no local panel
- apps/ios/ADE/Services/SyncService.swift ~9526–9537 — local-only pluginPanels, .mobile filter
- apps/ios/ADE/Views/Plugins/PluginSocketViews.swift invokeSocketContribution ~281–300 — open sheet from navigate with no local-row check
- apps/ios/ADE/Views/Plugins/PluginSocketViews.swift ~1059+ — chat-header overflow from live contributions
- apps/ios/ADE/Views/Plugins/PluginEntryMenu.swift ~12–25, ~48–51 — puzzle piece requires panelCount > 0
- apps/ios/ADE/Models/PluginRecords.swift ~85–146 — frozen SQL, mobile in JSON
- apps/ios/ADE/Services/Database.swift ~533+ — fetchPluginPanels
- apps/ios/ADE/Services/SyncService.swift ~16795–16808 — hello pluginTables
- apps/ios/ADE/Resources/DatabaseBootstrap.sql — must contain the four plugin tables

Host seed + sync:

- apps/desktop/src/main/services/plugins/pluginHostService.ts ~1198–1267 — seedDeclaredPanels, mobile stamp
- apps/desktop/src/shared/plugins/manifest.ts pluginPanelShowsOnMobile
- apps/desktop/src/shared/types/sync.ts SYNC_PLUGIN_TABLES, SYNC_PLUGIN_TABLES_CAPABILITY = "pluginTables"
- apps/ade-cli/src/services/sync/syncHostService.ts ~387–428 outbound plugin filter; ~1463 toSyncPeerConnectionState; ~4844–4938 mobile reseed including retry without plugins; sendMobileReplicaReseed still filters per isPluginChangeAllowedForPeer
- apps/ade-cli/src/services/sync/mobileReplicaReseed.ts — caps
- apps/ade-cli/src/services/sync/syncHostService.test.ts — “withholds plugin rows from a peer that does not advertise pluginTables”; add a test that a pluginTables phone must not ack a reseed that omitted plugin tables

Plugins (do not rewrite to “fix iOS”; they are the fixtures):

- plugins/hn/plugin.json — chat-header-action + work-rail-pane → panel stories; collections stories sync false, read sync true
- plugins/pomodoro/plugin.json — header Focus; vocab panel timer; webview timerDial (desktop overlay). Doctor 4 published / 3 in manifest: leftover history panel row after UX cut. Host does not prune on reload. Harmless on desktop; ignore unless it confuses panel counts.

## Suggested fix directions (product, not a patch from the dogfood chat)

Pick one and make it testable. Combining 1+2 is the robust answer.

1. Never skip plugin tables for a pluginTables peer. If reseed cannot fit them, do not pretend the replica is complete. Follow-up plugin-only changeset, or refuse to advance that peer’s cursor through omitted versions. The comment in syncHostService.ts already describes the wrong outcome.

2. Capability upgrade / first pluginTables hello: re-export SYNC_PLUGIN_TABLES from the beginning of those tables’ clocks, even if dbVersion is already at head.

3. iOS sheet fallback: if navigate names a panel and local plugin_panels has no row, RPC plugin.getPanel (and collection reads) instead of .missing. Live overflow already trusts the socket; the sheet should not be the only surface that requires a full CRR copy. Keep CRR as the offline/cache path.

4. Honest empty state: if invoke succeeded and the brain has a panel, do not say the plugin “has not published anything.” Say the replica does not have the panel yet (or retry fetch). Today’s copy sent us on a plugin-author goose chase.

5. Telemetry: log peer deviceId, pluginTables yes/no, reseed retriedWithoutPlugins, plugin row counts sent, apply nacks. connected peers in ade sync status should count authenticated iOS or explicitly say it does not.

Out of scope for this empty sheet but already seen on the same Alpha dogfood (file separately, do not conflate):

- Packaged renderer dropping {navigate} to /plugin/... until serializeProjectRoute allows /plugin (commit 681b77dcc on this branch; needs a rebuilt Alpha, not plugin.reload).
- Chat-header navigate preferring Work tools pane when work-rail-pane exists (700c62125).
- iOS ignores openWebview (Focus dial is desktop-only; vocab timer is the phone UI).
- Cursor SDK requestChatInput is not a function until native Alpha install card (-32011).
- Leftover plugin_panels rows after a panel is removed from the manifest.
- Account directory 403 on this Alpha (pairing_authentication_required).

## Acceptance criteria (we will rebuild iOS here and retest)

Do not sign off on doctor-green on the Mac alone.

Must:

1. iPhone 16 Pro, Debug ADE from the fixed host+iOS pair, Settings connected to this Alpha (ADE_HOME=~/.ade-alpha). ComputerName MacBook Pro (97) is not sufficient by itself — confirm openStories Last run updates when you tap.
2. Work overflow → HN → sheet shows the stories list (feeds Top/New/Ask), not “No panels yet.”
3. Mark one story read; it stays read after sheet close/reopen; desktop HN unread filter agrees (read collection sync true).
4. Overflow → Focus → sheet shows the timer vocab panel (clock, start/break/stop, lengths, history list). Not empty, not a blank webview.
5. On device ade.db: plugin_panels contains hn/stories and pomodoro/timer with mobile-true schemas.
6. Brain logs for that pairing: no mobile_replica_reseed_retrying_without_plugins that still acks the phone to head, or if reseed is still capped, a follow-up plugin batch is sent and applied before UI is used.
7. Regression test: pluginTables peer + oversized DB must not lose plugin_panels forever. Preferred: unit/integration around advanceMobileReplicaReseedCache / sendMobileReplicaReseed / cursor adoption.

Should:

8. Puzzle-piece menu lists HN/Focus once panels exist (panelCount > 0).
9. Empty state copy is accurate if replica is still catching up.
10. ade sync status reflects the phone or documents that it does not.

Must not:

11. “Fix” by making HN/Focus await network before {navigate}.
12. “Fix” by adding iOS-only plugin hacks or by asking plugin authors to republish on a timer (the host already seeds schemaFile for that).
13. Ship a Mac-only workaround and call iPhone done.

## Retest recipe for this lane (after your PR)

    Worktree: /Users/arul/ADE/.ade/worktrees/alpha-build-1b4714f3
    Branch: plugin-platform
    Alpha: ADE_HOME=~/.ade-alpha  (not ~/.ade)
    Device: iPhone 16 Pro  727ED3EC-8218-5BCF-922F-97A03CFFEAAE
    Prior Debug app: .ade/cache/ios-device-build/Build/Products/Debug-iphoneos/ADE.app
    Install: xcrun devicectl device install app --device 727ED3EC-8218-5BCF-922F-97A03CFFEAAE "<ADE.app>"
    Plugins stay: ade plugin list / doctor hn / doctor pomodoro

Rebuild iOS from this lane after the host fix is in the runtime the phone talks to (packaged Alpha brain, not only the worktree). Then run Must #1–6 on device. Do not treat “peers 0” or “Connected to MacBook Pro 97” as the pass/fail signal; Last run + visible panel + phone plugin_panels rows will.

## Contact / fixtures

Dogfood plugins live in this worktree: plugins/hn, plugins/pomodoro. They are the smallest real fixtures (header action, vocab panel, one synced collection). Keep them installed on Alpha while you debug sync. Questions on the dogfood pass: ADE chat session 9d65927d-1f13-49f1-a404-5a6704995a36 on lane alpha-build-1b4714f3.
