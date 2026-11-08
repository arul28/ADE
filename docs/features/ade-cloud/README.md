# ADE Cloud

ADE Cloud is an ADE feature: Linux machines ADE runs for the person. Each one
has ADE's brain as its main process, signs in to the person's ADE account with
nothing to type, and appears under Your computers. From then on it is an
ordinary remote machine (see [Remote Runtime](../remote-runtime/README.md)).

The product plan and build order are in
[docs/plans/ade-cloud-roadmap.md](../../plans/ade-cloud-roadmap.md).

Everything here is account-level: it acts on the account's cloud machines, not
on a lane, chat or another machine, so these IPC calls take no pin. A new
machine's own actions go through the machine list like any other computer.

## Layers

```
renderer (window.ade.cloud)   CLI (ade cloud)   phone (cloud.read/write)
              \                     |                  /
       registerCloudIpc      `cloud` action domain (adeActions/registry.ts)
                       \            |
        machines, sleep, create, copy, move, ready machines, spending, sign-ins
                                    |            (apps/desktop/src/main/services/adeCloud/)
                       CloudProvider (cloudProvider.ts)
                                    |
                 getCloudProvider (cloudAccess.ts)   <- the one place that picks the provider
                                    |
                 provider/agent37/agent37Client.ts   <- the only code that knows the provider's API
```

A lint rule (`apps/desktop/eslint.config.mjs`) stops anything but
`cloudAccess.ts` from importing a provider. Above the seam, nothing knows who
runs the computers.

## The provider seam

`CloudProvider` (`cloudProvider.ts`) is the contract: list, get, create, delete,
sleep, start, resize, back up, auto-sleep, public port, fork, signed URL, name,
metadata, usage, whether a template exists, and exec. Failures are
`CloudProviderError`, with a sentence a person can act on; the code
`CLOUD_ACCESS_REFUSED` means the provider refused this account.

To add or replace a provider: implement `CloudProvider` in
`provider/<name>/`, and return it from `getCloudProvider`.

## Access

`getCloudProvider(deps)` returns ADE Cloud for this account, or null when the
account has no access. It needs a signed-in ADE account.

Until ADE's server holds the provider credential, it reads the workspace key
already in the account vault (scope `all`, kind `integration`, item `agent37`).
Nothing in ADE writes that item any more. Cloud 2 replaces this body of
`getCloudProvider` with a provider that calls ADE's server. A development brain
runs with sync off and has no vault, so it takes the key from `ADE_CLOUD_DEV_KEY`.

## Where each piece lives

| Area | File (under `services/adeCloud/`) |
|---|---|
| Machine list and box actions | `cloudMachines.ts` |
| Making a machine, its sign-in, joining the account | `cloudMachineCreator.ts`, `cloudApprovalWindow.ts`, `cloudHeadlessApproval.ts` |
| Half-made machines after a quit | `cloudPendingCreates.ts` |
| Copy and move | `cloudMachineCopy.ts` |
| Reconnect a machine removed from ADE | `cloudReconnect.ts` |
| Sleep, wake for use, the monthly cap | `cloudSleep.ts`, `cloudMoneyWatch.ts`, `cloudBrainAccess.ts` |
| Ready machines | `cloudReadyMachines.ts`, `cloudReadyClaim.ts`, `cloudReadySettings.ts`, `cloudReadyActions.ts` |
| Sign-ins new machines start with | `cloudSignInStore.ts`, `cloudSignInActions.ts`, `cloudSignInBoot.ts`, `cloudClaudeSignIn.ts` |
| CLI and agent verbs, approvals | `cloudAgentActions.ts`, `cloudBrainMaker.ts`, `cloudDesktopActions.ts` |
| Desktop IPC | `registerCloudIpc.ts` |

Shared contracts are in `apps/desktop/src/shared/adeCloud.ts`, `cloudReady.ts`
and `cloudSignIns.ts`. On a machine, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`
keeps it awake while it works.

## Surfaces

- **Settings:** Integrations › ADE Cloud (`CloudSection.tsx`), ending in
  "Powered by Agent 37". Settings entries are `integrations.ade-cloud*`.
- **Add a computer and the chat picker:** New ADE Cloud machine, and
  `Ready` for a project that keeps one.
- **CLI:** `ade cloud` (`ade help cloud`), and `ade chat create --machine cloud:ready`.
- **Agents:** the `ade-cloud` skill.
- **Phone:** the cloud page, over the `cloud.read` and `cloud.write` sync commands.
- **Bring your own provider:** `BringYourOwnCloudCard.tsx` is layout only and
  shows only when `BRING_YOUR_OWN_CLOUD_ENABLED` is on. Nothing is wired to it.

## Stored data

Account vault items, scope `all`, kind `integration`: `cloud-budget` (cap and
agent limits), `cloud-ready` (which projects keep a machine ready),
`cloud-claude-token` and `cloud-key-<provider>` (sign-ins for new machines).
Machine metadata keys are `ade_*` (`ade_machine_key`, `ade_request_id`,
`ade_sleep`, `ade_made_by_chat`, and the ready-machine keys in `cloudReady.ts`).

## The machine template

`infra/ade-cloud/` holds the image every machine starts from. It sets
`ADE_HOST_INSTANCE_ID=cloud:<hostname>` and `ADE_CLOUD_INSTANCE_ID`, the only
variables the rest of ADE reads to know it runs on a cloud machine. ADE does
not build the template from the app: `infra/ade-cloud/build-template.sh` does,
and a development desktop can use a trial template with `ADE_CLOUD_TEMPLATE`.
A new machine installs the ADE version of the app that made it on first boot.

## Timed wakes

A sleeping machine can't run its own timers, so before sleeping it sends its
next time to the account directory (`/cloud/wake`, table `cloud_wakes`, see
`apps/account-directory/README.md`), and a cron requests its public address.

## Rules for changes

- A new call to the provider goes through `CloudProvider`, never around it.
- User-facing text, CLI output and skills say ADE Cloud. "Powered by Agent 37"
  on the settings page is the only product mention.
- What spends money or deletes a machine asks the person first (`cloudAgentActions.ts`).
