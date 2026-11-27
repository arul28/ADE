# Rebrand checklist: every place a person can still see "ADE"

Audit of the ADE -> Daex rename for edge cases the copy workers and the plan
can miss. Snapshot of branch `ade/ade-to-daex-rebrand-assessment` at
`23c64c6df` (2026-11-27). Workers were still committing while this was
written, so re-run the scans at the end before ticking items off.

Read `README.md` (rules, frozen identifiers) and `desktop-packaging.md`
(installer, bundle and OS names per platform) first. This page does not repeat
them; it lists what they do not cover, plus a status for each area.

**Columns:** *Where* is a file:line or an outside service. *Sees* is what a
person sees. *Action* is rename, keep (with the reason), or owner decision.
*Who* is "code" (an agent in this repo) or "owner" (a dashboard only the owner
can reach).

**Counting rule used below:** a "line" is a non-comment source line with the
word `ADE` standing alone (not `ADE_*`, not `AdeFoo`, not `.ade`), test files
excluded.

| Area | Lines still saying ADE |
|---|---|
| `apps/ade-cli/src` (CLI output, brain messages, service install text) | ~2,000 in 205 files (`cli.ts` alone 647). No worker owns it yet. |
| `apps/desktop/src/main` | ~630 in 130 files (most are agent-facing: step 3) |
| `apps/desktop/src/renderer` | ~96 in 40 files (mostly agent prompts and log lines; a few real UI) |
| `apps/desktop/src/shared` | ~170 in 46 files (mostly agent text and matchers) |
| `apps/ios/ADE` | ~330 in 49 files (most are `NSError(domain: "ADE")`, frozen) |
| `apps/desktop/scripts`, `scripts/` | ~330 (installer, uninstaller, firewall, wrappers, release checks) |
| `apps/web/public/demo` (built bundle) | 1,888 occurrences: a committed build of the renderer |
| `apps/desktop/resources/agent-skills` | 446 in 19 skills |
| Docs site `.mdx` | 5 pages + 178 changelog pages |

---

## 1. Logos and icons

New masters: `assets/brand/daex/` (release, Beta, Alpha; macOS, iOS, flat;
`glyph-mask.png`). The old mark is the purple "ADE" letters, either as a
1012x493 wordmark (`logo.png`, 72,949 bytes, copied to many places) or as the
purple rounded "ADE" app icon.

### 1a. Done on this branch (verify on device, nothing to redo)

| Asset | Path | Format / size | Referenced by | Commit |
|---|---|---|---|---|
| Desktop app icons | `apps/desktop/build/icon.icns`, `icon.beta.icns`, `icon.alpha.icns`, `icon.ico`, `icon.png`, `icons/16..1024x*.png` | icns; ico (multi-layer); png 16-1024 | `package.json` `build.mac.icon`, `build.win.icon`, `build.linux.icon`; `main.ts:1217-1232` window/dock icon; `run-electron-builder.mjs` channel icons; `build-music-host-win.mjs` exe icon | fade6e71a |
| Dev dock icon | `apps/desktop/build/icon.dev.png` (generated, not tracked) | png | `scripts/generate-dev-icon.cjs` rebuilds it when `icon.png` is newer | automatic |
| Renderer wordmark / mark | `apps/desktop/src/renderer/public/logo.png`, `logo-light.png` (now 1138x868), `welcome/ade-icon.webp` | png, webp | `AdeWordmark.tsx`, `LiquidGlassLogoReveal.tsx`, `liquidGlass/logoTexture.ts`, `GeneralPage.tsx:237` (About), `AdeQrCode.tsx:24`, `ChatComputerUseActions.tsx:155`; web client `app.ade-app.dev/logo.png` | a1f030d05 |
| Web client favicon | `apps/desktop/src/renderer/webclient.html:13` (inline 32 px PNG) | data URI | browser tab | a1f030d05 |
| Site icons | `apps/web/public/favicon.png`, `favicon.ico`, `apple-touch-icon.png`, `icon.png`, `logo.png`, `images/ade-dock-icon.webp`, `images/home/ade-icon.png`, `demo/logo.png`, `demo/welcome/ade-icon.webp` | png/ico/webp | `apps/web/index.html`, site header/footer, `/open` page | 02293706c, d23dbb1e9, 1232ddc55 |
| Docs site | `logo/daex-light.png`, `logo/daex-dark.png` (358x128), `favicon.png` (512) | png | `docs.json:13-16` | 02293706c, d23dbb1e9 |
| README banner logo | `assets/logo.png` (1280x400) | png | `README.md:3` | d23dbb1e9 |
| iOS app icons | `apps/ios/ADE/Assets.xcassets/AppIcon.appiconset/icon.png`, `AppIconBeta.appiconset/icon.png` (1024) | png | pbxproj `ASSETCATALOG_COMPILER_APPICON_NAME` (app, App Clip and widgets use `AppIcon`; Beta uses `AppIconBeta`) | 6521c1ef7, 623c30c82 |
| iOS in-app marks | `BrandMark.imageset/brand-mark@1-3x.png`, `BrandGlyph.imageset/brand-glyph@1-3x.png` | png | SwiftUI `Image("BrandMark")` | 5db317381, 623c30c82 |
| App Store generator art | `apps/ios/marketing/appstore-screenshots/app-icon.png`, `logo.png` | png | `index.html:175,253-273` | c55cccac6 |
| Email logo | `LOGO_URL = https://ade-app.dev/logo.png` (`apps/account-directory/src/cloud/email.ts:11`) | served from `apps/web/public/logo.png` (kept 1012x493) | every Daex Cloud and welcome email | fixed by the file swap; live after the site deploys |
| PR "Open in Daex" footer logo | `https://ade-app.dev/logo.png` (`apps/desktop/src/shared/adeDeeplinkFooter.ts:12`, `height="18"`) | same file | every PR body ADE ever wrote | fixed by the file swap, **including old PRs** (same URL). GitHub's camo cache may show the old logo for a while. |

No custom NSIS sidebar/header bitmaps and no DMG background exist (installer
uses electron-builder defaults plus `icon.ico`; DMG is plain `hdiutil`), so
there is nothing else to redraw there. There is no tray / menu-bar icon (no
`new Tray(` in the desktop app). Notifications use the app icon on every OS.

### 1b. Still the old ADE mark: must replace

| # | Where | Format / size | What a person sees | Action | Who |
|---|---|---|---|---|---|
| L1 | `apps/account-directory/src/brandPage.ts:22-23` (`LOGO_DARK`, `LOGO_LIGHT`, inline base64 WebP, 264x128) | webp data URI | The old "ADE" wordmark on the GitHub App sign-in pages, device sign-in pages and the billing return page (decoded and checked). | Rename: re-cut from the new mark (`assets/brand/daex/` or `logo/daex-*.png`) to the same width, re-inline. | code |
| L2 | `apps/ade-cli/src/services/remoteMcp/remoteMcpOAuth.ts:380,424` (`ADE_LOGO_URL = https://app.ade-app.dev/logo.png`, `width="62" height="30"`, `alt="ADE"`) | img tag | Consent page when Claude.ai / ChatGPT connects to ADE MCP. The file it loads is now the new mark, but it is **1138x868**, so the fixed 62x30 box squashes it; alt text still says ADE. | Rename: fix the size (drop `height` or use the new aspect) and `alt`. | code |
| L3 | `apps/desktop/native/ADEDesktopDriverLinux/assets/ade-mark.png` (720x350, embedded by `src/wallpaper.rs:25`) | png in a Rust binary | The ADE wordmark on the wallpaper of every Linux lane screen (seen in the lane-screen viewer and in proof videos). | Rename: new mark at the same size; rebuild the driver. | code |
| L4 | `apps/desktop/native/ADEMusicHostWin/page/ade-icon.png` (240x240; also shipped to the macOS host by `build-music-host-mac.mjs:14`, `validate-mac-artifacts.mjs:297`) | png | The old purple ADE icon in the Apple Music player page (Windows and Mac music hosts), linked from `page/index.html:12`, `player.js:258`. | Rename (keep the file name; it is wired into scripts and validators). | code |
| L5 | `apps/web/public/og-image.png` (1200x630) and `assets/readme/hero.png` (1200x630) | png | Link previews (X, Slack, iMessage, Discord) and the README hero: icon is new but the screenshot inside shows the "ADE" top bar, "What ADE is", "ADE Landing Page Redesign". | Rename: re-capture from the renamed app. Social sites cache previews for days; re-scrape after deploy (X card validator, Slack unfurl cache, LinkedIn inspector). | code (capture), owner (re-scrape) |
| L6 | Screenshots of the old UI showing the "ADE" top-bar wordmark and ADE copy: `apps/web/public/images/hero-v2/*.webp`, `images/home/wall/*.webp` (15), `images/home/tools/*.webp` (4), `images/secondPage/*.webp` (10), `images/home/demo-poster.jpg`, `film/*.jpg` + `*.mp4` (6), `videos/*.webp` + `*.mp4` (16), `images/hero/*.webp`; `assets/readme/desktop.webp`, `phone.webp`, `start.gif`, `compose.gif`, `machines.gif`; `media/current/*.jpg/webp` (8, used by docs pages); `apps/desktop/src/renderer/public/welcome/desktop.webp`, `mobile.webp`, `video-poster.jpg` and `apps/web/public/demo/welcome/*` (onboarding welcome); `apps/desktop/src/renderer/components/announcements/pages/assets/*` (34, What's New pages, e.g. `ade-cloud.webp` shows "ADE" top bar, "ADE Cloud", "ADE MCP"); `apps/desktop/src/renderer/components/onboarding/tips/assets/*` (28) | webp/jpg/gif/mp4 | Old name in product shots on the site, README, docs, onboarding and in-app What's New. | Priority: site hero, README, onboarding welcome first; announcement pages for past features can stay (they describe a past release) unless shown in onboarding. Check `images/hero/` and `videos/` are still referenced before re-shooting; delete if unused. | code |
| L7 | `apps/ios/marketing/appstore-screenshots/out/*.png` (7, 1320x2868), `ipad/en-US/*.png` (2), source captures `screenshots/*.png` (5) | png | App Store listing screenshots (old icon, old copy). The generator copy was renamed but `out/` was last built in #897. | Rename: re-capture `screenshots/`, rebuild `out/`, upload. | code + owner (upload) |
| L8 | `apps/web/public/demo/**` (built renderer bundle, 1,888 "ADE" occurrences) | js/css/images | The live demo on the site (`/demo/`) still shows the old app. | Rename: rebuild after the copy rename lands: `cd apps/desktop && npm run build:demo` (writes `apps/web/public/demo`). | code |
| L9 | `docs/design/renders/*.png` (4) | png | Internal design docs only. | Keep (internal, historical). | - |

**Not an issue:** provider/editor/competitor logos (`assets/provider-logos`,
`editor-logos`, `media/logos/*`, `images/competitors/*`), Spotify marks, scene
wallpapers. No Lottie/Rive files exist. No tracked SVG contains "ADE" text.

---

## 2. Text the workers likely missed

### 2a. Live bugs: matchers that no longer match the renamed text

A producer now says "Daex", but its consumer still looks for "ADE". These
are regressions introduced by the rename and should be fixed before merge.

| # | Where | Producer (renamed) | Effect | Action |
|---|---|---|---|---|
| M1 | `apps/desktop/src/renderer/components/chat/chatNotice.ts:68` `MACHINE_CONNECTION_DROPPED = /remote (?:runtime\|ADE service) connection .../` | `Remote ${BRAND.NAME} service connection closed/failed/was interrupted` (`runtimeRpcClient.ts:178-189`, `remoteConnectionPool.ts:1988`, `pairedRuntimeErrors.ts:223,240`, `localRuntimeConnectionPool.ts:2350`) | A dropped connection to another machine shows the raw error instead of the friendly "connection dropped" notice. | Accept both: `(?:ADE\|Daex) service`. |
| M2 | `apps/desktop/src/renderer/lib/plainError.ts:39` `UPDATE_ADE_SENTENCE = /\bUpdate ADE on\b/i` | `Update ${BRAND.NAME} on that computer …` (`accountConnectionRoutes.ts:86`, `accountMachineInventoryLiveRefresh.ts:287`, `ownerAwareNavigation.ts:255`, `runtimeBridge.ts:2138`, …) | The "update" next-step button no longer appears on those errors. | Accept both: `/\bUpdate (?:ADE\|Daex) on\b/i`. |
| M3 | `apps/ade-cli/src/cliAndroid.ts:419` `message.includes("ADE Cloud box")` | `cloudAndroidNeedsVmMessage` (`shared/adeCloud.ts:384`) no longer contains "box" either | Dead matcher (already stale before the rename): the cloud Android hint never shows. | Match on the error code plus "Daex Cloud"/"ADE Cloud", or on a stable code. |

Already fixed by ac559ee89 / be95dee96 / 8483f879b: browser error prefix
(`builtInBrowserRemote.ts`), device sources, chat launch, code-block run,
lane move, PR search, remote version warnings, provider doctor, Claude auth,
OAuth preview errors, cloud sign-in retry, `expectedFailure.ts`,
`runtimeErrors.ts`, `codedError.ts`, `types/sync.ts`, `githubAutolinks.ts`.

### 2b. Matchers that must accept both names the day their producer changes

Each pair below is fine today because the producer still says ADE. Whoever
renames the producer (mostly step 3) must widen the matcher in the same
commit, and keep accepting "ADE" forever where the text is stored.

| Producer | Matcher(s) | Stored? |
|---|---|---|
| `[ADE] Large … was shortened` / `[ADE] … bytes were left out` (`shared/chatEventCompaction.ts:53-259`); person-visible in the chat | `chatEventCompaction.ts:198`, `renderer/components/chat/chatTranscriptRows.ts:1757`, `ios/ADE/Views/Work/WorkEventMapping.swift:1095`, `main/services/storage/legacyChatTranscripts.ts:116,120` (`[ADE] chat transcript limit reached`) | Yes, in transcripts: accept both forever. |
| `ADE restarted while …` (`shared/chatAutoResume.ts:331,918`) | `ios/ADE/Views/Work/WorkTimelineHelpers.swift:5532` `hasPrefix("ADE restarted while ")`; desktop already has `LEGACY_RESTART_INTERRUPTED_NOTICE_PREFIX` (`chatAutoResume.ts:573`) | Yes. |
| `CHAT_STOP_REASON_BRAIN_RESTARTED = "the ADE brain restarted"`, `CHAT_STOP_REASON_FOREIGN_BRAIN` (`shared/types/chat.ts:47-48`); shown as a stop reason | compared in `chatAutoResume.ts:645-646` against stored stop reasons | Yes: add the Daex strings, keep the ADE ones in the comparison set. |
| Session preambles: `ADE session guidance`, `You are working in ADE lane`, `## ADE CLI primer`, `[ADE launch directive]`, `## ADE`, `System context (… ADE continuity …)` (`shared/cliLaunch.ts:1091-1096`, `chat/cursorSdkSystemPrompt.ts:155`, `chat/personalSession.ts:183`, `shared/adeCliGuidance.ts:337`) | `shared/cliLaunch.ts:390,406`; `main/services/externalSessions/discoveryUtils.ts:524,540-554`; `discoverAcpShared.ts:97` | Yes, inside provider session files on disk: these strip ADE's preamble from imported session titles. |
| `[ADE lane]` (`shared/devinCloud.ts:135,141`) | `devinCloud.ts:109` | Yes (Devin sessions). |
| OpenCode background-task titles `ADE <task>` | `externalSessions/discoverOpenCode.ts:42` | Yes (the person's OpenCode session list). |
| iOS simulator names `ADE · <lane>` (`ios/laneDeviceRegistry.ts:315,692`) | `ios/appleDeviceMarker.ts:111` `looksLikeAdeDeviceName` (storage view ownership) | Yes (Xcode device list). See 3, item W6. |
| macOS virtual display names `ADE · <lane>` (`native/ADEDesktopDriver/.../VirtualDisplayHost.swift:28`) | any cleanup that finds displays by prefix | Yes (System Settings > Displays). |
| `A device choice is kept for ADE chats` (`agentChatService.ts:85665`) | `apps/ade-cli/src/cliDevices.ts:217` | No: change both together. |
| `Unknown ADE action: <name>` (`apps/ade-cli/src/adeRpcServer.ts:10211`) | already both in `ProvidersSection.tsx`, `chatLaunchActions.ts` | Older brains say ADE forever: keep both. |
| `ADE brain listening on` (brain log line) | `apps/desktop/scripts/old-database-launch-check.mjs:167` | Log line; keep the log line as is. |
| CLI `--help` lead "Agent-focused command-line interface for ADE." (`apps/ade-cli/src/cli.ts:1673`, `apps/ade-cli/package.json:4`) | `apps/ade-cli/scripts/verify-built-cli.mjs:25,131`, `apps/desktop/scripts/validate-mac-artifacts.mjs:615`, `validate-win-artifacts.mjs:542`, CI digest `apps/desktop/resources/ade-cli-help.txt` (`scripts/regen-ade-cli-help.cjs`, CI step "Check the ADE CLI help digest is current") | **Release blocker if changed alone**: the release validators fail. Change all five together. |
| `ADE Sync <host> <port>` Bonjour instance name (`ade-cli/src/services/sync/syncHostService.ts:4632`) | `syncHostService.ts:2140` (`-R ADE Sync`) | Visible only in Bonjour browsers. Keep (see 3). |

### 2c. Shared constants and helpers that render later (the lint rule cannot see them)

| # | Where | Sees | Action | Who |
|---|---|---|---|---|
| C1 | `apps/desktop/src/shared/adeCloud.ts:825` `CLOUD_MACHINE_DEFAULT_NAME = "ADE Cloud computer"` | Every **new** cloud computer is still stored as "ADE Cloud computer" (`cloudMachineCreator.ts:277`, `cloudAgentActions.ts:742`); shows in the rename field, tooltips, CLI lists, the phone. | Rename to `${BRAND.CLOUD_NAME} computer`; map saved legacy names on display (see 6). | code |
| C2 | `apps/desktop/src/shared/adeCloud.ts:639` `CLOUD_WAKE_PORT_LABEL = "ADE wake"`; `apps/account-directory/src/cloud/launches.ts:913,1076`, `routes.ts:648,1661` | A label on the provider's public port; not shown in Daex. | Keep: provider-side label, may be matched by label. | - |
| C3 | `apps/desktop/src/shared/packageChannel.ts` | Being moved to `BRAND` right now ("Daex", "Daex Alpha", `installedDesktopAppDisplayName`). | Verify it landed; it drives the Windows "Updating …" window (`main.ts:3951`). | code |
| C4 | `apps/desktop/src/shared/integrationConnect.ts:151` `…/settings/tokens/new?…&description=ADE` | GitHub pre-fills the classic token's name as "ADE". | Rename to `BRAND.NAME` (the fine-grained one already is). | code |
| C5 | `apps/desktop/src/renderer/components/github/GitHubAppInstallPanel.tsx:43,555,677,755,911` "ADE for GitHub" | The GitHub App's name in Settings. | Must match the real app name on GitHub: owner decision O3. Change together. | owner then code |
| C6 | `apps/desktop/src/renderer/components/chat/McpAppFrame.tsx:242,502` `hostInfo: { name: "ADE" }`, `userAgent: "ADE"` | MCP App widgets can print the host name. | Rename `name` to `BRAND.NAME`; keep UA. | code |
| C7 | `apps/desktop/src/renderer/components/chat/AppControlCapture.tsx:169` `appName="ADE"` | Check: if this is a label, rename; if it is the target app name for capture, keep. | code (verify) |
| C8 | `apps/desktop/src/renderer/components/app/commandPaletteSuggestions.ts:104` fallback "Open the ADE action …" | Palette suggestion text. | Rename. | code |
| C9 | `apps/desktop/src/renderer/components/terminals/terminalImagePaste.ts:71` "ADE clipboard image attached.", `workToolContextInsertion.ts:61` "ADE visual attachment saved…" | Typed into the terminal / composer; the person sees it. | Rename. | code |
| C10 | `apps/web/src/components/SiteFooter.tsx:106` `© {year} ADE.` | Footer of every page on the site. | Rename (`© {year} Daex.`; legal entity name is owner decision O14). | code |
| C11 | `apps/web/src/components/ui/AppScreenshot.tsx:28,78` ("ADE / apps / web", a fake title string), `illustrations/ArchitectureDiagram.tsx:9` (aria-label) | Site illustration and screen-reader text. | Rename. | code |
| C12 | `apps/desktop/src/shared/sentry/expectedFailure.ts`, `runtimeErrors.ts`, etc. | Already accept both. | Nothing. | - |
| C13 | `BRAND.INTRO_NAME` / `Brand.introName` ("Daex (formerly ADE)") are defined but used nowhere in the apps (only the site's Terms/Privacy, README and `welcome.mdx` say it). | Nobody is told the product was renamed. | Add a one-time "ADE is now Daex" announcement (desktop `announcements/`, iOS What's New) and use `INTRO_NAME` in onboarding and the About panel. | code |

### 2d. Search: people will keep typing "ADE"

| # | Where | Today | Action | Who |
|---|---|---|---|---|
| S1 | Settings search `apps/desktop/src/shared/settingsManifest.ts:2337` `scoreSettingsEntry` (label + keywords, substring) | Pages are now titled "Daex MCP", "Daex Cloud", "Daex browser"; typing "ade" finds only the few entries that happen to list "ade relay" or "ade/". | Treat the query `ade` as `daex` (one line in `scoreSettingsEntry`, e.g. also try `q.replace(/\bade\b/, "daex")`), so every Daex-titled entry matches. Same for `ade settings find` (CLI) and iOS settings search. | code |
| S2 | Command palette (`renderer/components/app/commandPalette*`) | Same issue for command titles. | Same alias. | code |
| S3 | OS search | macOS Spotlight and Windows Start also index the file name (`ADE.app`, `ADE.exe`), so "ADE" keeps finding the app; once the Windows shortcut is renamed (packaging decision 1), "Daex" finds it too. | Nothing. | - |
| S4 | Voice dictation glossary: `apps/desktop/resources/voice/voice-glossary.json`, `apps/ios/ADE/Resources/VoiceGlossary.json` (`contextualTerms` has "ADE"; `corrections` maps `"ade": "ADE"`) | Saying "Daex" (pronounced "dax") will be transcribed as "dax"/"Dax"/"dacks". | Add "Daex" to `contextualTerms` and conservative corrections (`"dax"`, `"dacks"` -> "Daex"), keep the ADE entries. | code |

### 2e. OS surfaces and installers not covered by the packaging doc

| # | Where | Sees | Action | Who |
|---|---|---|---|---|
| P1 | `apps/desktop/scripts/linux-appimage-launcher.sh:30-48` | `zenity`/`kdialog` dialog titled "ADE" and "ADE: …" stderr lines when the Chromium sandbox is unavailable. | Rename titles and text (keep `ADE_ALLOW_NO_SANDBOX`). | code |
| P2 | `apps/desktop/scripts/windows-firewall-rules.ps1:94-153` | Firewall rule names "ADE Sync Host (…)", "ADE LAN Discovery (…)" in Windows Defender Firewall, plus `Write-Output` lines shown by the uninstaller. | Keep the rule **names** (the uninstaller finds them by name); rename the `Write-Output` text and the rule `Description`. Optional: set a `-DisplayName` of "Daex …" on new rules only if lookup moves to `-Name`. | code |
| P3 | `apps/desktop/scripts/windows-uninstall-cleanup.ps1:270-543`, `windows-install-setup.ps1:280` | Scheduled task "ADE Runtime (…)" in Task Scheduler; warnings during install/uninstall. | Keep task name (lookup key); rename warning text. | code |
| P4 | `apps/desktop/build/installer.nsh` custom `DetailPrint` lines ("Looking for what kept the old ADE files in use…") | Installer details pane. | Change together with packaging decision 1 (the doc says so); never touch the `PRODUCT_NAME` comparisons. | code |
| P5 | `apps/desktop/scripts/ade-cli-macos-wrapper.sh:102-168`, `ade-cli-windows-wrapper.cmd:74` | "ade: Node.js 22+ or the packaged ADE.app runtime is required…" | Rename the prose ("the packaged Daex app"); keep `ADE.app`/`ADE.exe` lookups. | code |
| P6 | Music host windows: `native/ADEMusicHostMac/Sources/ADEMusicHost/main.swift:203,403` ("ADE Music", "Connect Apple Music - ADE"), `native/ADEMusicHostWin/src/AdeMusicHost.cs:197,274` | Window titles of the Apple Music sign-in and player windows; the helper's name in Now Playing / the Windows media overlay. | Rename titles; check the helper bundle/exe display name. | code |
| P7 | `native/ADEDesktopDriver` messages: `WindowReadiness.swift:76` "ADE is not trusted for Accessibility…", `WindowControl.swift:88` | Shown in lane-screen errors; the Accessibility list in System Settings will say "Daex" (localized name), so "ADE is not trusted" points at a name the person cannot find. | Rename. | code |
| P8 | `apps/desktop/src/main/services/macDesktop/macDesktopService.ts:436` (`responsibleAppName` from `ADE_DESKTOP_APP_NAME`, default "ADE") | Copy telling the person which app to switch on in System Settings > Privacy, which now lists "Daex". | Show `installedDesktopAppDisplayName(...)` in copy; keep the env value. (Flagged in the packaging doc too.) | code |
| P9 | `apps/desktop/src/main/services/ios/iosSimulatorService.ts:997,4475` "ADE iOS Simulator Preview Lab" / "Allow prompt for ADE Preview Lab" | Xcode's permission prompt and the project name the person sees. | Rename the display name only if the Xcode prompt text comes from it; keep any bundle id. | code (verify) |
| P10 | `apps/ade-cli/src/serviceManager/installSystemd.ts:110` `Description=ADE runtime service`; launchd/systemd/Windows service messages (`installLaunchd.ts`, `installSystemd.ts`, `installWindows.ts` (45 lines), `detachedSupervisor.ts`) | `systemctl --user status` output, `ade brain start/status` text, Settings > Machine repair results. | Rename the description and messages; keep unit names, labels (`com.ade.runtime`) and file names. | code |
| P11 | macOS Login Items (System Settings > General > Login Items) for the brain's launch agent | Listed under the app named by `AssociatedBundleIdentifiers` (`com.ade.desktop`), so it should follow the localized name "Daex". | Verify on a Mac after the packaging change. | code (verify) |
| P12 | `apps/ade-cli/src/services/runtime/machineResetLauncher.ts:53-54` (`~/Library/Logs/ADE Reset`) | A folder name the person may open. | Keep (path). | - |
| P13 | Homebrew cask (`scripts/update-brew-tap.sh`, tap `arul28/homebrew-ade`, `Casks/ade.rb`), `brew install --cask arul28/ade/ade` (`apps/web/src/lib/installTargets.ts:66`), `brew upgrade --cask ade` (`main/services/updates/clientUpdateGate.ts:65`) | Cask display name moved to Daex in da11283f8; token stays `ade`. | Keep the token and tap (renaming breaks `brew upgrade` for everyone); optionally add a `daex` cask alias later. | owner (tap repo) |
| P14 | winget, Scoop, Chocolatey | No manifests in the repo. | If a winget manifest exists outside the repo, update `PackageName`/`Publisher` display fields, keep `PackageIdentifier`. | owner |

### 2f. CLI human output and help (no worker owns it yet)

`apps/ade-cli/src` has ~2,000 lines with "ADE" and does not import `BRAND`
anywhere. Person-visible parts, by priority:

1. **Browser pages a person sees on every sign-in**:
   `apps/ade-cli/src/services/account/accountAuthService.ts:99-133`
   ("Signed in to ADE", "ADE sign-in failed", "Return to ADE…") and its
   errors (`:622-2040`). Every desktop sign-in lands on this page.
   **Must rename before launch.**
2. **Remote MCP consent and identity** (what Claude.ai / ChatGPT show):
   `services/remoteMcp/remoteMcpOAuth.ts:464-516` ("Connect X to ADE",
   "Continue with ADE", "ADE Settings → ADE MCP"),
   `remoteMcpOAuthRoutes.ts:143` (`resource_name: "ADE on <machine>"`),
   `remoteMcpProtocol.ts:799,818` (`serverInfo.title: "ADE on <machine>"`,
   "ADE commands"), `remoteMcpApps.ts:45,89-90` (MCP App title "ADE").
   Keep `serverInfo.name: "ade"` and every tool name (frozen).
3. `ade --help` and command help (`cli.ts`, `help/appleHelp.ts`,
   `cliAndroidFormat.ts`, `cliCloudIphone.ts`, `cliMachineTargeting.ts`,
   `cliDevices.ts`, `cliPasswords.ts`). Do it in the same step that adds the
   `daex` binary, and change the release validators in 2b in the same commit.
4. Update and doctor output: `commands/brainUpdate.ts` (36),
   `commands/macDesktopUpdate.ts` (28), `commands/doctor.ts` (16),
   `services/runtime/machineUpdateAndRestart.ts` (21).
5. Project move and reset text (`projectMove/projectMoveEngine.ts`,
   `projectMovePreflight.ts`, `reset/machineReset*.ts`): copy only; keep
   every `ADE.app` / `ADE.exe` / `ADE( Beta| Alpha)?` path matcher.

### 2g. Docs and changelog

| # | Where | Action | Who |
|---|---|---|---|
| D1 | `changelog/*.mdx` (178 pages), `CHANGELOG.md` (321), in-app release notes bundled by `apps/desktop/scripts/bundle-release-notes.mjs` | Keep historical entries as written (they describe releases that shipped as ADE). Rename only the month index headings ("Every ADE release published in …" -> "Every Daex release (formerly ADE) …") and add the rename as the first line of the launch release notes. | code |
| D2 | `getting-started/install.mdx`, `sdk/bundling.mdx`, `sdk/license.mdx`, `sdk/runtime.mdx`, `welcome.mdx` (one line each) | Check each; most are "formerly ADE" or legal names. | code |
| D3 | `docs.json:236,264,318` GitHub `arul28/ADE`, `:263,322` X `x.com/ade_dev`, `:226,247` Download -> `ade-app.dev` | Change with owner decisions O9/O11 and the domain step. | owner then code |
| D4 | `packages/sdk/README.md`, `packages/chat-ui/README.md`, `packages/demo/README.md`, package `description`s (`packages/*/package.json:4`, `apps/ade-cli/package.json:4`), SDK error text (`packages/sdk/src/accounts.ts:128-216`, `packages/chat-ui/src/adapters/sdkClient.ts:426`) | Rename prose with the `@daex-dev` publish step; npm shows the description. | code |
| D5 | `RUNTIME-EMBEDDING-EXCEPTION.md` (15), `NOTICE`, `RUNTIME-SYNC-RECONCILIATION.md` | Legal text names "ADE". Owner decision O14: add a definition line ("Daex, formerly ADE") rather than rewriting the grant. | owner |

---

## 3. Things ADE writes into the person's world

| # | What | Where | Action | Who |
|---|---|---|---|---|
| W1 | Lane branch prefix `ade/<slug>` | `apps/desktop/src/shared/laneBranchName.ts:14` `DEFAULT_LANE_BRANCH_PATTERN`, `laneNameFallback.ts:241`, `laneBranchNaming.ts:234,240`; Settings keyword "ade/" (`settingsManifest.ts:1677`) | Owner decision O1. Recommendation: keep `ade/` as the default (branches are in every repo, scripts and CI filters may match `ade/*`, and it reads as the old CLI name which stays installed). The pattern is already a setting, so a person can choose `daex/{slug}`. If changed, change only the default for new projects; never rewrite existing branches. | owner |
| W2 | PR body footer "Open in Daex" + logo | `shared/adeDeeplinkFooter.ts` | Done (text and logo). Hidden markers `<!-- ade:link -->` stay (frozen). Old PRs keep "Open in ADE" text; nothing to do. | - |
| W3 | PR body blocks: transcript gists ("Daex chat transcripts"), proof, Linear/GitHub links | `shared/adePrTranscriptGists.ts:17-30`, `prBodyProof.ts`, `linearMagicWords.ts`, `githubMagicWords.ts` | Done; markers frozen. | - |
| W4 | Git identity on snapshot commits: author/committer "ADE" `<backup@ade.invalid>`, `<handoff@ade.invalid>`, message "ADE backup of uncommitted work (never pushed)" | `ade-cli/src/services/cloudChats/cloudLaneBackup.ts:70-76`, `desktop/.../chat/handoffGitBundle.ts:41-46`, `lanes/deletedLaneSnapshots.ts:33-35` | Keep: these live on private refs, never pushed; a restore may match the message. Rename only if a person can see them in `git log` of a restored lane (check `keptLaneRestore.ts`). | code (verify) |
| W5 | `.ade/.gitignore` written into every project | `shared/adeLayout.ts:156-175` (`# ADE ignores local runtime state…`, `# Shared ADE project config`) | **Keep as is.** `adeScaffoldFileContents()` (`adeLayout.ts:149`) compares the exact content to decide "changed by a person"; new comments would make every existing project's file look edited (an untracked/modified file in every repo). If ever changed, accept both contents first. | - |
| W6 | Simulator / emulator / virtual display names the person sees in Xcode, Simulator, Android Studio and System Settings > Displays: `ADE · <lane>`, `ADE Repro`, Android picker `ADE · checkout-flow` | `ios/laneDeviceRegistry.ts:315,692`; `android/androidAvds.ts:238`; `native/ADEDesktopDriver/.../VirtualDisplayHost.swift:28`; matcher `ios/appleDeviceMarker.ts:111` | Owner decision O2. Recommendation: rename new devices to `Daex · <lane>` and make `looksLikeAdeDeviceName` and any prefix cleanup accept both; never rename existing devices (the marker file is the real identity). | owner then code |
| W7 | Default device names on the account: `ADE CLI on <host>`, `ADE agents on <host>` | `ade-cli/src/services/account/accountMachineDirectoryService.ts:550`, `agentMachineBridge.ts:218` | Shown in Settings > Account / Devices and on the phone. Rename for new registrations; map saved names on display (see 6). | code |
| W8 | OAuth client names ADE registers with third-party MCP servers: `client_name: "ADE"` (dynamic client registration) and `clientInfo: { name: "ADE" }` | `desktop/src/main/services/mcp/mcpOAuth.ts:140,244` | Consent screens of Notion, Linear, Sentry, etc. MCP servers say "ADE wants access". Rename for new registrations; already-registered clients keep their name until re-registered (acceptable). | code |
| W9 | Client identity sent to agent runtimes: ACP `clientInfo.title: "ADE"` (`chat/acpHost/acpDialects/shared.ts:31`, used by Devin, Grok, Kimi, Qwen, Antigravity), Codex `clientInfo.title: "ADE Desktop"` / `"ADE voice"` (`agentChatService.ts:48430`, `codexEphemeralFork.ts:120`, `codexVoiceHost.ts:169`), proxy name "ADE proxy" (`harnessPresetLaunch.ts:649`), Codex config `name = "ADE"` (`harnessPresetConfigHomes.ts:418`, `harnessRouteLaunch.ts:650`) | Some agents show the client title in their own UI or session lists. Rename `title` fields only; keep `name` fields (`ade_desktop_fork`, Copilot `clientName: "ade"` is matched by `discoverCopilot.ts:160`, Muse `clientInfo.name` must stay lowercase). | code |
| W10 | User-Agent strings: `"ADE"` (GitHub API calls, account server), `ade-desktop`, `ade-cli`, `ADE-Agent/1.0` (agent web fetch, seen by every site an agent fetches), `ADE-LinkPreview/1.0`, `ADE chat webhook`, `ADE MCP events`, `ADE-Webhook-Test/1`, `ADE/<ver> (jev-helper)`, `ADE model registry (+https://ade-app.dev)` | `ai/tools/webFetch.ts:151`, `chat/smartLinkPreviewService.ts:152`, `chat/chatWebhookRegistry.ts:218`, `ade-cli/src/services/remoteMcp/remoteMcpEventWebhooks.ts:112`, `account-directory/src/modelRegistry.ts:78`, others listed by `grep -rn user-agent` | Owner decision O13. Recommendation: keep machine-to-machine UAs (`ade-desktop`, `ade-cli`, GitHub calls: allow-lists and rate-limit buckets key on them); rename the ones a third party reads as a product name (`ADE-Agent`, `ADE-LinkPreview`, webhook senders) to `Daex-…` in a later release. | owner |
| W11 | Built-in browser HAR/trace `creator: { name: "ADE built-in browser" }` | `builtInBrowser/builtInBrowserCapabilities.ts:250` | In exported files a person opens. Rename. | code |
| W12 | `gh`/git shim files written into session homes ("# ADE: runs the real gh…", marker "ADE GitHub shim folder"), stderr "gh: ADE could not reach its GitHub token…" | `github/githubShellShim.ts:114-529` | Keep file comments and the marker text (marker may be matched); rename the stderr sentence the person sees in a terminal. | code |
| W13 | Emulator log header `# ADE started …` | `android/androidEmulatorProcess.ts:469,583` | Log only: keep. | - |
| W14 | GitHub check runs / commit statuses | None created by ADE. | Nothing. | - |
| W15 | TOTP label default `otpauth://totp/ADE` | `ade-cli/src/services/passwords/passwordTotp.ts:70` | Issuer shown in authenticator apps when the label is empty. Rename default for new entries. | code |
| W16 | Revyl partner account/org/app names `ADE account …`, `ADE …`, `ADE builds` | `account-directory/src/cloud/phoneRevyl.ts:156-223` | Partner-side only. Keep. | - |
| W17 | GitHub issue reports and release feed target repo `arul28/ADE` | `github/githubRawRequest.ts:211`, `github/adeReleaseFeed.ts:3`, `resources/app-update.yml` | Depends on O9. Keep while the repo keeps its name. | owner |

---

## 4. Outside the code (owner dashboards)

| # | Service | What a person sees today | Recommendation | Risk |
|---|---|---|---|---|
| O1 | Lane branch default (W1) | `ade/…` branches | Keep default; offer `daex/` in Settings copy. | Scripts/CI matching `ade/*`. |
| O2 | Device names (W6) | `ADE · lane` | Rename new ones, match both. | None if the matcher accepts both. |
| O3 | GitHub App "ADE for GitHub" (slug `ade-for-github`, `githubRelayConfig.ts:15`, install URL in `GitHubAppInstallPanel.tsx:44`, `githubDirectStateCopy.ts:18`, iOS `PrDirectViews.swift:34`) | App name on GitHub install/permission pages, bot author on anything the app writes. | Rename the display name to "Daex for GitHub" in the app settings. **Verify first** whether GitHub changes the slug (and the `<slug>[bot]` login) on rename; if it does, released clients link to the old install URL and the relay may match the slug: then keep the name, or ship both slugs first. Update the logo in the app settings. | High if the slug changes. |
| O4 | Linear OAuth app "ADE" (client id `ADE_LINEAR_APP_CLIENT_ID`, `cto/linearAppClient.ts:14`) and the Linear agent (`actor=app`) | Authorize screen, the agent's name and avatar in issues and comments, @-mention name. | Rename app name and avatar in Linear's app settings; client id and webhook config stay. Existing installs show the new name. | Low. People who type "@ADE" must learn "@Daex". |
| O5 | Clerk (`clerk.ade-app.dev`) | Sign-in page app name and logo, verification/magic-link email subject and sender ("Your ADE code"), the OAuth consent shown to the desktop (`CLERK_OAUTH_CLIENT_ID` app name). | Rename application name, logo, email templates and sender name in Clerk. Keep the domain (released clients). | Low. |
| O6 | Stripe | Business/public name on Checkout, receipts, invoices, the customer portal; card statement descriptor; product names (the setup script already says Daex Cloud: 6aafdff08). | Change public business name, branding logo/icon, statement descriptor (and shortened descriptor) in the dashboard; run `apps/account-directory/scripts/stripe-setup.mjs` for product/portal text. Note privacy/terms URLs there still point at ade-app.dev (`stripe-setup.mjs:255-256`): fine until the domain step. | Bank statements change wording: mention it in the launch email. |
| O7 | Resend sender | `FROM_ADDRESS = "Daex <notifications@ade-app.dev>"` (`account-directory/src/cloud/email.ts:9`) | Display name done. Verify `daex.dev` in Resend (SPF, DKIM, DMARC), warm it, then switch the address. Until then keep ade-app.dev. | Deliverability if switched before warm-up. |
| O8 | App Store Connect / TestFlight (bundle `com.ade.ios`, app id 6762759870; public links `ZSdJGKPy`, `SsxDjqbF`) | App name, subtitle, keywords, description, promotional text, screenshots (L7), App Clip card header image and subtitle, What's New text, support/marketing URLs, the TestFlight beta name and "What to Test". | Rename name and subtitle (needs a new version submission), add "ADE" to keywords so search still finds it, new screenshots and App Clip card image. Bundle IDs stay. | App names must be unique on the App Store: check "Daex" is free before launch day. |
| O9 | GitHub repo `arul28/ADE` (update feed, releases, issues, docs links) | Repo name in links and release pages. | Recommendation: keep until a release has published both asset names (packaging decision 5). If renamed, GitHub redirects the API, git and release downloads, so released auto-updaters keep working, **but never create a new repo named `ADE` afterwards** (it kills the redirect and breaks every released build's update feed). | High if a new `ADE` repo is ever created. |
| O10 | Homebrew tap `arul28/homebrew-ade`, cask `ade` | `brew install --cask arul28/ade/ade` | Keep token and tap; display name already Daex. Optionally add a `daex` alias cask later. | `brew upgrade` breaks if the token changes. |
| O11 | X `@ade_dev`, Discord, YouTube, LinkedIn | Handle and display name. | Claim `@daex_dev` (or similar) now; rename display names; keep the old handles with a pinned "we are Daex now" post. Update `docs.json` and site footer links after. | Squatting if not claimed early. |
| O12 | npm `@ade-dev/*` (`packages/sdk`, `chat-ui`, `demo`) | Package pages. | Per README: publish `@daex-dev/*`, keep old packages depending on/pointing at the new ones, `npm deprecate` with a message. | Low. |
| O13 | User-Agents (W10) | Seen by third parties. | Keep machine UAs; rename agent/link-preview UAs later. | Allow-lists keyed on UA. |
| O14 | Legal: Terms, Privacy, license exception, NOTICE, copyright line, legal entity | Site footer "© ADE" (C10), legal docs. | Decide the legal name ("Daex"); add "Daex (formerly ADE)" definitions (the site's Terms and Privacy already do). | Legal review. |
| O15 | Google OAuth (if Clerk uses a custom Google client) and any other social sign-in apps | "ADE wants to access your Google account" on the consent screen. | Rename app name and logo on the Google Cloud consent screen (may need re-verification). | Google re-verification delay. |
| O16 | Spotify | Each person makes their own Spotify app; Daex shows "App name: Daex" (`MusicProviderControls.tsx:115`). | Nothing on our side; existing personal apps keep "ADE". | - |
| O17 | Apple Developer certificates (Developer ID, Apple Distribution), provisioning profile names, Windows code-signing certificate publisher | Certificate common names; Windows SmartScreen and UAC show the publisher. | **Do not change signing identities** (`channelSignIdentity.mjs`; a new identity breaks Squirrel.Mac updates and resets SmartScreen reputation). Profile *names* are cosmetic; leave them. | High if touched. |
| O18 | Sentry org `ade-app`, PostHog project, Cloudflare Worker names | Internal only. | Keep (low priority; dashboards and event names are frozen). | - |
| O19 | Domain `daex.dev` | - | Site, docs and `/open` links first (planned); HSTS/redirects from ade-app.dev pages to daex.dev; keep API, sign-in and relay hosts on ade-app.dev. | - |

---

## 5. Agent-facing text (planned step 3)

Agent-facing text is not part of step 2, but three things matter now:

1. **Some "agent" text is person-visible.** The renderer builds prompts that
   are sent *as the person's message*, so they show in the transcript, on the
   phone and in shared chats: `renderer/components/projectMove/projectMoveModel.ts:60-82`,
   `settings/health/healthModel.ts:65-79`, `settings/overview/useNeedsAttention.ts:642-651`,
   `lib/laneCatchUpPrompt.ts:46`, `lib/laneTemplateSetupPrompt.ts:34-40`,
   `chat/ChatWorkLogBlock.tsx:255-261`, `chat/AgentChatPane.tsx:16165`,
   `chat/ChatBuiltInBrowserPanel.tsx:1755-1756`, `capture/currentViewState.ts:150-152`,
   `lib/visualContextFormatting.ts:250,382`, `automations/templates/templateData.ts:339`.
   Rename these with step 2 or at the start of step 3.
2. **Matchers in 2b** must change with their producers.
3. **Skill and plugin metadata shows in other tools' UIs**: Claude Code
   lists `ade:ade-browser` etc. with their descriptions in `/skills` and the
   `/` menu. `apps/desktop/resources/agent-skills/.claude-plugin/plugin.json`
   has `"description": "ADE's bundled agent capabilities"`,
   `"author": { "name": "ADE" }`. Rename description and author; keep
   `"name": "ade"` and every skill folder name (frozen: saved prompts call
   them).

Suggested split for step 3 (one worker each, no overlap):

| Worker | Files |
|---|---|
| A. Shared guidance | `apps/desktop/src/shared/`: `adeCliGuidance.ts`, `cliLaunch.ts` (session guidance, Pi policy), `chatAutoResume.ts`, `sideChat.ts`, `sceneGuide.ts`, `browserTabMention.ts`, `chatContextAttachments.ts`, `chatMentions.ts`, `prWatch.ts`, `devinCloud.ts`, `hostSessionConfig.ts`, `callerMcpServers.ts`, `desktopSeat.ts`, `cloudTierRequest.ts`, `crossMachineHandoff.ts`, `launchModelRule.ts`, `accountMachineSnapshot.ts`, `customProviderRef.ts`, `agentObservation*.ts` |
| B. Main-process prompts | `apps/desktop/src/main/services/`: `ai/tools/systemPrompt.ts`, `ctoOperatorTools.ts` (59), `ctoCrossMachineTools.ts`, `ctoToolPacks.ts`; `cto/ctoStateService.ts` (46), `ctoPromptContent.ts`; `chat/agentChatService.ts` (66), `cursorSdkSystemPrompt.ts`, `cursorSdkHooks.ts`, `personalSession.ts`, `sessionNaming.ts`, `codexVoiceSession.ts`, `harnessRouteLaunch.ts`, `harnessPresetConfigHomes.ts`, `agentRelayNote.ts`, `agentCliSessionActions.ts`, `chatMentionService.ts`; `opencode/openCodeTerminal.ts`; `ai/pinnedCliTaskRunners.ts` |
| C. Tool descriptions and agent errors | `main/services/adeActions/actionInputContracts.ts` (122), `apps/ade-cli/src/adeRpcServer.ts` (47), `multiProjectRpcServer.ts`, `services/remoteMcp/remoteMcpProtocol.ts` (instructions), `remoteMcpCommandPolicy.ts`, `remoteMcpForward.ts`, `main/services/mcp/mcpServerRequest.ts`, `adeCloud/cloudAgentActions.ts`, `cloudTierRequestActions.ts`, `builtInBrowser/builtInBrowserAgentAccess.ts`, `userBrowser/userBrowserAttachService.ts`, `secrets/projectSecretRequest.ts`, `passwords/passwordLoginRequest.ts`, `messagesIntegration/messagesDomain.ts` |
| D. Skills and help digest | `apps/desktop/resources/agent-skills/*/SKILL.md` (19 skills, 446 mentions), `plugin.json`, `apps/desktop/resources/ade-cli-help.txt` (regenerate with `scripts/regen-ade-cli-help.cjs` after the CLI help changes). Repo-internal `.agents/skills/` and `.factory/skills/` are developer tools: low priority. |

Teach agents both commands: the system text should say `daex …` once the
binary ships and note that `ade …` still works, because transcripts, skills
and people's saved prompts say `ade`.

---

## 6. Old names saved on people's machines and accounts

| # | Saved where | Example | Shows in | Recommendation |
|---|---|---|---|---|
| N1 | Account directory (D1) machine names for cloud computers | "ADE Cloud computer", "ADE Cloud computer 2" | Desktop Settings > Machines (rename field, tooltip), CLI lists, phone | **Map on display**, do not migrate rows: the CLI already maps `ADE Cloud…` -> `Daex Cloud…` (`cliMachineTargeting.ts:1318-1324`) and iOS matches both (`MachineRowView.swift:157`); the desktop renderer has no such mapping. Add one shared helper (`shared/`) used by desktop, web and CLI; change C1 so new names are Daex. Never rewrite a name the person typed. |
| N2 | Account device names | "ADE CLI on host", "ADE agents on host" | Account / Devices lists | Map the exact defaults on display (`^ADE (CLI\|agents) on ` -> `Daex …`); new registrations use Daex (W7). |
| N3 | iOS saved pairing profiles (`serviceName`) | "Saved ADE machine", "ADE account machine", "ADE Tailnet <host>" (`ios/ADE/Services/SyncService.swift:8518,8829,28140`) | Settings > Pairing (`SettingsPairingSection.swift:250,294` falls back to `serviceName`) | Map the three exact defaults on display; rename the producers. `serviceName` is also compared for de-duplication (`SyncService.swift:3060`, `SettingsPinSheet.swift:299`), so do not migrate stored values. |
| N4 | Installed app name `ADE_DESKTOP_APP_NAME` published by machines ("ADE", "ADE Beta", "ADE Alpha") | Older machines | Machine rows, update prompts | Already mapped by `installedDesktopAppDisplayName` (`packageChannel.ts`). Verify every place that prints an installed app name goes through it. |
| N5 | Chat transcripts | `[ADE] …` notices, "ADE restarted…" notices, stop reasons, "Open in ADE" in old PR bodies | Chat history, phone, shared chats | Leave the stored text; accept both in matchers (2b). Old messages saying ADE are history. |
| N6 | Simulator, emulator and virtual display names | `ADE · lane` | Xcode, Simulator, System Settings | Leave; match both (W6). |
| N7 | Provider session files (Claude/Codex/OpenCode/Devin/Copilot) with ADE preambles | `## ADE CLI primer`, `client_name: ade` | Imported sessions list | Leave; matchers accept both (2b). |
| N8 | `.ade/.gitignore` in every project | `# ADE ignores…` | The person's repo | Leave (W5). |
| N9 | Saved settings with the word ADE (custom branch pattern `ade/{slug}`, automation names, rule names, person-typed labels) | - | Settings | Leave: the person chose them. |
| N10 | Windows Start menu shortcut `ADE.lnk`, taskbar pins | - | Start, taskbar | Handled by packaging decision 1 (electron-builder renames the shortcut on update). |

Rule of thumb: **never migrate stored data; map known default strings at
display time, and accept both names wherever stored text is parsed.**

---

## 7. Must do before launch (prioritized)

**P0: fix before this branch merges (regressions or release blockers)**

1. M1 `chatNotice.ts:68` and M2 `plainError.ts:39`: accept "Daex" (the
   rename broke the dropped-connection notice and the update button).
2. Do not change the CLI help lead "Agent-focused command-line interface for
   ADE" without the four release validators and the help digest (2b).
3. Keep `.ade/.gitignore` content byte-for-byte (W5).
4. L2 remote MCP consent logo is squashed (fixed 62x30 for a 1138x868 image).

**P1: everyone sees these on day one**

5. Sign-in result pages "Signed in to ADE" (`accountAuthService.ts:99-133`).
6. Account server pages' inline ADE wordmark (L1, `brandPage.ts:22-23`).
7. Site footer "© ADE" (C10) and the illustration strings (C11).
8. og-image and README hero re-captured (L5); re-scrape social caches.
9. Rebuild the site demo (L8, `npm run build:demo`).
10. Remote MCP consent page text, `resource_name` and `serverInfo.title` (2f item 2).
11. New cloud computers named "Daex Cloud computer" (C1) and a display map for
    saved "ADE Cloud…" and "ADE CLI/agents on …" names in the desktop (N1, N2).
12. "ADE is now Daex" announcement in desktop and iOS, using `INTRO_NAME` (C13).
13. Settings and command-palette search: "ade" finds Daex entries (S1, S2).
14. Owner: App Store Connect name, subtitle, keywords (keep "ADE"), screenshots
    (L7), App Clip card; Clerk app name, logo and emails; Stripe public name,
    logo, statement descriptor; Linear app name and avatar; Google consent
    screen if custom; claim social handles.

**P2: soon after (visible but less frequent)**

15. CLI human output, help and service messages (2f), together with the
    `daex` binary and the validator changes.
16. Person-visible prompt drafts (section 5, item 1) and skill/plugin
    metadata.
17. Linux AppImage dialog (P1), music host windows and icon (P6, L4), Linux
    lane-screen wallpaper (L3), desktop driver messages (P7), Privacy pane
    app name (P8), installer/uninstaller/firewall text (P2-P4), wrappers (P5),
    systemd description (P10), OAuth `client_name` for MCP servers (W8),
    ACP/Codex client titles (W9), classic GitHub token name (C4), TOTP default
    (W15), HAR creator (W11).
18. Voice dictation learns "Daex"/"dax" (S4).
19. Simulator/emulator/virtual display names with both-name matchers (W6).
20. Website and docs screenshots, onboarding welcome images, tips (L6).
21. Owner decisions: GitHub App rename (O3, verify slug behaviour first),
    repo rename (O9), Resend domain (O7), legal name (O14), user-agents (O13),
    branch prefix (O1, recommend keep).

**Keep on purpose** (do not "fix"): `ade/` branch default (unless O1 says
otherwise), `.ade/.gitignore` text, NSError domains `"ADE"`/`"ADE.AdoptChannel"`
on iOS (compared in code; make sure every surfaced error carries a
localized description so iOS never prints "(ADE error 15.)"), firewall rule
and scheduled task names, snapshot commit identities, partner-side names
(Revyl, provider port labels), machine user-agents, cask token, signing
identities, everything in the README's frozen list.

## How to re-run the scans

```sh
# Remaining "ADE" lines in an area (non-comment, no tests):
git ls-files apps/desktop/src/renderer | grep -E '\.(ts|tsx)$' | grep -vE '\.test\.' \
  | xargs grep -nE '(^|[^A-Za-z0-9_./-])ADE([^A-Za-z0-9_-]|$)' \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)'

# Matchers that still look only for ADE:
git ls-files apps packages | grep -E '\.(ts|tsx|swift|mjs)$' | grep -vE '\.test\.' \
  | xargs grep -nE "(startsWith|includes|hasPrefix|test|exec)\(.*\bADE\b|/[^/]*\bADE\b[^/]*/[a-z]*\.(test|exec)" \
  | grep -v 'ADE|Daex' | grep -v 'Daex|ADE'
```
