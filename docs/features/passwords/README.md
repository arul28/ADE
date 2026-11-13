# Passwords

Passwords is ADE's password manager. It keeps saved **logins** (sites,
username, password, notes, an authenticator code) and **secrets** (API keys,
by project) for the signed-in account, on every computer that has it turned
on. Agents can **use** anything in it and never **see** a value: they sign in
with `ade browser signin`, and ADE types the login into the page itself.

It is not the account vault (`account_vault`, `AccountVault*`), which is the
sync store for ADE's own account data.

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
  computer (the person types `reset` to confirm).

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
| `ade passwords list` | Sites, usernames and kinds. Never a value. |
| `ade browser signin [--account <username>]` | Fills a saved login into the open page: only on the tab's own https origin (localhost allowed), never in a cross-origin frame. With no saved login it raises the secure sign-in card in the agent's own chat and waits (`passwords.signin`). |

When the site has no saved login, the agent's chat shows the **secure
sign-in card** (`passwords.requestLogin`). The person either types the login
into the card (**Save & sign in**: it is saved to Passwords, then filled), or
chooses **Enter it myself in the browser**. Both answers are secret answers,
so they never reach the transcript or the agent.

What agents can never do: read a password or a secret value, add, change,
import or remove items, or turn Passwords on or off. These actions are
person-only in `actionPolicy.ts`. `resolveForFill` (the one call that returns
a value) also answers only this computer's own desktop app.

Agent page observations never carry a value ADE filled from Passwords
(`data-ade-vault-filled`), a password field, or a field marked as a password,
one-time code or card number (`agentObservation.ts`).

## Import

Settings › Passwords › **Import…** reads a CSV export from Apple Passwords,
Chrome, Firefox, 1Password or Bitwarden (up to 5 MB). Rows without an https
site or a password, and exact duplicates, are skipped. The file never leaves
the computer except as sealed items; delete it afterwards.

## Not yet

These are planned in the same branch of work and not built yet: the browser's
key button and "Save to Passwords?" after a manual sign-in, Activity, secrets
injection (`ade secrets exec`) and the move of project secrets into
Passwords, authenticator codes and `ade code wait`, the Messages
integration, passkeys in ADE's browser, Apple Passwords "Export to app", and
the iPhone's view-and-copy.

## Deploying

The key-service Worker needs two secrets, set by the owner:
`PASSWORD_KEK_MASTER` (32 random bytes, base64) and `KEY_SERVICE_AUTH_SECRET`
(the same value on the key service and on the push relay). The key service
deploys before the push relay (`deploy-web.yml`).
