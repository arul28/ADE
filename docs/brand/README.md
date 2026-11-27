# Brand: Daex (formerly ADE)

The product was called ADE (agentic development environment). That became the
name of a whole category of tools, so the product is now **Daex**, pronounced
"dax", at daex.dev.

The rule: rename everything a person sees or types. Keep every internal
identifier as it is. An internal identifier that changes breaks released
apps, stored data or machines on older builds, and nobody outside the code
ever sees it.

## Decisions

| What | New | Former | Notes |
|---|---|---|---|
| Display name | Daex | ADE | Always "Daex", never "DAEX". First mention in onboarding and release notes: "Daex (formerly ADE)". |
| CLI | `daex` | `ade` | `daex` is the primary command; `ade` stays installed as a permanent alias. |
| Feature names | Daex Cloud, Daex Beta, `daex code` | ADE Cloud, ADE Beta, `ade code` | Same pattern for any "ADE <feature>" name. |
| Domain | daex.dev | ade-app.dev | ade-app.dev keeps working. Sign-in (`clerk.ade-app.dev`) and API hosts stay on ade-app.dev for now, because released clients call them. |
| npm scope | `@daex-dev` | `@ade-dev` | |
| URL scheme | `daex://` | `ade://` | `ade://` is accepted forever. |

## Using the names in code

TypeScript: `apps/desktop/src/shared/brand.ts`. It has no imports, so the
desktop app, the CLI, the web client, the marketing site (`apps/web`) and
build configs can all import it by relative path.

```ts
import { BRAND } from "../../shared/brand";

`Restart ${BRAND.NAME} to finish.`;  // "Restart Daex to finish."
BRAND.CLOUD_NAME;                    // "Daex Cloud"
BRAND.INTRO_NAME;                    // "Daex (formerly ADE)"
`Run ${BRAND.CLI} code`;             // "Run daex code"
```

It also has `FORMER_NAME`, `BETA_NAME`, `LEGACY_CLI`, `DOMAIN`,
`LEGACY_DOMAIN`, `SITE_URL`, `URL_SCHEME`, `LEGACY_URL_SCHEME`, `NPM_SCOPE`
and `LEGACY_NPM_SCOPE`.

Swift: `apps/ios/ADE/Shared/Brand.swift` (in the app, widget and App Clip
targets). `Brand.name`, `Brand.formerName`, `Brand.introName`,
`Brand.cliName`, `Brand.siteURL`, `Brand.cloudName`, `Brand.betaName`. Change
it together with `brand.ts`.

Lint: `ade-ui/no-legacy-brand-name` (`apps/desktop/eslint-rules/ade-ui.mjs`)
warns on the word `ADE` in user-facing copy in `apps/desktop/src/renderer/**/*.tsx`:
JSX text, copy attributes (`title`, `label`, `aria-label`, `placeholder`,
`alt`, `description`, `tooltip`, `*Label`, `*Message`, ...), and the copy keys
(`title`, `message`, `detail`, `label`, ...) of objects passed to the notice
helpers (`showToast`, `updateToast`, `confirmDialog`, `promptDialog`,
`checkboxConfirmDialog`, `useAppBanner`) or to a JSX attribute
(`<Banner model={{ title }} />`). It skips identifiers, `ADE_*` names,
`.ade` paths, `ade://` and other code strings. Existing copy is grandfathered
in `apps/desktop/lint-baseline.json`; `npm run lint:ci` fails when a file's
count goes up. When you rewrite copy that has the old name, use `BRAND` and
run `npm run lint:baseline` to lock in the lower count.

The rule cannot see a name that reaches the screen through a constant
(`const LABEL = "ADE Cloud"` rendered as `{LABEL}`), a helper's return value,
or a `.ts` file. Treat those by hand.

## Frozen identifiers

Never rename these. Each one is read by something that cannot change in step
with the code: a released app, data already on disk, another machine, or an
outside service.

| Class | Example | Where it lives | Why it stays |
|---|---|---|---|
| iOS bundle IDs | `com.ade.ios`, `com.ade.ios.beta`, `com.ade.ios.widgets`, `com.ade.ios.Clip` | `apps/ios/ADE.xcodeproj/project.pbxproj` (`PRODUCT_BUNDLE_IDENTIFIER`) | Apple ties the App Store listing, TestFlight testers, push and app data to the bundle ID. A new ID is a new app. |
| iOS app group | `group.com.ade.ios` | `apps/ios/ADE/ADE.entitlements`, `ADE.Beta.entitlements`, `ADE.Release.entitlements`; `apps/ios/ADE/Services/ClipPairingHandoff.swift` | The app, widgets and App Clip share data through this container. A new group starts empty. |
| iOS keychain service and log subsystem | `com.ade.ios.sync`; `Logger(subsystem: "com.ade.ios")` | `apps/ios/ADE/Services/KeychainService.swift`; `apps/ios/ADE/Services/*.swift` | Renaming the keychain service makes the stored pairing secrets unreadable. |
| Desktop appId | `com.ade.desktop` | `apps/desktop/package.json` (`build.appId`) | macOS and Windows tie the install, auto-update, user data folder, notifications and keychain access to it. |
| Keychain / credential store services | `com.ade.runtime.credentials.v1`, `com.ade.runtime.credentials.file-store-key.v1`, `com.ade.desktop.api-keys.v1` | `apps/ade-cli/src/services/credentials/credentialStore.ts`, `osBoundKeyMaterial.ts`, `apps/ade-cli/src/services/reset/machineResetInventory.ts`, `apps/desktop/src/main/services/ai/apiKeyStore.ts` | Renaming makes every stored secret unreadable. |
| Credential and crypto format labels | `ade.credentials.v1`, `ade.credentials.file-store.v2`, `ade.passwords.v1` | `apps/ade-cli/src/services/credentials/credentialStore.ts`, `apps/ade-cli/src/services/passwords/passwordCrypto.ts`, `apps/ios/ADE/Services/PasswordsVault.swift` | The label is part of the encrypted data or its key derivation. A new label cannot open old data. |
| Bonjour service type | `_ade-sync._tcp` | `apps/ade-cli/src/services/sync/syncHostService.ts`, `apps/desktop/package.json`, `apps/ios/ADE/Info.plist`, `apps/ios/ADE/Services/SyncService.swift` | Machines and phones on older builds must still find each other on the local network. |
| Versioned wire strings | `ade-dpop-v1`, `ade-relay-reauth-v1` | `apps/ade-cli/src/services/sync/syncDpop.ts`, `relayAuthorization.ts`, `apps/desktop/src/renderer/webclient/sync/dpop.ts`, `apps/desktop/src/shared/types/sync.ts`, `apps/ios/ADE/Services/DpopKeyService.swift` | Signed into proofs both sides check. Older clients and servers must still verify each other. |
| Service labels | `com.ade.runtime`, `com.ade.runtime.beta`, `com.ade.watchdog`, `com.ade.runtime.plist` | `apps/ade-cli/src/serviceManager/common.ts`, `installLaunchd.ts`, `installLaunchdWatchdog.ts`, `installWindows.ts` | Installed services are found and replaced by label. A new label leaves the old brain running beside the new one. |
| Windows pipe names | `\\.\pipe\ade-runtime-<channel>-<hex>` | `apps/ade-cli/src/services/projects/machineLayout.ts`, `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` | The desktop app and the brain must agree on the name across versions during an update. |
| Cloudflare Workers, D1, R2, Durable Objects | `ade-account-directory`, `ade-push-relay`, `ade-tunnel-relay`, `ade-github-webhook-relay`, `ade-password-key-service`; D1 `ade-account-directory`; R2 `ade-cloud-chats`, `ade-diagnostics`; DO `TunnelDurableObject`, `RepoEventsDurableObject` | `apps/*/wrangler.jsonc` | A new name is a new, empty resource. Data does not move with a rename. |
| Project and home folders | `.ade/` in each project, `~/.ade` | `apps/ade-cli/src/services/projects/machineLayout.ts` | Existing projects, lanes, worktrees, settings and state live there. |
| Env var names | `ADE_HOME`, `ADE_*` | throughout `apps/ade-cli/src`, `apps/desktop/src/main` | Scripts, services and agent environments already set them. A later step adds `DAEX_*` aliases. |
| Code identifiers | `window.ade`, `AdeFoo`, `adeFoo`, `ADESharedTheme` | `apps/desktop/src/preload/preload.ts` (`exposeInMainWorld("ade", ...)`), everywhere | Never seen by users. Renaming is churn with merge conflicts and no benefit. |
| MCP typed tool names, the MCP App resource `ui://ade/app-….html`, `_meta` keys (`ade/source`, `dev.ade/unreadMachines`), the forwarding headers `x-ade-mcp-*` | the typed tools ADE MCP exposes (`lanes_list`, `chat_start`, …) | `apps/ade-cli/src/services/remoteMcp/` | Agents and saved prompts call the typed tools by name; the rest is wire. Renamed instead (owner, 2026-11-27, accepting one re-approval in apps that had "always allow"): the server `serverInfo.name` and its run tool `ade` → `daex` (a call to `ade` still runs for one release, not listed), the commands resource `ade://commands` → `daex://commands` (old still reads), and the CTO's in-process server `ade-cto` → `daex-cto` (Codex namespace `ade_cto` → `daex_cto`; permission policies keep `ade-cto` as an alias, both names stay reserved). |

## Sunset identifiers

These are public, so they move to the new name, but the old one keeps
working. Later steps read both.

| Old | New | Plan |
|---|---|---|
| `ADE_*` env vars | `DAEX_*` | Read `DAEX_*` first, fall back to `ADE_*`. Never stop reading `ADE_*`. |
| `ade://` links | `daex://` | Register both schemes (desktop `build.protocols` in `apps/desktop/package.json`, iOS `ADE_URL_SCHEME` in `project.pbxproj` and `CFBundleURLSchemes` in `apps/ios/ADE/Info.plist`); parse both in `apps/desktop/src/shared/deeplinks.ts`. Accepted forever. Every new link is `daex://` (`BRAND.LINK_SCHEME_FOR_NEW_LINKS`, iOS `Brand.linkSchemeForNewLinks`), including links passed on to a phone or another computer. The iPhone still routes internally on `ade` (`withADEScheme`) and its sign-in callbacks (`callbackURLScheme: "ade"`) stay `ade`: they never leave the app. |
| ade-app.dev | daex.dev | Site and open links move first (`ADE_DEEPLINK_HTTPS_HOST` in `deeplinks.ts`). Sign-in (`DEFAULT_ADE_CLERK_ISSUER` in `apps/desktop/src/shared/accountDirectory.ts`) and API hosts stay until released clients no longer call them. |
| `ade` CLI | `daex` | `daex` becomes the binary (`bin` in `apps/ade-cli/package.json`); `ade` stays as a permanent alias. |
| `@ade-dev/*` packages | `@daex-dev/*` | Publish under the new scope; keep the old packages pointing at it (`packages/sdk/package.json`, `packages/chat-ui/package.json`). |

## Old names in output: producers write Daex, readers accept both

Owner decision, 2026-11-27: at launch the account server's minimum version
(`GET /client/minimum`, `apps/desktop/src/shared/clientUpdateGate.ts`, iOS
`ClientUpdateGate.swift`) is set to the launch build, so released desktops and
iPhones below it must update before they keep working. Nothing is written in
the old form for old versions any more:

- **Producers write Daex / `daex`**: links, markers, prefixes, user agents,
  defaults and commands.
- **Readers keep accepting the old form forever.** Transcripts, provider
  session files, git history, PR bodies, saved automations, D1 rows and pasted
  links keep the old text, and a machine may be mid-update.
- **Identity stays frozen** (the table above).

What flipped, with the reader that still accepts the old form:

| Written now | Before | Reader that accepts both |
|---|---|---|
| `daex://` new links and forwarded links | `ade://` | `deeplinks.ts` (`ADE_DEEPLINK_SCHEMES`), iOS `Brand.linkSchemes`, push relay |
| `daex` and `daex-*` skill names in renderer-written agent text | `ade`, `ade-*` | `ade` alias, `LEGACY_BUNDLED_AGENT_SKILL_ALIASES` |
| `[Daex] …` compaction, trim and test-log notices | `[ADE] …` | `chatEventCompaction.ts`, `chatTranscriptRows.ts`, iOS `WorkEventMapping.swift` |
| `[Daex launch directive]`, `## Daex CLI primer`, `## Daex`, `Daex session guidance.`, `System context (Daex continuity, …)` | the ADE forms | `discoveryUtils.ts`, `discoverAcpShared.ts`, `cliLaunch.ts` |
| `[Daex lane]` (Devin pin) | `[ADE lane]` | `devinCloud.ts` |
| Stop reasons `the Daex brain restarted`, `another Daex brain took over this chat` | ADE | `chatAutoResume.ts`, `SubagentActivityCards.tsx` |
| Handoff default prompt (`another Daex machine`) | `another ADE machine` | `isCrossMachineHandoffDefaultPrompt` |
| Sync skipReason `Another Daex app …`; autolinks `Daex's GitHub sign-in` | ADE | `readCompetingSyncHostOwner`, `GITHUB_AUTOLINKS_SIGN_IN_LACKS_ADMIN` |
| `daex:` CLI error prefix (CLI and desktop-written lines) | `ade:` | `computerUseActionOutput.ts`, `runtimeRpcClient.ts`, iOS `WorkComputerUseOutput.swift` |
| `daex --version` output (`daex X.Y.Z`) | `ade X.Y.Z` | desktop and CLI version checks |
| Brain messages `Daex brain listening on`, `Failed to initialize the Daex brain …`, `Daex kept trying` | ADE | `old-database-launch-check.mjs`, `cloudBoxSignInStart.ts` |
| `Unknown Daex action: …`, `… not exposed through Daex actions` | ADE | `codedError.ts`, `chatLaunchActions.ts`, `ProvidersSection.tsx`, `useGitHubPrFilterSearch.ts` |
| Bonjour instance name `Daex Sync <host> <port>` (type `_ade-sync._tcp` stays) | `ADE Sync …` | `syncHostService.ts` orphan cleanup |
| Lane simulators `Daex · <lane>`, virtual display prefix `Daex` | `ADE · <lane>` | `looksLikeAdeDeviceName` |
| Deleted-lane trailers `Daex-Lane-Id` …, snapshot author Daex | `ADE-Lane-Id` …, ADE | `deletedLaneSnapshots.ts` |
| Stored cloud computer default `Daex Cloud computer` | `ADE Cloud computer` | `isCloudMachineDefaultName`, `displayLegacyDefaultName` (desktop, iOS, CLI) |
| User agents `Daex-Agent/1.0`, `Daex-LinkPreview/1.0`, `Daex-iOS/<v>`, `Daex MCP events`, the Worker agents, … | ADE | Gravity `hashedEmailFor` |
| MCP Apps `hostInfo.name` and `userAgent` Daex | ADE | none |

Kept on purpose: the lowercase machine tokens (`ade-desktop`, `ade-cli`,
`ade-harness-test` user agents and RPC client names), `TERM_PROGRAM=ADE`
(outside tools detect terminals by it), the GitHub App slug `ade-for-github`,
and everything in **Frozen identifiers**.

## Launch steps

1. **Set the minimum version first.** Before the new links and messages
   matter, set every published kind's minimum to the launch build with
   `scripts/release-tools/client-minimum.mjs set` (guide:
   `docs/playbooks/update-gate.md`; account-side test switches are in
   `docs/features/ade-cloud/account-test-tool.md`). Until then a
   not-yet-updated app can be sent a `daex://` link it does not register.
2. Builds released before the gate existed (v1.2.130 and older) are not
   blocked by it and cannot open `daex://`; only their own updater moves them.
3. Rename the GitHub App to "Daex for GitHub" in its settings; the slug
   `ade-for-github` stays, and the app copy already says Daex.
