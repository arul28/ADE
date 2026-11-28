# Passwords & Secrets

Passwords & Secrets is DAEX's vault for the signed-in account, on every computer
the person signs in to: saved **logins** (sites, username, password, notes, an
authenticator code), **passkeys** DAEX's browser made, and **secrets** (API keys
for every project or for one). Agents can **use** anything in it and never
**see** a value: they sign in with `daex browser signin` and run commands with
secrets through `daex secrets exec` (`ade` still works as the command name).

It is not the account vault (`account_vault`, `AccountVault*`), which syncs
DAEX's own account data.

## Source file map

| Where | What |
| --- | --- |
| `apps/ade-cli/src/services/passwords/passwordService.ts` | The brain's service, one per DAEX home: sealed cache, sync queue, key epochs, Activity, `siteForPage` / `resolveForFill` / `currentCode`. |
| `apps/ade-cli/src/services/passwords/passwordCrypto.ts`, `passwordMatching.ts`, `passwordTotp.ts`, `passwordCsvImport.ts` | Sealing (AES-256-GCM) and generator; site matching (Public Suffix List); TOTP; CSV import. |
| `apps/ade-cli/src/cliPasswords.ts` | `daex passwords`, `daex code`, `daex messages`. |
| `apps/ade-cli/src/adeRpcServer.ts` | Stamps the caller's chat and `calledBy` on `passwords.signin` / `signup`, `project_secret.exec`, `messages.send`. |
| `apps/push-relay/src/passwords.ts`, `apps/password-key-service/src/index.ts` | Sealed items, key epochs, `stale_key`; the key service that wraps each account's vault key. |
| `apps/desktop/src/main/services/passwords/` | `passwordsDomain.ts` (the action domain), `passwordSignin.ts`, `passwordLoginRequest.ts` (sign-in card), `localPasswordsBridge.ts`, `personCheck.ts` (Touch ID / Windows Hello / confirm). |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserLoginOffers.ts`, `builtInBrowserPasskeys.ts`, `passkeys/` | "Save to Passwords?", and the ES256 authenticator. |
| `apps/desktop/src/preload/browserMedia.ts`, `apps/desktop/src/shared/passwordFillTarget.ts` | Tab preload (login capture, passkey hook); the one rule for which pages Passwords acts on. |
| `apps/desktop/src/main/services/secrets/projectSecretService.ts`, `secretExec.ts`, `projectSecretEnv.ts` | A project's view of secrets and the old-store move; `daex secrets exec`; `.env` parsing and export. |
| `apps/desktop/src/main/services/messages/`, `messagesIntegration/` | Messages reader, sender, code finder, `messages` domain. |
| `apps/desktop/src/renderer/components/settings/passwords/`, `chat/PasswordLoginCard.tsx`, `chat/browser/BrowserPasswordsButton.tsx` | Settings, the sign-in card, the browser key button. |
| `apps/ios/ADE/Services/PasswordsVault.swift`, `Views/Account/PasswordsViews.swift` | The iPhone's read-only view. |

## Gotchas

- **A brain with sync off has no Passwords**: `passwords.call` answers
  `action_not_callable` (for example `npm run dev:desktop`, which runs its brain
  with `--no-sync`). Pinned project calls such as the `.env` import still work.
- **The vault is the account's, so Settings takes no pin**: it always calls this
  computer's brain (`passwords.call`). The `.env` import is the exception (it
  reads a file on the lane's machine through the lane's pin).
- **Values never reach a renderer or an agent.** Show, Copy and Export run in
  desktop main; `resolveForFill` answers only this computer's desktop app;
  agent-facing writes and reads of values are person-only in `actionPolicy.ts`.
  A new action that returns a value breaks this.
- **The relay refuses browsers** on passwords and vault routes
  (`BROWSER_ACCOUNT_ROUTES`).
- **Off, sign-out and Reset win over a sync in flight**; keep that ordering.
- Not supported: Apple Passwords "Export to app", Mac-wide AutoFill, Activity
  across computers.

## On by default

- **On on every computer** signed in to DAEX. The only switch is **Turn off on
  this computer** (Settings ⋯), stored in `<ade home>/passwords/state.json`; off
  forgets the key and cached items there.
- **DAEX Cloud computers** follow one account switch (`passwords.cloudEnabled`,
  on unless set off), checked before every use.
- **Reset** (⋯ menu) starts a new, empty vault under a new key for every computer,
  after typing `reset` and Touch ID / Windows Hello. This-computer-only secrets
  stay.

## In Settings

No machine picker; a status bar with counts, **Import** (CSV logins, `.env`
secrets), **New** and the ⋯ menu; results as toasts.

- **Logins**: password as dots with **Show** (30 s) and **Copy**, the live 2FA
  code, **Change password**, **Delete**. Authenticator keys accept `otpauth://`.
- **Secrets**: grouped by project ("Every project" first) with Show, Copy,
  change, delete and **Export .env**; a **This computer** tag on device-only ones;
  **Keep on this computer only** is under More options.
- **Activity**: this computer's recorded uses (sign-ins, `daex secrets exec`),
  sealed locally, at most 500 rows.

Show, Copy and Export ask for Touch ID or Windows Hello and run in desktop main;
the clipboard is cleared after 90 s; an export is a new `0600` file in Downloads.
Passkey private keys are never shown.

## How it is kept

- Each item is sealed on the computer with AES-256-GCM under the account's vault
  key; the additional data binds account, item id and key epoch.
- The push relay stores only sealed items (`password_items`) and the **wrapped**
  key (`password_keys`). `apps/password-key-service` wraps it with a per-account
  key-encryption key and is reachable only through the relay's service binding.
  Every key release is recorded (`password_key_releases`).
- Only native clients and brains reach the relay's Passwords routes (under
  `/attention/account/passwords/*`).
- The key is cached in DAEX's encrypted file store on a person's computer, in
  memory only on a DAEX Cloud computer.
- A write on an old copy is refused (`stale`). Sync runs every minute and after
  each change.

## What agents can do

| Command | What it does |
| --- | --- |
| `daex passwords list` / `status` / `sync` | Sites, usernames, kinds; never a value. |
| `daex browser signin [--account <u>]` | Fills a saved login into the open page (the tab's own https origin, localhost allowed; never a cross-origin frame or a page that moved mid-fill); fills the current code on a code page. With no saved login, raises the secure sign-in card in the agent's chat and waits. |
| `daex browser signup [--account <u>]` | Makes a strong password sized to the field (refuses boxes under 12 characters), types and verifies it, then saves the login for the exact origin. |
| `daex code --site <host>` | The site's current authenticator code, never the key. |
| `daex code wait --site <host> [--from messages]` | The code now, or the next one texted to the person's Mac. |
| `daex secrets exec [--env NAME] -- <cmd>` | Runs the command with the project's secrets, output masked. |

The **secure sign-in card** (`passwords.requestLogin`) takes the login (**Save &
sign in**) or **Enter it myself in the browser**; answers never reach the
transcript or the agent, and only the person can answer
(`isUserOnlyConsentCard`). Agents can never read a value, change items, or turn
Passwords on or off. Agent page observations never carry a filled value or a
password, code or card field (`agentObservation.ts`), and a filled password stays
drawn as dots even if the page reveals it.

## Secrets: use, never read

A secret is for **every project** (`projectScope: null`) or **one project**
(`repo:<host>/<owner>/<name>`, shared by every clone; or `path:<dir>` with no
remote). A project's commands get every-project secrets, then the project's own
over them; within each, device-only over synced. A **this computer only** secret
(`deviceOnly`, ids `dev_…`) never syncs.

`daex secrets` (`project_secret`, `projectSecretService`): `list`, `set`
(`--storage device`), `delete`, `request` (the private secret card), `exec`.
`daex secrets get` is the person's; an agent is refused.

`daex secrets exec` runs the command in the brain, inside the project or one of
its lanes on this computer (a relayed call is refused); values go only into the
child's environment; output masks each value as `[secret]`, also in base64,
base64url and URL-encoded forms (values under 8 characters are not masked). A
timeout stops the whole process tree. Masking is best effort, which is why DAEX
never puts secrets in an agent CLI's own environment.

**The move from the old store.** Old `.ade/secrets/project-secrets.v1.enc` entries
and old `project_secret` account rows move into Passwords & Secrets when the
project opens and on each account sync (`projectSecretService.migrateLegacy`),
silently: only by the runtime that owns the project, never while Passwords is off,
device-only entries stay device-only, a newer value or a later delete wins, two
computers write the same derived item id, and an old copy is removed only once the
new one holds its value. `daex secrets delete` removes old copies too.

## Authenticator codes and Messages

- TOTP (RFC 6238; SHA-1/256/512, 6–8 digits) codes go to Settings, `daex code` and
  `daex browser signin`. Agents may read codes, never the key.
- **Messages** (Settings › Integrations, Macs only): off until connected; reading
  needs Full Disk Access (a worker reads `~/Library/Messages/chat.db` read-only);
  each text sent asks the person (recipient and exact text) unless Send Without
  Asking is on. `daex messages recent|chats|send` and `daex code wait` reach the
  person's Mac, also from a cloud lane.

## Passkeys in DAEX's browser

DAEX's browser answers `navigator.credentials.create/get` with saved passkeys (a
software authenticator, ES256, `none` attestation). The tab preload hooks the call
and desktop main decides (`builtInBrowserPasskeys.ts`): the RP ID must belong to
the asking frame's own origin; cross-origin frames, Passwords off, no saved
passkey, or conditional requests go to the browser's own WebAuthn; every use asks
the person. Verification uses SimpleWebAuthn.

## On the iPhone

Settings › Account › Passwords & Secrets lists logins and secrets read-only. The
phone fetches sealed items and the key from the relay and opens them with
CryptoKit; the key stays in the Keychain (this device only) and is deleted on
sign-out. Reveal and Copy ask for Face ID. Passkeys are not listed.

## Import

**Logins from a CSV…** (Apple Passwords, Chrome, Firefox, 1Password, Bitwarden; ≤5
MB; rows without an https site or password, and duplicates, skipped). **Secrets
from a .env…** (≤1 MB) lists names and value lengths and saves the chosen ones
(`passwords.importSecrets`).

### The `.env` tip

A main checkout with a git-ignored `.env` gets a card "Import your .env to DAEX
secrets" (new lanes and DAEX Cloud start without that file). The signal is
`envFiles` on the main checkout's lane dependency status (`listIgnoredDotenvFiles`
in `main/services/projects/projectRemovalState.ts`; skips `.env.example`,
`.env.sample`, `node_modules`), already read for another notice. Only the
person's own connected computers show it
(`components/app/suggestions/useEnvImportSuggestion.ts`). **Import it** reads the
file on its own machine through the lane's pin (`passwords.previewLaneEnv` gives
names and lengths only; `passwords.importLaneEnv` saves there), and only a path
the checkout's ignored-file list names.

## In the browser, for the person

- **The key button** in the address bar shows when there are logins for the site;
  a pick fills the page from main (the renderer never gets a value).
- **"Save to Passwords?"**: after a login form the person sent by hand, the tab
  preload hands the typed values to main (`builtInBrowserLoginOffers.ts`), which
  holds them five minutes for **Save** or **Update password**. Only top-frame https
  (or localhost), only when Passwords is on, never right after an agent's click,
  never for a login already saved with that password.

## On the web

The web app never reads the vault. Settings shows only `WEB_PASSWORDS_SENTENCE`
(`shared/adeCloud/accountCalls.ts`): "Open DAEX desktop or the iPhone to see and
change Passwords. Agents on every computer, DAEX Cloud too, still use them."

## Deploying

The key service needs `PASSWORD_KEK_MASTER` (32 random bytes, base64) and
`KEY_SERVICE_AUTH_SECRET` (same value on the key service and the push relay); it
deploys before the push relay (`deploy-web.yml`).
