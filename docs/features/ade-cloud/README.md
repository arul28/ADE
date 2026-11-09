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
        machines, sleep, create, copy, move, ready machines, hours, sign-ins
                                    |            (apps/desktop/src/main/services/adeCloud/)
                       CloudProvider (cloudProvider.ts)
                                    |
                 getCloudProvider (cloudAccess.ts)   <- the one place that picks the provider
                                    |
                 cloudServerProvider.ts   <- calls ADE's server (`/cloud/*` on the account directory)
                                    |
                 apps/account-directory/src/cloud/   <- the only code that knows the provider's API
```

A lint rule (`apps/desktop/eslint.config.mjs`) stops main-process code other
than `cloudAccess.ts` and tests from importing the server provider. Above the
seam, nothing knows who runs the computers.

## The provider seam

`CloudProvider` (`cloudProvider.ts`) is the contract: list, get, create, delete,
sleep, start, stop, update, resize, back up, auto-sleep, public port, fork,
signed URL, name, metadata, usage, whether the server can make a computer now,
and exec, plus the account's access, plan and billing calls. Failures are
`CloudProviderError`, with the server's one plain sentence; the code
`CLOUD_ACCESS_REFUSED` means the account was refused. The server's shapes are in
`apps/account-directory/src/cloud/contract.ts`.

## Access

`getCloudProvider(deps)` returns ADE Cloud for this account, or null. It needs a
signed-in ADE account. The bearer is the account token; no provider key exists
on any desktop or brain. `/cloud/access` is read at most every 10 minutes per
account (a cached yes survives a failed check). The `signedOut`, `no_access` and
`unreadable` states keep their sentences (`requireCloudProvider`,
`readCloudStatus`).

A development build reaches a local server through the account directory's own
override: set `ADE_ACCOUNT_DIRECTORY_URL` (for example to
`http://127.0.0.1:8787`), the same mechanism every other account call uses.

## Source file map

| Area | File (under `services/adeCloud/`) |
|---|---|
| Machine list and box actions | `cloudMachines.ts` |
| Making a machine, its sign-in, joining the account | `cloudMachineCreator.ts`, `cloudApprovalWindow.ts`, `cloudHeadlessApproval.ts` |
| Half-made machines after a quit | `cloudPendingCreates.ts` |
| Copy and move | `cloudMachineCopy.ts` |
| Reconnect a machine removed from ADE | `cloudReconnect.ts` |
| Sleep, wake for use, agent limits | `cloudSleep.ts`, `cloudSleepWatch.ts`, `cloudBrainAccess.ts` |
| Ready machines | `cloudReadyMachines.ts`, `cloudReadyClaim.ts`, `cloudReadySettings.ts`, `cloudReadyActions.ts` |
| Sign-ins new machines start with | `cloudSignInStore.ts`, `cloudSignInActions.ts`, `cloudSignInBoot.ts`, `cloudClaudeSignIn.ts` |
| CLI and agent verbs, approvals | `cloudAgentActions.ts`, `cloudBrainMaker.ts`, `cloudDesktopActions.ts` |
| Desktop IPC | `registerCloudIpc.ts` |

Shared contracts are in `apps/desktop/src/shared/adeCloud.ts`, `cloudReady.ts`
and `cloudSignIns.ts`. On a machine, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`
keeps it awake while it works.

## Surfaces

- **Settings:** Integrations › ADE Cloud (`CloudSection.tsx`), with Plan and
  hours (`CloudPlanCard.tsx`: hours left, reset date, extra hours for paid
  accounts, buy and manage, which open Stripe's pages in the browser), the
  80% / 95% / out-of-hours banners, and computers due for deletion, ending in
  "Powered by Agent 37". Settings entries are `integrations.ade-cloud*`.
- **Add a computer and the chat picker:** New ADE Cloud computer (a size and a
  "Full computer (Android, Docker)" switch), and `Ready` for a project that
  keeps one.
- **CLI:** `ade cloud` (`ade help cloud`), and `ade chat create --machine cloud:ready`.
- **Agents:** the `ade-cloud` skill.
- **Phone:** the cloud page, over the `cloud.read` and `cloud.write` sync commands.
- **Bring your own provider:** `BringYourOwnCloudCard.tsx` is layout only and
  shows only when `BRING_YOUR_OWN_CLOUD_ENABLED` is on. Nothing is wired to it.

## Hours and sizes

Hours are Small-computer hours: free 50 a month, paid 500. Hours, plan, disk and
billing come from `GET /cloud/account` (`CloudAccountState`), read only while
ADE Cloud is visible (`useCloudMachines`). At 0 hours the server refuses, and
that sentence is what the person sees. The eight sizes are Small, Medium, Large
and X-Large, standard or full computer (`CLOUD_SHAPES`, `CLOUD_HOURS_RATE` in
`shared/adeCloud.ts`, matching the server's `plans.ts`). The server picks the
disk and the image; a client never sends either.

## Stored data

Account vault items, scope `all`, kind `integration`: `cloud-budget` (agent
limits only; the name is historical), `cloud-ready` (which projects keep a machine ready),
`cloud-claude-token` and `cloud-key-<provider>` (sign-ins for new machines).
Machine metadata keys are `ade_*` (`ade_machine_key`, `ade_request_id`,
`ade_sleep`, `ade_made_by_chat`, and the ready-machine keys in `cloudReady.ts`), plus `created_by: ade`.

## The machine template

`infra/ade-cloud/` holds the image every machine starts from. It sets
`ADE_HOST_INSTANCE_ID=cloud:<hostname>` and `ADE_CLOUD_INSTANCE_ID`, the only
variables the rest of ADE reads to know it runs on a cloud machine. ADE does
not build the template from the app: every release builds it
(`.github/workflows/cloud-template.yml`), and a tested build is moved to with
`infra/ade-cloud/promote-template.mjs`. The server creates from one pinned
version; the client doesn't choose. "Update this computer" moves one computer
to it (`updateInstance`).
On first boot a new machine installs the ADE version of the app that made it,
when the image's ADE is older.

## Timed wakes

A sleeping machine can't run its own timers, so before sleeping it sends its
next time to the account directory (`/cloud/wake`, table `cloud_wakes`, see
`apps/account-directory/README.md`), and a cron requests its public address.

## Rules for changes

- A new call to the provider goes through `CloudProvider`, never around it.
- User-facing text, CLI output and skills say ADE Cloud. "Powered by Agent 37"
  on the settings page is the only product mention.
- What spends hours or deletes a computer asks the person first (`cloudAgentActions.ts`), in hours.
