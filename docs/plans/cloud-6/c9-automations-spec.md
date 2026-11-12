# C9: automations that run on ADE Cloud (spec)

Today (`docs/features/automations/README.md`, "Run on ADE Cloud"): a rule can run its lane on ADE
Cloud, but its home is one of the person's computers, which watches the trigger. A closed laptop
fires nothing. C9 makes **ADE Cloud a home of its own**: ADE's server watches the trigger and starts
each run through the C6 server launcher.

## The model

- **Home.** `automations.home.<id>` gets a new kind: `{ kind: "cloud", chosenAt }`. Every brain
  reads it as "not here" (`runsHere` false), so no computer fires the rule: one owner per rule. The
  existing handover wait (`AUTOMATION_HOME_HANDOVER_MS`) applies when the home moves to or from
  ADE Cloud, so the old home has stopped before the server starts. An older brain that doesn't know
  the kind treats it as another computer's home (it already does for unknown device ids): verify.
- **Registration.** The brain that saves a cloud home (the editor's **Runs on: ADE Cloud**, or
  `ade automations run-on <id> --cloud`) registers the rule with the server:
  `PUT /cloud/automations/:ruleId` with a compiled run spec (repository origin, trigger, the C6
  launch template: kind, size, prompt, model, effort, permissions, lane mode and name, and the
  rule's limits). Any brain that syncs and sees a cloud home whose server copy is older than the
  rule re-registers it (one write per rule change, never a poll). Leaving the cloud home, disabling
  or deleting the rule: `DELETE` or `enabled: false`.
- **What can't run on the server** (a plain reason under **Runs on**, the same shape as
  `localReason`/`homeGaps`): a bound chat, a step that works in a lane on one computer, a secret
  that lives on one computer (secrets never move), file-change triggers, a CLI-session run until the
  CLI-sessions lane's start step exists.

## Triggers the server watches

- **Schedules.** The rule carries a time zone (`timezone`, IANA; default the zone of the computer
  that made it). The server stores the next fire time in UTC; the existing minute cron picks due
  rules (one indexed query a minute) and starts each run. Missed runs (the server was down, the
  account was out of hours): one catch-up run when the miss is under an hour old, else skipped and
  recorded.
- **Custom webhooks.** For a cloud-homed rule, the hook is registered with the webhook relay with a
  forward target: on each delivery the relay calls `POST /cloud/automations/:ruleId/deliveries` on
  the account directory over HTTPS, signed with a per-hook HMAC secret made at registration (stored
  hashed on the directory side). No service binding, no new Cloudflare secret. The relay keeps the
  delivery until the directory answers 2xx (its 3-day hold covers a directory outage). Signing
  secrets of the person's webhook (the sender's) are checked as today and never leave the relay.
- **GitHub events** (relay App deliveries): the same forward, keyed by repository, when it fits the
  relay's per-repo event store without a new binding; otherwise refuse the cloud home for `github.*`
  triggers with a reason, for now.
- **Linear**: refused on the cloud home for now, with a reason.

## Each run

- A run is a C6 server launch: launch id = run id, caller `automation`, the agent limits answer
  (largest size, new computers a day, unattended spend), never the person.
- **One run at a time per rule**: a trigger while a run is active is queued once (at most one
  waiting) and the rest are recorded as skipped. **A storm stop**: at most N runs an hour per rule
  (default 6, the rule's own limit wins), past that the rule pauses and the person is told.
- **Plan limits**: by default a run's computer is freed when the run ends and its work is pushed
  (the lane stays, as "a lane without a computer"), so a Free account's three computers don't fill
  up. A rule can keep it.
- **Out of hours or blocked**: the run fails before anything is made, the run row says why, and the
  person is told (an Activity item through `ACTIVITY_RELAY`, the binding the directory already has,
  and the same email path as a cancelled timed wake).
- **Sign-ins**: a provider sign-in that is missing or expires mid-run fails the run with the
  provider's reason and a notification; never a prompt on the cloud computer.
- **Results**: run history rows on the server (`cloud_automation_runs`: rule, trigger, launch id,
  lane id, state, reason, times), read by every computer's Automations tab and the phone for a
  cloud-homed rule. The run's lane and chat are a cloud lane like any other; its PR shows as usual.

## Cost

One indexed D1 query a minute (the cron that already runs), one write per run, one forward per
webhook delivery. Nothing polls from machines.

## Storage

Tables `cloud_automations` and `cloud_automation_runs` (the next free migration number after C6's
`cloud_launches`). No new keys in `account_settings`.

## Hidden ADE Cloud

"Runs on: ADE Cloud" stays hidden for accounts without access, and the server refuses the routes.
