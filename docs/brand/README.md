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
| MCP server and tool names | the tools ADE MCP exposes | `apps/ade-cli/src/services/remoteMcp/` | Handled in a later step: agents and saved prompts call them by name. |

## Sunset identifiers

These are public, so they move to the new name, but the old one keeps
working. Later steps read both.

| Old | New | Plan |
|---|---|---|
| `ADE_*` env vars | `DAEX_*` | Read `DAEX_*` first, fall back to `ADE_*`. Never stop reading `ADE_*`. |
| `ade://` links | `daex://` | Register both schemes (desktop `build.protocols` in `apps/desktop/package.json`, iOS `ADE_URL_SCHEME` in `project.pbxproj` and `CFBundleURLSchemes` in `apps/ios/ADE/Info.plist`); parse both in `apps/desktop/src/shared/deeplinks.ts`. Accepted forever. |
| ade-app.dev | daex.dev | Site and open links move first (`ADE_DEEPLINK_HTTPS_HOST` in `deeplinks.ts`). Sign-in (`DEFAULT_ADE_CLERK_ISSUER` in `apps/desktop/src/shared/accountDirectory.ts`) and API hosts stay until released clients no longer call them. |
| `ade` CLI | `daex` | `daex` becomes the binary (`bin` in `apps/ade-cli/package.json`); `ade` stays as a permanent alias. |
| `@ade-dev/*` packages | `@daex-dev/*` | Publish under the new scope; keep the old packages pointing at it (`packages/sdk/package.json`, `packages/chat-ui/package.json`). |
