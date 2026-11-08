# ADE Cloud roadmap

Written 2026-11-08. This replaces the phase names P1 to P3e. How ADE Cloud is
built today is in `docs/features/ade-cloud/README.md`.

## The idea in one sentence

ADE Cloud is an ADE feature: the user pays ADE, picks **ADE Cloud** when they
make a lane, and works. Agent 37 is only the company whose computers ADE Cloud
runs on. The words "Agent 37" appear once, as "Powered by Agent 37" on the ADE
Cloud settings tab.

## Lane names

Every lane for this work has the name `Cloud N · <plain name>` and the branch
`ade/cloud-N-<plain-name>`. One lane for each item below. A lane can open more
than one PR; it gets all of them into main with the dev loop.

## Decided

- **Price:** $5 a month for 500 hours of a Small computer. Bigger computers use
  hours faster. Plan hours reset each month.
- **Extra hours:** off by default. When on, extra hours cost 1¢ each (0.85¢
  after 1,000 in a month), charged after use, each time the extra reaches $5.
  When off, computers sleep at 0 hours; running turns finish first; chats are
  kept and can still be read.
- **Free plan:** any size, free hours only.
- **No limit** on the number of computers.
- **Payments:** Stripe Managed Payments (Stripe is the legal seller and handles
  tax). Monthly plans only for now. Anyone in the world can buy.
- **One computer for each cloud lane.** It sleeps when idle (Agent 37 does
  this) and ADE deletes it when the lane is archived.
- **One waiting computer for each project**, asleep, with the repo cloned and
  the packages installed, so a new lane starts in seconds.
- **Small disks** that grow when they fill up.
- **Secrets and sign-ins carry over** from the user's ADE with no new page.
- **A user's own cloud provider** is a layout-only card behind an off flag.

## Still open (owner)

1. A free try of 50 hours after the user adds a card, or paid from the first hour?
2. "Move to ADE Cloud" for an existing lane: first release or later?
3. Preview links: private only, or also shareable?
4. After a user cancels: keep cloud lanes 30 days with "Push all work to
   GitHub", then delete?

## Outside ADE (owner)

- Send the founder message: a higher limit of awake computers, how long until
  cold storage, webhooks, a grace period for a failed charge.
- Apply to OpenAI's "Sign in with ChatGPT" program (Codex plans on ADE Cloud).

## Build order

| Lane | What it does | Done when | Needs |
|---|---|---|---|
| **Cloud 0 · Finish open work** | The P3e lane merges #2109 (CLI on cloud machines) and #2110 (web app on cloud machines, plus following a moved chat). | Both merged, or closed with a reason. | Done |
| **Cloud 1 · ADE Cloud as the primitive** | Done. Every provider call goes through `CloudProvider`, and Agent 37 is one folder (`services/adeCloud/provider/agent37/`). No aliases: the CLI is `ade cloud`, the skill `ade-cloud`, the sync commands `cloud.read` / `cloud.write`. The user's own key, the wallet and the in-app template build are gone; a layout-only card sits behind `BRING_YOUR_OWN_CLOUD_ENABLED`, off. | No user-facing text says Agent 37 except "Powered by Agent 37". Only `cloudAccess.ts` imports the provider in production code. | Cloud 0 |
| **Cloud 2 · Account and billing** | ADE's server holds ADE's Agent 37 key. Each computer belongs to one ADE user, and the server checks this on every call. Hour metering, the $5 plan, extra hours, free hours, Stripe Managed Payments, the 80% and 95% banners, and what happens at 0 hours. | A test user pays, uses hours, gets the banners, and is stopped at 0. A second user cannot reach the first user's computers. | Cloud 1 |
| **Cloud 3 · Lanes on ADE Cloud** | The "Run on: This computer / ADE Cloud" choice when making a lane. One computer for each lane, the waiting computer for each project, delete on archive, small disks, the newest code when a lane starts, and the setup card for each case (ready, being made, in cold storage, first lane, out of hours). | A new cloud lane starts in seconds from a waiting computer, works with the laptop closed, and its computer is gone after archive. | Cloud 1 |
| **Cloud 4 · Sign-ins carry over** | First a table, one row for each of the 13 providers, each row with proof from code or a real test: how its sign-in reaches a second computer and how long it lasts. Then build it: copy fixed sign-ins, lend renewing ones from the user's computer (`borrowedLogins.ts` already does this for the subscription proxy), and Claude's server token where the computer may be off. | Every provider that can work does work on a new cloud lane with no new sign-in. Each one that cannot says why, with proof. | Cloud 1. The real tests need the owner's own sign-in. |
| **Cloud 5 · ADE Cloud settings tab** | One tab: account, plan and billing, hours, cloud lanes and their computers, sign-ins, "Powered by Agent 37". It replaces the ADE Cloud integration card. The same tab in the web app. | The tab shows real data on desktop and web. | Cloud 2, Cloud 3 |
| **Cloud 6 · Agent guidance** | The agent skill tells agents the plan, the hours left, what each size costs, and offers "ADE can give you a bigger computer for about N hours". It never says Agent 37. | An agent on a cloud lane answers cost questions correctly and offers a bigger computer. | Cloud 2 |
| **Cloud 7 · Web and phone** | Make, open and drive cloud lanes from the web app and the phone with the laptop closed. | Tested on the web and on a real phone. | Cloud 3, Cloud 4 |

Cloud 2, Cloud 3 and Cloud 4 can run at the same time after Cloud 1.

## Where each lane starts (after Cloud 1)

- **Cloud 2:** replace the body of `getCloudProvider` (`cloudAccess.ts`) with a provider that calls ADE's server, and delete the vault read and `ADE_CLOUD_DEV_KEY`. Hours and limits start at the cap check in `cloudSleep.ts` / `cloudMachines.ts`. Build the `ade` template in the release (`infra/ade-cloud/build-template.sh`): the app no longer builds it. Rebuild it once right after the Cloud 1 release, because the entrypoint changed.
- **Cloud 3:** `cloudReadyMachines.ts` and `cloudReadyClaim.ts` (claim has no fetch of the newest code yet), the picker in `useCloudReadyDraftMachine.ts`.
- **Cloud 4:** `cloudSignInStore.ts`, `cloudSignInBoot.ts`, and the `machineEnv` hook in `cloudMachineCreator.ts`.
- **Cloud 5:** `CloudSection.tsx` and `window.ade.cloud`; the web app reaches the same actions through `cloud.read` / `cloud.write`.
- **Cloud 6:** the `ade-cloud` skill and `shared/adeCloud.ts` (sizes, prices).
- **Cloud 7:** `cloud.read` / `cloud.write` and `webCloudMachines.ts`.

Development: `ADE_CLOUD_DEV_KEY` gives a dev brain the provider (it has no account vault), and `ADE_CLOUD_TEMPLATE` picks a trial template.

## Later

- Move a lane to ADE Cloud and back.
- Shareable preview links.
- Teams and shared billing.
- Smart cleanup notices for unused cloud lanes.
- Region choice for VMs (US, France, India).

## Clean-up

- Five old lanes named "worktree agent …" hold old Agent 37 branches from
  earlier subagents (`.claude/worktrees/`). Check each for unmerged work, then
  remove them.
