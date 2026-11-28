# Brand: DAEX (formerly ADE)

The product was called ADE (agentic development environment). That became the
name of a whole category of tools, so the product is now **DAEX**, pronounced
"dax", at daex.dev.

The rule: rename everything a person sees or types. Keep every internal
identifier as it is. An internal identifier that changes breaks released
apps, stored data or machines on older builds, and nobody outside the code
ever sees it.

## Decisions

| What | New | Former | Notes |
|---|---|---|---|
| Display name | DAEX | ADE | Always "DAEX", in capitals (owner decision 2026-11-27; it replaced an earlier title-case spelling that never shipped). Said "dax", so the article is "a": "a DAEX chat". Lowercase `daex` only for the command, domain, scheme and package names. First mention in onboarding and release notes: "DAEX (formerly ADE)". |
| CLI | `daex` | `ade` | `daex` is the primary command; `ade` stays installed as a permanent alias. |
| Feature names | DAEX Cloud, DAEX Beta, `daex code` | ADE Cloud, ADE Beta, `ade code` | Same pattern for any "ADE <feature>" name. |
| Domain | daex.dev | ade-app.dev | ade-app.dev keeps working. Sign-in (`clerk.ade-app.dev`) and API hosts stay on ade-app.dev for now, because released clients call them. |
| npm scope | `@daex-dev` | `@ade-dev` | |
| URL scheme | `daex://` | `ade://` | `ade://` is accepted forever. |

## Using the names in code

TypeScript: `apps/desktop/src/shared/brand.ts`. It has no imports, so the
desktop app, the CLI, the web client, the marketing site (`apps/web`) and
build configs can all import it by relative path.

```ts
import { BRAND } from "../../shared/brand";

`Restart ${BRAND.NAME} to finish.`;  // "Restart DAEX to finish."
BRAND.CLOUD_NAME;                    // "DAEX Cloud"
BRAND.INTRO_NAME;                    // "DAEX (formerly ADE)"
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
| MCP typed tool names, the MCP App resource `ui://ade/app-….html`, `_meta` keys (`ade/source`, `dev.ade/unreadMachines`), the forwarding headers `x-ade-mcp-*` | the typed tools ADE MCP exposes (`lanes_list`, `chat_start`, …) | `apps/ade-cli/src/services/remoteMcp/` | Agents and saved prompts call the typed tools by name; the rest is wire. Renamed instead (owner, 2026-11-27, accepting one re-approval in apps that had "always allow"): the server `serverInfo.name` and its run tool `ade` → `daex` (a call to `ade` still runs, not listed, and forwarded run-tool calls use `ade` until the `ade` alias is dropped: see **Old names in output**), the commands resource `ade://commands` → `daex://commands` (old still reads), and the CTO's in-process server `ade-cto` → `daex-cto` (Codex namespace `ade_cto` → `daex_cto`; permission policies keep `ade-cto` as an alias: a deny rule matches both names, an allow rule for `ade-cto` also covers `daex-cto` but not the other way round; both names stay reserved). |

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

## Old names in output: producers write DAEX, readers accept both

Owner decision, 2026-11-27: at launch the account server's minimum version
(`GET /client/minimum`, `apps/desktop/src/shared/clientUpdateGate.ts`, iOS
`ClientUpdateGate.swift`) is set to the launch build, so released desktops and
iPhones below it must update before they keep working. Nothing is written in
the old form for old versions any more:

- **Producers write DAEX / `daex`**: links, markers, prefixes, user agents,
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
| `[DAEX] …` compaction, trim and test-log notices | `[ADE] …` | `chatEventCompaction.ts`, `chatTranscriptRows.ts`, iOS `WorkEventMapping.swift` |
| `[DAEX launch directive]`, `## DAEX CLI primer`, `## DAEX`, `DAEX session guidance.`, `System context (DAEX continuity, …)` | the ADE forms | `discoveryUtils.ts`, `discoverAcpShared.ts`, `cliLaunch.ts` |
| `[DAEX lane]` (Devin pin) | `[ADE lane]` | `devinCloud.ts` |
| Stop reasons `the DAEX brain restarted`, `another DAEX brain took over this chat` | ADE | `chatAutoResume.ts`, `SubagentActivityCards.tsx` |
| Handoff default prompt (`another DAEX machine`) | `another ADE machine` | `isCrossMachineHandoffDefaultPrompt` |
| Sync skipReason `Another DAEX app …`; autolinks `DAEX's GitHub sign-in` | ADE | `readCompetingSyncHostOwner`, `GITHUB_AUTOLINKS_SIGN_IN_LACKS_ADMIN` |
| `daex:` CLI error prefix (CLI and desktop-written lines) | `ade:` | `computerUseActionOutput.ts`, `runtimeRpcClient.ts`, iOS `WorkComputerUseOutput.swift` |
| Brain messages `DAEX brain listening on`, `Failed to initialize the DAEX brain …`, `DAEX kept trying` | ADE | `old-database-launch-check.mjs`, `cloudBoxSignInStart.ts` |
| `Unknown DAEX action: …`, `… not exposed through DAEX actions` | ADE | `codedError.ts`, `chatLaunchActions.ts`, `ProvidersSection.tsx`, `useGitHubPrFilterSearch.ts` |
| Bonjour instance name `DAEX Sync <host> <port>` (type `_ade-sync._tcp` stays) | `ADE Sync …` | `syncHostService.ts` orphan cleanup |
| Lane simulators `DAEX · <lane>`, virtual display prefix `DAEX` | `ADE · <lane>` | `looksLikeAdeDeviceName` |
| Deleted-lane trailers `DAEX-Lane-Id` …, snapshot author DAEX | `ADE-Lane-Id` …, ADE | `deletedLaneSnapshots.ts` |
| Stored cloud computer default `DAEX Cloud computer` | `ADE Cloud computer` | `isCloudMachineDefaultName`, `displayLegacyDefaultName` (desktop, iOS, CLI) |
| User agents `DAEX-Agent/1.0`, `DAEX-LinkPreview/1.0`, `DAEX-iOS/<v>`, `DAEX MCP events`, the Worker agents, … | ADE | Gravity `hashedEmailFor` |
| MCP Apps `hostInfo.name` and `userAgent` DAEX | ADE | none |
| GitHub App slug `daex-for-github`: install page, bot `daex-for-github[bot]` | `ade-for-github` | `GITHUB_APP_SLUGS` in `shared/github/githubAppIdentity.ts` (bot table in `prBotIdentity.ts`), iOS `Brand.githubAppSlugs` |

Kept on purpose: the lowercase machine tokens (`ade-desktop`, `ade-cli`,
`ade-harness-test` user agents and RPC client names), `TERM_PROGRAM=ADE`
(outside tools detect terminals by it), and everything in **Frozen
identifiers**. Also kept, because brains are not behind the client minimum
version:

- **`--version` output stays `ade X.Y.Z`** (`versionOutput` in
  `apps/ade-cli/src/cli.ts`). Released `ade brain update`s, DAEX Cloud image
  entrypoints (`ade-entrypoint.sh`) and SSH bootstraps
  (`normalizeRuntimeVersion`) strip only `^ade ` and would read `daex X.Y.Z`
  as the version, silently skipping the update. New readers strip either name.
- **Forwarded run-tool calls use `ade`.** When DAEX MCP forwards its run tool
  to another machine (`forwardTo` in `remoteMcpProtocol.ts`), it sends the
  tool name `ade` and rewrites a leading `daex` in the command to `ade`:
  released machines reject `Unknown tool "daex"` and their policy strips only
  a leading `ade`. New machines map `ade` to `daex`. This stays until the
  `ade` alias is dropped.

## Launch steps

1. **Set the minimum version first.** Before the new links and messages
   matter, set every published kind's minimum to the launch build with
   `scripts/release-tools/client-minimum.mjs set` (guide:
   `docs/playbooks/update-gate.md`; account-side test switches are in
   `docs/features/ade-cloud/account-test-tool.md`). Until then a
   not-yet-updated app can be sent a `daex://` link it does not register.
2. Builds released before the gate existed (v1.2.130 and older) are not
   blocked by it and cannot open `daex://`; only their own updater moves them.
3. **GitHub App rename.** The release links to
   `github.com/apps/daex-for-github/installations/new` (one constant:
   `apps/desktop/src/shared/github/githubAppIdentity.ts`, iOS
   `Brand.githubAppSlug`). GitHub derives the slug from the app's name and
   does not redirect the old one, so the new install page 404s until the
   rename and the old one 404s after it. At the moment the release is
   published:
   1. GitHub → Settings → Developer settings → GitHub Apps → "ADE for
      GitHub" → General: set **GitHub App name** to `DAEX for GitHub` and
      save. Check the slug in the page URL is now `daex-for-github` and
      `https://github.com/apps/daex-for-github/installations/new` opens.
   2. In the same page, **Display information**: upload
      `assets/brand/daex/icon-ios-release.png` (1024 px) as the logo.
   App id, client id, private key, webhook URL and every installation keep
   working; only the name, slug, bot login and logo change. Bot comments and
   check runs made before keep `ade-for-github[bot]`, which the readers still
   accept.
