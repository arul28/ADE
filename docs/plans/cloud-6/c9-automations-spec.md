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
  `PUT /cloud/automations/:ruleId` (the rule's account id plus a hash of its repository, so two
  repositories' rules of one id are two rows) with a compiled run spec (repository origin, trigger, the C6
  launch template: kind, size, prompt, model, effort, permissions, lane mode and name, and the
  rule's limits). Any brain that syncs and sees a cloud home whose server copy is older than the
  rule re-registers it (one write per rule change, never a poll). Leaving the cloud home, disabling
  or deleting the rule: `DELETE` or `enabled: false`.
- **What can't run on the server** (a plain reason under **Runs on**, the same shape as
  `localReason`/`homeGaps`): a bound chat, a step that works in a lane on one computer, a secret
  that lives on one computer (secrets never move), file-change triggers, a CLI-session run until the
  CLI-sessions lane's start step exists, a run limit (`oneShot`, `maxRuns`: the server doesn't count
  runs), and a trigger's active hours.

## Triggers the server watches

- **Schedules.** The rule carries a time zone (`timezone`, IANA; default the zone of the computer
  that made it). The server stores the next fire time in UTC; the existing minute cron picks due
  rules (one indexed query a minute) and starts each run. Missed runs (the server was down, the
  account was out of hours): one catch-up run when the miss is under an hour old, else skipped and
  recorded.
- **Custom webhooks.** For a cloud-homed rule, the hook is registered with the webhook relay with a
  forward target: on each delivery the relay calls `POST /cloud/automations/:ruleId/deliveries/:userId` on
  the account directory, signed with a per-hook HMAC key. The directory derives that key from its
  own `CLOUD_CHAT_MASTER_KEY` and a random salt (its D1 holds only the salt; the relay keeps the
  derived key to sign with), so there is no new Cloudflare secret. The relay reaches the directory
  over a service binding (a Worker can't fetch another workers.dev Worker of the same account,
  error 1042), one per directory, picked by the forward URL's origin. The relay keeps the delivery
  until the directory answers 2xx (its 3-day hold covers a directory outage); a delivery the
  directory will never take (too large, unreadable, a key it no longer derives) is dropped with a
  log line so the ones behind it go on. A hook id is unique per account on the server, not across
  accounts: the signature says which account's rule a delivery is for. Deliveries during the
  12-minute handover from a computer wait in the rule's queue until it ends. Signing secrets of
  the person's webhook (the sender's) are checked as today and never leave the relay. A prompt
  may use `{{trigger.type}}`, `{{trigger.method}}`, `{{trigger.body}}` and its fields,
  `{{date}}` and `{{time}}` (in the rule's zone), each meaning what it means on a computer; a
  rule whose prompt uses any other variable is refused the cloud home.
- **GitHub events** (relay App deliveries): the same forward, keyed by repository, when it fits the
  relay's per-repo event store without a new binding; otherwise refuse the cloud home for `github.*`
  triggers with a reason, for now.
- **Linear**: refused on the cloud home for now, with a reason.

## Each run

- A run is a C6 server launch: launch id = run id, caller `automation`, the agent limits answer
  (largest size, new computers a day, unattended spend), never the person. The server reads the
  limits from the vault at each registration (every brain start and every rule change), and a
  brain sends its cloud rules again when the limits change; limits it never could read refuse
  unattended spend.
- A run's chat that stops to ask for input ends the run as failed ("The agent asked for input"):
  nobody watches it, and it must not hold its computer.
- **One run at a time per rule**: a trigger while a run is active is queued once (at most one
  waiting) and the rest are recorded as skipped. **A storm stop**: at most N runs an hour per rule
  (default 6, the rule's own limit wins), past that the rule pauses and the person is told. Only
  a save (a newer version) turns it back on; a brain restarting doesn't.
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
