# C6, C7, C8, C10: the server launcher and direct cloud routes (spec)

Plan of record: `~/.claude/plans/account-owned-projects/plan-final.md` decision 11 ("A user with a
computer launches from it, as today. A server launcher exists for callers with no computer: web,
phone, automations.") Facts: `verify-open-facts.md` sections 2, 3, 4.

## C6: the server launcher

A caller with no computer (web, phone, an automation on ADE Cloud) starts a cloud lane through
ADE's server. The desktop and the brain keep their own launcher (`cloudLaneLaunchService.ts`).

### The flow

The new computer drives its own launch. The server never runs a long step: it makes the computer,
keeps the launch's facts, checks a one-time join code, mints the sign-in link and records progress.

1. **Start.** `POST /cloud/launches` (account token). Body: `CloudServerLaunchRequest`:
   `launchId` (UUID, idempotent: the same id answers the same launch), `kind: "chat" | "lane"`,
   `sizeId`, `project: { origin }` (a GitHub origin, `github.com/owner/repo`), `lane: { id, name,
   from?, existingBranch? }`, and for a chat `chat: { provider, modelId, effort?, permissions,
   fast?, prompt, attachments?: [{ fileId, name, contentType, sizeBytes }] }`. The same checks as
   any create (hours, computers, disk, agent limits for an automation caller, `cloudLaneStartBlock`)
   answer before anything is made. A missing git credential for a private repository is refused
   here too (C4, `accountGitCredential`, server side: the vault item it reads).
2. **Files first.** `PUT /cloud/launches/:launchId/files/:fileId` (account token, raw body, at most
   25 MB each, 10 per launch) stores an attachment in R2 `CLOUD_CHATS` under
   `launches/<userId>/<launchId>/<fileId>`. Deleted with the launch record.
3. **Make.** The server creates the computer as `POST /cloud/instances` does (same limits, billing,
   metadata: the lane facts, `ade_launch_id`, made-by), with env `ADE_LAUNCH_ID=<launchId>` and
   `ADE_LAUNCH_JOIN=<nonce>`: a random one-time join code. The server keeps only its SHA-256, with
   the instance id, the user and an expiry (30 minutes). Record state `making` → `joining`.
4. **Join with no browser page.** At boot the computer's brain (or the entrypoint) sees
   `ADE_LAUNCH_ID` and no account session. It starts ADE's device sign-in (`startDeviceLogin`, with
   the G1 retry), then calls `POST /cloud/launches/:launchId/join` with `{ nonce, userCode }` and
   no account token. The server checks: the nonce hash matches, unused, not expired, the instance
   that asks is the launch's (`x-ade-instance` plus the provider's own record), then marks it used
   and answers the one-time sign-in link for the launch's user (the same link `/device/approve`
   mints today, `deviceAppApproval.ts`). The computer opens it in its own headless Chromium (the
   template ships one; `cloudHeadlessApproval.ts` logic, moved to `apps/ade-cli` so a brain can
   run it). When Clerk stops on a page a person must confirm, the computer posts
   `needs_approval` with the link, and the caller shows one "Approve the new computer" button
   (one tap, the person's own browser). Never a password, never a provider sign-in.
5. **Launch facts.** Once signed in, the computer reads `GET /cloud/launches/:launchId` (its own
   account token; same user) and runs the launch locally with the same launch id and lane id:
   clone (its own git credential), fetch, checkout, environment, then the agent with the stored
   first message, model, settings and files (fetched from R2). It reuses the brain's launch
   pipeline (`chat.startLaunch` with the facts), so a lane started this way is the same as one a
   desktop handed off.
6. **Progress.** The computer posts stage changes to `PUT /cloud/launches/:launchId/stages`
   (a few writes per launch). The caller reads `GET /cloud/launches/:launchId` while it watches
   (bounded: only during a launch). After `agent` starts, the caller connects to the computer as
   any account machine (account hello through the relay; web and phone already can) and drives
   the chat.
7. **End.** The record keeps 7 days, then the cron deletes it and its files. A cancel
   (`DELETE /cloud/launches/:launchId`) before the agent starts deletes the computer.

### Rules

- Machine-agnostic: the env names, stage names and the headless approval are data the provider
  layer and the template supply. A new OS or provider changes the template, not the flow.
- A user with a computer still launches from it: the desktop and the brain keep their launcher.
  An automation on ADE Cloud (C9) and web/phone use this one.
- Security: the join code is single use, 30 minutes, bound to one instance and one user; only its
  hash is stored. The host (the provider) can read env, as it can read the computer's disk; the
  code gives nothing a host doesn't already have, and nothing after first use. No long-lived
  credential in env or exec arguments.
- Cost: no polling from machines. The computer posts a handful of stage updates; the caller reads
  while it watches; the cron only expires records.
- Migration: one table `cloud_launches` (number 0028, or the next free number when lane L's
  account-projects table merges first). Few new keys in `account_settings`: none.

## C7: cloud routes straight from a browser and a phone

- CORS on `/cloud/*` for `WEB_CLIENT_ORIGIN` (`GET, POST, PUT, DELETE`, headers `authorization,
  content-type`), the same rule the account routes use (`directory.ts` ~1349). Native clients
  send no Origin and pass. Check that a web OAuth token (with `aud`) and an iPhone native session
  token (no `aud`) both pass the `/cloud` auth.
- The routes a client needs: list (`GET /cloud/account`, `GET /cloud/instances`), start
  (`POST /cloud/launches`, C6), wake (`POST /cloud/instances/:id/start`), size
  (`POST /cloud/instances/:id/resize`, server wakes first since G1), delete
  (`DELETE /cloud/instances/:id`).
- A typed TypeScript client in `apps/desktop/src/shared/cloudApiClient.ts` (fetch only, no
  Electron, no Node), that the web client and the CLI can import. Lane L wires the web and the
  iPhone screens (L25–L29); this lane delivers the routes, the client and the route list for the
  Swift side.

## C8: provider sign-ins on a cloud computer from a phone or the web

- `POST /cloud/instances/:id/sign-ins` `{ provider }` (account token): the server wakes the
  computer if needed and runs `ade providers sign-in <provider> --remote --json` there through the
  provider's exec (short: it starts the provider's own flow in the background and answers within
  ~10 s). Answer: `{ jobId, url, userCode?, needsPastedCode }`.
- `POST /cloud/instances/:id/sign-ins/:jobId/code` `{ code }` writes a pasted code (the G3
  `writeLoginCode` rule: code, then Enter, separately), `GET .../:jobId` answers
  `pending | done | failed (+ the provider's own reason)`.
- Providers that can't move: a shared table, one row per provider, `remoteSignIn:
  "device" | "url_paste" | "none"` and the reason for `none` (for example a sign-in that only
  calls back to a browser on the same computer). The phone and web show "Sign in on one of your
  computers; it reaches ADE Cloud" for `none`. Claude on ADE Cloud stays the Claude pass.
- Renewal owner when no owner computer exists: a sign-in made on a cloud computer has that
  computer as its origin; `providerLoginTakeover.ts` already lets a cloud computer renew when the
  origin is off. A sign-in whose origin is gone moves its renewal to the cloud computer that holds
  it.
- The person always signs in themselves; ADE never signs a provider in for them.

## C10: delete the cloud computers of one project

- `POST /cloud/projects/computers/delete` `{ origin, dryRun? }`: every computer of this user whose
  lane facts name that origin. `dryRun` lists them (name, size, awake, unpushed work if known).
  Without it: for each, wake with `reason: "push_work"` when asleep, push each lane's work
  (the same command `cloud.push_all_work` runs), then delete (`who: "project_delete"`). Bounded:
  the route starts a job and answers `{ jobId }`; `GET /cloud/projects/computers/delete/:jobId`
  answers each computer's state. A computer whose push failed is not deleted: its state says why,
  and the caller offers "Delete anyway".
- Lane L's Delete project window calls it (plan-final decision 5).

## Edge cases (from the ledgers)

Zero machines; a launch whose caller closes the page (the computer goes on alone; the record shows
it later); the computer can't reach the directory at boot (G1 retry); the join link expires
before the computer opens it (the computer asks again; the code is still unused); two joins with
one code (second refused); a deleted computer mid-launch; out of hours mid-launch; a private repo
with no git credential (refused at start); attachments too big (refused at upload); the web
client's token expires during a launch (the record is the user's; reading again after sign-in
works); an automation launch with nobody watching (C9).
