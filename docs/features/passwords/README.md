# Passwords

Passwords is ADE's password manager. It keeps saved **logins** (sites,
username, password, notes, an authenticator code), **passkeys** that ADE's
browser made, and **secrets** (API keys, by project) for the signed-in
account, on every computer that has it turned on. Agents can **use** anything in it and never **see** a value: they sign in
with `ade browser signin`, and ADE types the login into the page itself.

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
| `apps/desktop/src/main/services/secrets/secretExec.ts` | `ade secrets exec`: run with secrets, mask the output, stop the whole tree on a timeout. |
| `apps/desktop/src/main/services/messages/`, `messagesIntegration/` | The Messages reader worker, sender, code finder, and the `messages` domain. |
| `apps/desktop/src/renderer/components/settings/passwords/`, `chat/PasswordLoginCard.tsx`, `chat/browser/BrowserPasswordsButton.tsx` | Settings › Passwords, the sign-in card, and the browser's key button. |
| `apps/ios/ADE/Services/PasswordsVault.swift`, `Views/Account/PasswordsViews.swift` | The iPhone's read-only view. |

## Turning it on

- **Off until the person turns it on, on each computer:** Settings ›
  Passwords › **Use Passwords on this computer**. The switch is stored in
  `<ade home>/passwords/state.json` (only `{ "enabled": true|false }`).
  Turning it off forgets the key and every cached item on that computer; the
  account's copy stays.
- **ADE Cloud computers** follow one account-wide switch, **ADE Cloud
  computers can use Passwords** (the account setting
  `passwords.cloudEnabled`). It starts on the first time any computer turns
  Passwords on. A cloud brain checks it before every use and forgets the key
  when it goes off.
- **Reset Passwords** starts a new, empty vault under a new key, for every
  computer. The person types `reset`, then confirms with Touch ID or Windows
  Hello (a confirm dialog on a computer with neither).

## In Settings

Settings › Passwords follows one machine at a time (the machine picker in the
title, like Providers). The two switches are the page's own: this computer's,
and the account-wide ADE Cloud one.

Saving, importing and **Reset** run on this computer when Passwords is on
here, and the machine the page follows pulls the change at once. When it is
off here, they go to that machine over the paired connection instead; Reset
still asks for Touch ID or Windows Hello on this computer first.

- **Logins** lists the saved logins and passkeys with their username and
  sites. A login's details show its password as dots with **Show** (for 30 s)
  and **Copy**, the live authenticator code, and when it last changed.
  **Change password…** saves a new password and keeps the login's exact sites,
  username, notes and code; **Delete** confirms first. A login can be saved
  with an authenticator key (the `otpauth://` link or the key a site shows).
- **Secrets** lists the saved API keys by name and project scope, with Show,
  Copy, **Change value…** and **Delete**.
- **Activity** lists this computer's recorded uses, newest first: each agent
  or person sign-in (site, account) and each `ade secrets exec` (which names,
  which command), with who, which computer and when. It is kept on the
  computer only, sealed in its encrypted store, at most 500 rows.

**Show** and **Copy** ask for Touch ID (macOS) or Windows Hello first, and
run in desktop main on this computer's own brain (`passwords.revealValue`,
person-only and this-desktop-only). A copy goes to the clipboard in main, so
the value never reaches the page, and the clipboard is cleared after 90 s if it
still holds it. A passkey's private key is never shown.

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

`ade secrets get` and `ade secrets export` are the person's (the desktop app's
Secrets page); an agent calling them is refused. Agents use secrets with
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

Settings › Account › Passwords lists logins and secrets (read only). The phone
fetches the sealed items and the key from the relay itself and opens them with
CryptoKit; the key stays in the Keychain (this device only) and is deleted on
sign-out. Reveal and Copy ask for Face ID; a copy stays on the device and
expires after 90 s. The phone asks for the key only once saved items exist,
so it never creates a vault the person did not turn on. Passkeys are not
listed there.

## Import

Settings › Passwords › **Import…** reads a CSV export from Apple Passwords,
Chrome, Firefox, 1Password or Bitwarden (up to 5 MB). Rows without an https
site or a password, and exact duplicates, are skipped. The file never leaves
the computer except as sealed items (or, with Passwords off here, to the
machine Settings follows, over the paired connection); delete it afterwards.

## In the browser, for the person

- **The key button** in the address bar shows when Passwords has logins for the
  open page's site. Picking one fills it into the page (desktop main reads the
  tab's own URL; the renderer never gets a value). **Manage passwords…** opens
  Settings › Passwords.
- **"Save to Passwords?"** After the person sends a login form by hand, the tab
  preload (`preload/browserMedia.ts`, isolated world) hands the typed username
  and password to desktop main (`builtInBrowserLoginOffers.ts`). Main keeps
  them for five minutes and the key button offers **Save** or **Update
  password**; nothing is saved unless the person says so. Offers are made only
  for the tab's top frame on https (or localhost), only when Passwords is on,
  never right after an agent's own click, and never for a login already saved
  with the same password. A two-step sign-in's username page is remembered
  until its password page is sent.

## Not yet

- **Apple Passwords "Export to app" and Mac-wide AutoFill** need an AutoFill
  capability on ADE's App ID and new Developer ID provisioning profiles; CSV
  import covers moving logins in meanwhile.
- **Moving existing project secrets into Passwords**: project secrets keep
  working where they are (and `ade secrets exec` gives both kinds); a move
  would make them depend on Passwords being on, per computer.
- **Activity across computers**: each computer keeps its own.

## Deploying

The key-service Worker needs two secrets, set by the owner:
`PASSWORD_KEK_MASTER` (32 random bytes, base64) and `KEY_SERVICE_AUTH_SECRET`
(the same value on the key service and on the push relay). The key service
deploys before the push relay (`deploy-web.yml`).
