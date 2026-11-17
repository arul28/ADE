# Passwords & Secrets

Passwords & Secrets is ADE's vault. It keeps saved **logins** (sites,
username, password, notes, an authenticator code), **passkeys** that ADE's
browser made, and **secrets** (API keys: for every project, or for one) for the
signed-in account, on every computer the person signs in to. Agents can **use**
anything in it and never **see** a value: they sign in with
`ade browser signin`, and run commands with secrets through `ade secrets exec`.

A project's secrets are Passwords & Secrets items for that project (see
[Secrets](#secrets-use-never-read)).

It is not the account vault (`account_vault`, `AccountVault*`), which is the
sync store for ADE's own account data.

## Source file map

| Where | What |
| --- | --- |
| `apps/ade-cli/src/services/passwords/passwordService.ts` | The brain's service, one per ADE home: sealed cache, sync queue, key epochs, Activity, `siteForPage` / `resolveForFill` / `currentCode`. |
| `apps/ade-cli/src/services/passwords/passwordCrypto.ts`, `passwordMatching.ts`, `passwordTotp.ts`, `passwordCsvImport.ts` | Sealing (AES-256-GCM) and the site-password generator; site matching (Public Suffix List); TOTP; CSV import. Tests: `passwordService.test.ts`. |
| `apps/ade-cli/src/cliPasswords.ts` | `ade passwords`, `ade code`, `ade messages`: plans and text output. |
| `apps/ade-cli/src/adeRpcServer.ts` | Stamps the caller's chat and `calledBy` on `passwords.signin` / `signup`, `project_secret.exec` and `messages.send`; refuses `built_in_browser.signin` / `signup`. |
| `apps/push-relay/src/passwords.ts`, `apps/password-key-service/src/index.ts` | Sealed items, key epochs and `stale_key`; the key service that wraps each account's vault key. |
| `apps/desktop/src/main/services/passwords/passwordsDomain.ts` | The `passwords` action domain (summaries, the person's writes, `signin`, `signup`, the sign-in card). |
| `apps/desktop/src/main/services/passwords/passwordSignin.ts`, `passwordLoginRequest.ts` | `ade browser signin` / `signup` around the browser half; the secure sign-in card. |
| `apps/desktop/src/main/services/passwords/localPasswordsBridge.ts`, `personCheck.ts` | Desktop main's access to this computer's brain, the browser tab's Passwords IPC (login capture, WebAuthn); Touch ID / Windows Hello / confirm, and the passkey account chooser. |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserService.ts`, `builtInBrowserLoginOffers.ts`, `builtInBrowserPasskeys.ts`, `passkeys/` | Filling and signing up in the page, "Save to Passwords?", and the ES256 authenticator. |
| `apps/desktop/src/preload/browserMedia.ts` | The tab preload: login capture and the page-world passkey hook. |
| `apps/desktop/src/shared/passwordFillTarget.ts` | The one rule for which pages Passwords acts on. |
| `apps/desktop/src/main/services/secrets/projectSecretService.ts` | One project's view of the secrets (`ade secrets`, process env, webhook checks), and the one-time move of the old per-project store. |
| `apps/desktop/src/main/services/secrets/secretExec.ts`, `projectSecretEnv.ts` | `ade secrets exec`: run with secrets, mask the output, stop the whole tree on a timeout; `.env` parsing and the export file. |
| `apps/desktop/src/main/services/messages/`, `messagesIntegration/` | The Messages reader worker, sender, code finder, and the `messages` domain. |
| `apps/desktop/src/renderer/components/settings/passwords/`, `chat/PasswordLoginCard.tsx`, `chat/browser/BrowserPasswordsButton.tsx` | Settings › Passwords & Secrets, the sign-in card, and the browser's key button. |
| `apps/ios/ADE/Services/PasswordsVault.swift`, `Views/Account/PasswordsViews.swift` | The iPhone's read-only view. |

## On by default

- **On on every computer**, with nothing to turn on: a computer signed in to
  ADE opens the account's vault on its own. The only switch is the rarely
  wanted **Turn off on this computer** (Settings › Passwords & Secrets › ⋯),
  stored in `<ade home>/passwords/state.json` (`{ "enabled": false }`; no file
  means on). Off forgets the key and every cached item on that computer, and
  nothing there uses the vault or that computer's own secrets; the account's
  copy stays. Turning it back on syncs before it answers.
- **ADE Cloud computers** follow one account-wide switch, **ADE Cloud
  computers can use it** (the ⋯ menu; the account setting
  `passwords.cloudEnabled`, on unless set off). A cloud brain checks it before
  every use and forgets the key when it goes off.
- **Off, sign-out and Reset win over a sync in flight.** A sync or an open
  that started before one of them writes, fetches and opens nothing after it,
  and stops when Passwords is off or another account is signed in.
- **Reset Passwords & Secrets** (⋯ menu) starts a new, empty vault under a new
  key, for every computer. The person types `reset`, then confirms with Touch ID
  or Windows Hello (a confirm dialog on a computer with neither). Secrets kept
  on one computer only stay.

## In Settings

Settings › Passwords & Secrets has no machine picker: the vault is the
account's, so the page always reads and writes this computer's brain
(`passwords.call` through main), whatever project tab the window is on. A
status bar holds the counts, **Import** (logins from a CSV, secrets from a
`.env`), **New** (login or secret) and the ⋯ menu (the ADE Cloud switch, Turn
off, Reset). The result of every action is a toast, so it shows wherever the
page is scrolled. Each view has its own empty state with what to do next.

- **Logins** lists the saved logins and passkeys with their username and
  sites. A login's details show its password as dots with **Show** (for 30 s)
  and **Copy**, the live 2FA code, and when it last changed. **Change
  password** saves a new password and keeps the login's exact sites, username,
  notes and code; **Delete** confirms first. A login can be saved with an
  authenticator key (the `otpauth://` link or the key a site shows).
- **Secrets** groups the saved secrets by project ("Every project" first), with
  Show, Copy, change and delete on each row, and **Export .env** on each group.
  A secret kept on this computer only wears a **This computer** tag; a synced
  one, a cloud mark. **New secret** defaults to the open project; **Keep on
  this computer only** is under **More options**, never the default.
- **Activity** lists this computer's recorded uses, newest first: each agent
  or person sign-in (site, account) and each `ade secrets exec` (which names,
  which command), with who, which computer and when. It is kept on the
  computer only, sealed in its encrypted store, at most 500 rows.

**Show**, **Copy** and **Export .env** ask for Touch ID (macOS) or Windows
Hello first, and run in desktop main on this computer's own brain. A copy goes
to the clipboard in main, so the value never reaches the page, and the
clipboard is cleared after 90 s if it still holds it. An export is a new
mode-`0600` file in this computer's Downloads. A passkey's private key is never
shown.

## How it is kept

- Each item is sealed on the computer with AES-256-GCM under the account's
  vault key. The additional data binds the account, the item id and the key
  epoch, so a sealed item can't be moved to another account or item, or
  replayed under an older key.
- The push relay stores only sealed items (`password_items`, with revisions
  and tombstones) and the vault key **wrapped** (`password_keys`). A separate
  Worker, `apps/password-key-service`, wraps and unwraps the key with a
  per-account key-encryption key (HKDF of its own master secret and the
  account id). It is reachable only through the relay's service binding,
  with a shared secret. A dump of the relay's database opens nothing.
- Every time the relay hands the key out, it records the device and machine
  kind (`password_key_releases`).
- Only native clients and brains reach the relay's Passwords routes
  (`GET`/`PUT passwords/items`, `POST passwords/key`, `POST passwords/reset`,
  `GET passwords/releases`, under `/attention/account/`). A request from a
  browser page (it has an `Origin` header) gets `403` before authentication
  (`BROWSER_ACCOUNT_ROUTES` in `apps/push-relay/src/relay.ts`). The account
  vault routes are native-only for the same reason. See "On the web".
- On a person's computer the key is cached in ADE's encrypted file store; on
  an ADE Cloud computer it stays in memory only.
- A write made on an old copy of an item is refused (`stale`) instead of
  replacing the newer one. Sync runs every minute and after each change.

The brain owns one Passwords service per ADE home
(`apps/ade-cli/src/services/passwords/passwordService.ts`), shared by every
project runtime and by the machine route `passwords.call`, which Settings and
the browser's fill use with no project open.

## What agents can do

| Command | What it does |
| --- | --- |
| `ade passwords list` / `status` / `sync` | Sites, usernames and kinds; whether Passwords is on here. Never a value. |
| `ade browser signin [--account <username>]` | Fills a saved login into the open page: only on the tab's own https origin (localhost allowed), never in a cross-origin frame, and never after the page moved to another site mid-fill. On a code page it fills the current authenticator code. With no saved login it raises the secure sign-in card in the agent's own chat and waits (`passwords.signin`). Each fill adds an Activity row and a quiet line in the chat ("Signed in to vercel.com as … with a saved login."). |
| `ade browser signup [--account <username>]` | On a sign-up form: makes a strong password (sized to the field's limit; a box that takes fewer than 12 characters is refused), types it into the new-password and confirm boxes, checks the form kept all of it, then saves the login to Passwords for the tab's exact origin (`passwords.signup`). A failed check or save clears the boxes and saves nothing; a second login for the same account is refused. The username is `--account`, else what the form's email/username field holds. Same page rules as `signin`; an Activity row and a quiet chat line ("Made a new password for … and saved it to Passwords."). |
| `ade code --site <host>` | The site's current authenticator code (never the key). |
| `ade code wait --site <host> [--from messages]` | The authenticator code at once when the site has one, else the next code texted to the person's Mac (Messages) after the ask. |
| `ade secrets exec [--env NAME] -- <command>` | Runs the command on this computer with the project's secrets (and Passwords' secrets for the project) in its environment, and returns its output with every value masked. |

When the site has no saved login, the agent's chat shows the **secure
sign-in card** (`passwords.requestLogin`). The person either types the login
into the card (**Save & sign in**: it is saved to Passwords, then filled), or
chooses **Enter it myself in the browser** (the command then says so, and the
agent waits with `ade browser handoff`). Both answers are secret answers, so
they never reach the transcript or the agent, and only the person can answer
the card (`isUserOnlyConsentCard`). An outside agent on ADE MCP sees the card
in its inbox as a `signIn` item with no way to answer it there: the person
answers in ADE.

What agents can never do: read a password or a secret value, add, change,
import or remove items, or turn Passwords on or off. These actions are
person-only in `actionPolicy.ts`. `resolveForFill` (the one call that returns
a value) also answers only this computer's own desktop app.

Agent page observations never carry a value ADE filled from Passwords
(`data-ade-vault-filled`), a password field, or a field marked as a password,
one-time code or card number (`agentObservation.ts`). A password ADE filled
stays drawn as dots (`-webkit-text-security`) even after the page's own "show
password" switch makes it a text field, so a screenshot an agent takes does
not show it either. A page script could still read a field's value; ADE's
agents have no command that runs page script.

`ade secrets exec` stops the command's whole process tree when it times out
(its own process group on macOS and Linux, `taskkill /T` on Windows), and
returns once the command exits even if something it started still holds the
output open.

## Secrets: use, never read

A secret is for **every project** (`projectScope: null`) or for **one
project**: its repository (`repo:<host>/<owner>/<name>`, so every clone on
every computer shares it) or, with no remote, its folder (`path:<dir>`). A
project's commands get the secrets for every project, then the project's own
over them; within each, a this-computer-only secret over a synced one. One name
per project per place: saving a name that is already there updates it.

A **this computer only** secret (`deviceOnly`, ids `dev_…`) is kept in the
machine-sealed cache and never synced, so it shows, and works, only on the
computer that has it (not on the iPhone, not on other computers).

`ade secrets` is a project's view of them (`project_secret`, through
`projectSecretService`): `list`, `set` (`--storage device` for this computer
only; without it, a name this computer keeps for itself stays here), `delete` (the project's own), `request` (the private secret card) and
`exec`. A caller that cannot wait (a webhook's signature check) reads what this
computer already holds; the open is kept warm by the minute's sync, and a cold
process opens the cached copy from disk.

**The move from the old store.** A project that still has the old
`.ade/secrets/project-secrets.v1.enc`, or old `project_secret` rows in the
account vault from an older ADE, has them moved into Passwords & Secrets for
that project when it opens and on each account sync
(`projectSecretService.migrateLegacy`), without any notice. The rules:

- Only the runtime that owns the project moves it. Another process (desktop
  main without a Passwords service) reports the move as not done, so the
  runtime still runs it.
- While Passwords & Secrets is off nothing moves. Account entries wait for
  sign-in and for a fresh pull of the account's rows (at most a minute old).
- Device-only entries stay this computer only. So do a value too big for the
  relay, sign-in's own config names, and every entry of a project with no
  repository remote.
- A name already there with a newer value is left alone. A name the account
  deleted after the old copy was saved stays deleted. An entry the old store
  pulled from another account is dropped, never moved into this one.
- Two computers that move the same old secret write the same item id (derived
  under the vault key), so the relay keeps one copy.
- Each old copy is removed only once the new place holds its value: an account
  secret once the relay holds it at the same or a newer version. Until then,
  processes still read it from the old store.
- An old account row is removed only while it is still the one the move read;
  a row another computer changed since stays for the next run.
- `ade secrets delete` removes the old copies of the name too (the file entry
  and live old account rows), so it cannot come back from them. A delete and
  the move run one at a time.

`ade secrets get` is the person's (the desktop app); an agent calling it is
refused. Agents use secrets with
`ade secrets exec` (`project_secret.exec`): the brain runs the command, so the
values go only into the child's environment, and the output comes back with
each value masked as `[secret]`, also in base64, base64url and URL-encoded
form. Values under 8 characters are not masked (the result names them). The
command runs only inside the project or one of its lanes, on this computer: a
call relayed from another machine's brain is refused. Masking is best effort:
a command that transforms a value another way can print it, which is why ADE
never puts secrets in an agent CLI's own environment.

## Authenticator codes and Messages

- A login's authenticator (TOTP, RFC 6238; SHA-1/256/512, 6–8 digits) gives
  its current code to Settings, `ade code`, and `ade browser signin` on a code
  page. Agents may read codes; nobody but the person reads the key.
- **Messages** (Settings › Integrations › Messages, Macs only) lets agents read
  the person's texts and send texts. Off until connected; then Read Texts on,
  Send Texts on with an approval card for every text (recipient and exact
  text, person-only), Send Without Asking off. Reading needs Full Disk Access
  for ADE; a worker process reads `~/Library/Messages/chat.db` read-only
  (`services/messages`). Sending goes through the Messages app (Automation
  permission), with the text passed as an argument, never as script source.
  `ade messages recent|chats|send` and `ade code wait` reach the Mac the person
  sits at, also from a cloud lane. Shopping texts ("use code SAVE20 at
  checkout") are not taken as sign-in codes.

## Passkeys in ADE's browser

ADE's browser answers `navigator.credentials.create/get` with passkeys saved in
Passwords (a software authenticator, ES256, `none` attestation, backed up).
The tab preload hooks the page's call and desktop main decides
(`builtInBrowserPasskeys.ts`):
the origin is the asking frame's own; the RP ID must belong to it; a frame on
another origin, Passwords being off, no saved passkey for the site, or an
"autofill" (conditional) request all go to the browser's own WebAuthn; every
use and every new passkey asks the person (Touch ID / Windows Hello; a site
that requires verification gets the browser's own WebAuthn when only a
confirm dialog was possible). Registrations and assertions verify with an
independent relying-party library (SimpleWebAuthn).

## On the iPhone

Settings › Account › Passwords & Secrets lists logins and secrets (read only),
secrets with their project's name. The phone
fetches the sealed items and the key from the relay itself and opens them with
CryptoKit; the key stays in the Keychain (this device only) and is deleted on
sign-out. Reveal and Copy ask for Face ID; a copy stays on the device and
expires after 90 s. The phone asks for the key only once saved items exist,
so it never creates a vault the person did not turn on. Passkeys are not
listed there.

## Import

Settings › Passwords & Secrets › **Import** › **Logins from a CSV…** reads a
CSV export from Apple Passwords, Chrome, Firefox, 1Password or Bitwarden (up to
5 MB). Rows without an https site or a password, and exact duplicates, are
skipped. **Secrets from a .env…** reads a `.env` file the person picks on this
computer (1 MB), lists its names with each value's length, and saves the
chosen ones for one project or every project (`passwords.importSecrets`). Files
never leave the computer except as sealed items; delete them afterwards.

### The `.env` tip

A project whose main checkout has a `.env` file that git ignores gets a
suggestion card: "Import your .env to ADE secrets". New lanes and ADE Cloud
start without that file, and secrets reach every lane and computer.

- The signal is `envFiles` on the lane dependency status of the main checkout
  (`listIgnoredDotenvFiles` in `main/services/projects/projectRemovalState.ts`).
  It lists each ignored `.env*` file once and skips `.env.example`,
  `.env.sample` and files under `node_modules`. The status read already exists
  for the lane-template notice, so the tip costs no call of its own.
- Only a connected computer of the person's own shows it
  (`components/app/suggestions/useEnvImportSuggestion.ts`). ADE Cloud has no
  checkout of the person's own to import from.
- **Import it** opens Settings › Passwords & Secrets with the import dialog.
  The file is read on its own machine, through the lane's pin:
  `passwords.previewLaneEnv` returns names and value lengths only, and
  `passwords.importLaneEnv` saves the picked names there. No value comes to
  the window. Only a path that the checkout's own ignored-file list names is
  read.

## In the browser, for the person

- **The key button** in the address bar shows when Passwords has logins for the
  open page's site. Picking one fills it into the page (desktop main reads the
  tab's own URL; the renderer never gets a value). **Manage passwords…** opens
  Settings › Passwords & Secrets.
- **"Save to Passwords?"** After the person sends a login form by hand, the tab
  preload (`preload/browserMedia.ts`, isolated world) hands the typed username
  and password to desktop main (`builtInBrowserLoginOffers.ts`). Main keeps
  them for five minutes and the key button offers **Save** or **Update
  password**; nothing is saved unless the person says so. Offers are made only
  for the tab's top frame on https (or localhost), only when Passwords is on,
  never right after an agent's own click, and never for a login already saved
  with the same password. A two-step sign-in's username page is remembered
  until its password page is sent.

## On the web

The web app never reads the vault: the push relay refuses every passwords
route to a browser. Settings › Passwords & Secrets on the web shows only one
sentence, `WEB_PASSWORDS_SENTENCE` (`shared/adeCloud/accountCalls.ts`): "Open
ADE desktop or the iPhone to see and change Passwords. Agents on every
computer, ADE Cloud too, still use them." The web adapter's passwords calls
throw the same sentence.

## Gotchas

- **A brain with sync off has no Passwords.** The machine route
  `passwords.call` answers "action_not_callable: passwords.status is
  unavailable in this runtime" when the brain made no machine account stores.
  `npm run dev:desktop` starts its brain with `--no-sync`, and a scratch
  `ADE_HOME` is not a sync-capable home, so Settings › Passwords & Secrets
  fails there. Project (pinned) calls such as the `.env` import still work.

## Not yet

- **Apple Passwords "Export to app" and Mac-wide AutoFill** need an AutoFill
  capability on ADE's App ID and new Developer ID provisioning profiles; CSV
  import covers moving logins in meanwhile.
- **Activity across computers**: each computer keeps its own.

## Deploying

The key-service Worker needs two secrets, set by the owner:
`PASSWORD_KEK_MASTER` (32 random bytes, base64) and `KEY_SERVICE_AUTH_SECRET`
(the same value on the key service and on the push relay). The key service
deploys before the push relay (`deploy-web.yml`).
