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
  When off, computers stop at 0 hours; running turns finish first and save
  their chats, which can still be read.
- **Free plan:** any size, 50 free hours a month.
- **Computers:** free 3, paid 10.
- **Payments:** Stripe Managed Payments (Stripe is the legal seller and handles
  tax). Monthly plans only for now. Anyone in the world can buy.
- **One computer for each cloud lane.** It sleeps when idle (Agent 37 does
  this) and ADE deletes it when the lane is archived.
- **Waiting computers are dropped from the product.** Cloud 3 starts each lane
  on a fresh computer. Their code stays behind the access flag until Cloud 3
  removes it.
- **Small disks** that grow when they fill up.
- **Secrets and sign-ins carry over** from the user's ADE with no new page.
- **A user's own cloud provider** is a layout-only card behind an off flag.

## Still open (owner)

1. "Move to ADE Cloud" for an existing lane: first release or later?
2. Preview links: private only, or also shareable?

Decided in Cloud 2: a free plan of 50 hours a month with no card (not a free
trial); after a cancel, the plan runs to the end of the billing period, then free
rules; any computer not awake for 30 days is deleted after 7-day and 1-day
warnings with "Push all work to GitHub", and its lane stays.

## Outside ADE (owner)

- Send the founder message: a higher limit of awake computers, how long until
  cold storage, webhooks, a grace period for a failed charge.
- Apply to OpenAI's "Sign in with ChatGPT" program (Codex plans on ADE Cloud).

## Build order

| Lane | What it does | Done when | Needs |
|---|---|---|---|
| **Cloud 0 · Finish open work** | The P3e lane merges #2109 (CLI on cloud machines) and #2110 (web app on cloud machines, plus following a moved chat). | Both merged, or closed with a reason. | Done |
| **Cloud 1 · ADE Cloud as the primitive** | Done. Every provider call goes through `CloudProvider`, and Agent 37 is one folder (`services/adeCloud/provider/agent37/`). No aliases: the CLI is `ade cloud`, the skill `ade-cloud`, the sync commands `cloud.read` / `cloud.write`. The user's own key, the wallet and the in-app template build are gone; a layout-only card sits behind `BRING_YOUR_OWN_CLOUD_ENABLED`, off. | No user-facing text says Agent 37 except "Powered by Agent 37". Only `cloudAccess.ts` imports the provider in production code. | Cloud 0 |
| **Cloud 2 · Account and billing** | ADE's server holds ADE's Agent 37 key. Each computer belongs to one ADE user, and the server checks this on every call. Hour metering, the $5 plan, extra hours, free hours, Stripe Managed Payments, the 80% and 95% banners, and what happens at 0 hours. Also (owner, 2026-11-08): review what ADE pays Cloudflare today (Pages, the Workers, D1, R2, Durable Objects, KV, queues and cron) against the current Cloudflare pricing, find extra or excess costs, and cut them without losing a feature. | A test user pays, uses hours, gets the banners, and is stopped at 0. A second user cannot reach the first user's computers. A Cloudflare cost table (each product: what ADE uses, what it costs, what was cut) is in the PR, with before and after numbers. | Cloud 1 |
| **Cloud 3 · Lanes on ADE Cloud** | The "Run on: This computer / ADE Cloud" choice when making a lane. One fresh computer for each lane, delete on archive, small disks, the newest code when a lane starts, and the setup card for each case (ready, being made, in cold storage, first lane, out of hours). Removes the ready-machine code left behind the flag. | A new cloud lane starts fast on a fresh computer, works with the laptop closed, and its computer is gone after archive. | Cloud 1 |
| **Cloud 4 · Providers and sign-ins** | A large lane. (1) Rethink the provider list: which providers ADE offers, how each is grouped and shown, and how they appear on ADE Cloud. (2) Custom ACP providers, GitHub issue #2083 (Linear ADE-188): a user registers their own ACP command (label, command and args, env) as a chat provider with a generic dialect, so it is a normal Work chat that `ade chat` can control. The owner told the issue author (adrianc-prenetics) on 2026-11-06 that a PR is welcome; check for one before building. (3) Sign-ins for ADE Cloud: first a table, one row for each provider, each row with proof from code or a real test: how its sign-in reaches a second computer and how long it lasts. Then build it: copy fixed sign-ins, lend renewing ones from the user's computer (`borrowedLogins.ts` already does this for the subscription proxy), and Claude's server token where the computer may be off. Discuss the plan with the owner in the lane before building. | The new provider list is agreed with the owner and shipped. A custom ACP agent runs as a Work chat on this computer and on ADE Cloud. Every provider that can work does work on a new cloud lane with no new sign-in; each one that cannot says why, with proof. | Cloud 1. The real sign-in tests need the owner's own sign-in. |
| **Cloud 5 · ADE Cloud settings tab** | One tab: account, plan and billing, hours, cloud lanes and their computers, sign-ins, "Powered by Agent 37". It replaces the ADE Cloud integration card. The same tab in the web app. | The tab shows real data on desktop and web. | Cloud 2, Cloud 3 |
| **Cloud 6 · Agent guidance** | The agent skill tells agents the plan, the hours left, how fast each size uses hours, and offers "ADE can give you a bigger computer for about N hours". It never says Agent 37. | An agent on a cloud lane answers cost questions correctly and offers a bigger computer. | Cloud 2 |
| **Cloud 7 · Web and phone** | Make, open and drive cloud lanes from the web app and the phone with the laptop closed. | Tested on the web and on a real phone. | Cloud 3, Cloud 4 |

Cloud 2, Cloud 3 and Cloud 4 can run at the same time after Cloud 1.

## Where each lane starts (after Cloud 1)

- **Cloud 2:** `getCloudProvider` (`cloudAccess.ts`) now calls ADE's server (`cloudServerProvider.ts`); the vault read and the dev key are gone, and hours come from `GET /cloud/account`. Every release builds the `ade` template (`.github/workflows/cloud-template.yml`, `infra/ade-cloud/build-template.sh`), and `infra/ade-cloud/promote-template.mjs` tests a build and moves the version the server creates from. Rebuild it once right after the Cloud 1 release, because the entrypoint changed.
- **Cloud 3:** remove `cloudReadyMachines.ts`, `cloudReadyClaim.ts` and the picker in `useCloudReadyDraftMachine.ts`; each lane starts on a fresh computer.
- **Cloud 4:** for sign-ins, `cloudSignInStore.ts`, `cloudSignInBoot.ts`, and the `machineEnv` hook in `cloudMachineCreator.ts`.
- **Cloud 5:** `CloudSection.tsx` and `window.ade.cloud`; the web app reaches the same actions through `cloud.read` / `cloud.write`.
- **Cloud 6:** the `ade-cloud` skill and `shared/adeCloud.ts` (sizes, prices).
- **Cloud 7:** `cloud.read` / `cloud.write` and `webCloudMachines.ts`.

Development: `ADE_ACCOUNT_DIRECTORY_URL` points a dev build at a local server (`wrangler dev` in `apps/account-directory`).

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
- The owner removes the offline rows "hw fc81" and "hw b5cb" from the account (test machines already deleted; an agent can't remove account rows).

## Known issues from P3e (2026-11-08, after #2109 and #2110 merged)

- **A signed-in cloud machine vanished.** "p3f move b" (`xqcl1x3358`) was made at 07:48 UTC and left both the provider's list and the ADE account about 20 minutes later. Nothing that P3e ran deleted it. Cause not found; carried to Cloud 2, whose server sees every provider call and can record who deleted what. Checked in Cloud 1: ADE's automatic clean-ups do not fit, because the pending-create sweep acts only on boxes that never signed in and leaves the account row, and the ready-machine clean-up acts only on boxes with ready-machine metadata, which this one did not have. The other paths that delete a box and its row are a person's or agent's Delete, a finished move's old box, and a failed move's new box, and each needs someone to start it. This Mac's brain log records no cloud action from 07:30 to 08:20 UTC. The provider now answers 404 for that instance and has no event history to read, and its usage shows only about 5 minutes of compute billed. Not checked: logs on other computers.
- **Live move banner in the web** stays on "Sending" until the chat is reopened, so the web never follows a move by itself. The move finishes and "Open on" works. Traced as far as the sync host's event delivery. Cloud 7.
- **A move to a hidden project:** the web cannot find a destination project that was never listed. Cloud 7.
- **The phone** was not tested on a device. Cloud 7.
