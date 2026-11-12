# Cloud 6 — lane plan (C1–C10)

Scope: `cloud-6-work-ledger.md` (final split at the top) and `cloud-beta12-test-ledger.md` in this folder.
Plan of record: `~/.claude/plans/account-owned-projects/plan-final.md`.

## Delivery

One bundled PR to main, #2201 (branch `ade/cloud-6-fixes-launcher-and-contracts`), the owner's call on
2026-11-12. It replaced the seven stacked PRs #2187–#2192 and #2199. Migrations are `0029_cloud_launches`
and `0030_cloud_automations`, after lane L's `0028_account_projects`.

## Contracts other lanes use (as built)

- **C2.**
  - `window.ade.machines.connect(machineKey, { connect? })` returns a `MachineConnectResult`: an address
    for one machine, or `not_in_account`, `unreachable`, `signed_out` or `invalid`.
  - `window.ade.machines.addressFor(machineKey)`.
  - Renderer helpers: `connectMachine` and `projectPinOnMachine` (`renderer/lib/machineConnect.ts`).
- **C3.**
  - `window.ade.cloud.laneComputer(laneId)`, `window.ade.cloud.followLane(laneId, { connect? })` and
    `window.ade.cloud.onLaneMoved`, with types in `shared/laneComputer.ts`.
  - Pins to a lane's old computer reach the new one (`machines/goneTargets.ts`), and saved-chat stand-in
    pins (`cloud-saved:<key>`) do too.
- **C4.**
  - `window.ade.cloud.gitPreflight({ originUrl })`. No renderer calls it yet; the launch start checks.
  - The server launcher refuses `git_credential_missing`.
  - A clone keeps no token in `.git/config`. A cloud computer removes the header older clones saved,
    once per boot.
  - `CloneProjectResult.githubSignInMissing` and `RemoteRuntimeProjectRecord.githubSignInMissing` are set
    when another computer's one-shot header made the clone.
- **Launch snapshot.** It now carries `ChatLaunchCloudState.warning` and
  `ChatLaunchArgs` / `ChatLaunchSnapshot.setupStartedAt`.
- **C10.** `POST /cloud/projects/computers/delete` needs the preview's `instanceIds` and answers
  `{ jobId, accepted, skipped, truncated }`.
- **C9.** The relay forwards to `POST /cloud/automations/:ruleId/deliveries/:userId`, HMAC-signed.
  `:ruleId` is the rule's account id plus `.r<hash of the repository>` (`automationRuleCloudId`).
- **Machine pickers.** `routableMachines` leaves out saved-chat stand-ins.

## C2 — connect to any machine of the account by machine key

Input: the machine key only. Reads no tab or window machine, changes none, adds no default route.
The caller gets one `MachineAddress` and passes it with each call.

- Types: `apps/desktop/src/shared/machineAddress.ts`
  - `MachineAddress` (`{ kind: "this", machineKey }` | `{ kind: "remote", machineKey, targetId, name }`)
  - `MachineConnectResult`, `MachineConnectFailureReason` (`not_in_account` | `unreachable` | `signed_out` | `invalid`),
    `MachineConnectOptions` (`connect: false` pairs without waking), `MachineConnectError`, `sameMachineKey`
  - `projectPinOn(address, project)` → the `OpenProjectBinding` pin for one project on that machine (null for `this`)
- Main: `apps/desktop/src/main/services/machines/machineConnector.ts` — `createMachineConnector(deps)` →
  `{ connect(machineKey, options?), addressFor(machineKey) }`, `MachineWakeResult`. One flight per machine key; never
  throws. A saved connection is reused; a machine this computer never saved is checked against the account, woken
  first when asleep and the caller wants a connection, and paired through the account.
- IPC / preload: `window.ade.machines.connect(machineKey, options?)`, `window.ade.machines.addressFor(machineKey)`.
- Renderer: `apps/desktop/src/renderer/lib/machineConnect.ts` — `connectMachine(machineKey)`, `projectPinOnMachine(...)`.
- Pins that outlive a connection: `main/services/machines/goneTargets.ts`. Only connections a move or a delete
  removed are remembered (a person's own Remove is not); only a person's write wakes; a lane move pairs without waking.

## C3 — a lane follows its computer

Same lane id and chat id, new machine key, after a move or a new computer.

- Types: `apps/desktop/src/shared/laneComputer.ts` — `LaneComputer`, `LaneMovedEvent`, `LaneFollowResult`,
  `LaneComputerSource`, `laneComputersOf(machines)`, `laneComputerMoves(previous, next, at)`.
- Main: `apps/desktop/src/main/services/adeCloud/cloudLaneFollow.ts` — `createLaneFollower(deps)` →
  `{ note(instances), laneComputer(laneId), follow(laneId, { connect? }) }`; fed by every cloud list read.
- IPC / preload: `window.ade.cloud.laneComputer(laneId)`, `window.ade.cloud.followLane(laneId, { connect? })`,
  `window.ade.cloud.onLaneMoved(cb)`.
- Renderer: `renderer/components/cloudLane/useFollowLaneMoves.ts` (an open chat follows its lane).
- Pins that outlive a connection: `main/services/machines/goneTargets.ts` (C2 + C3, see Progress).

## Progress (2026-11-12)

Branch commits are grouped per item; the layer branches are cut from them at the end.

- **C2, C3: done, validated live** (own test computer, dev app on this branch). Proof: `6217434d` (before),
  `1f1ae7b1` (B14-31 fixed), the move proof (B14-35). Extras that came out of the live test:
  - `machines/goneTargets.ts`: a pin to a removed connection (or a saved chat's stand-in pin
    `cloud-saved:<key>`) reaches its machine by key; only a person's write wakes; a lane move pairs without waking, the
    same rule as `remoteConnectionService.callAction`; reads use the saved copy.
  - `cloudSavedChatsSync.ts`: "deleted" only when the account says so; a moved lane's saved chats
    are listed under the new computer.
  - C2 wakes a sleeping cloud computer before a pairing (a pairing is a live hello).
- **G1: merged from two agents, typecheck clean; not yet live on a cloud computer** (the cloud image
  runs the released beta). Live checks to run with a branch brain or a trial template: join retry,
  disk guard and early grow, resize while asleep, no agent downloads on wake, "Getting Codex ready".
- **G2:** B14-31 and B14-35 done (above). B14-32 (one "deleted computer" place) is with `g4-jobs`.
- Specs written: `c6-c8-launcher-spec.md` (C6, C7, C8, C10), `c9-automations-spec.md` (C9).

Seen live on this branch, for G4: two "This turn stopped" rows per failed turn, an error drawn above
the next message, effort jumping to Medium, `--lane-name` ignored (lane named from the prompt),
"Lane set up in 11s" for an ~85 s setup, the composer showing "This computer" during setup.

Test computer: my own "Cloud Test Reply" (Large after the move, `ccgojg7vw5`). Delete it when the
lane's live checks are done. `slow-drive-test` is not this lane's; never touched.

## Tracks running now

- `g3-signins` (Opus 5.5, high): G3, C4, C5.
- `g4-thread` (Opus 5.5, high): B14-26, B14-13/34, B14-33, B14-15, beta.12 #13.
- `g4-jobs` (Opus 5.5, high): B14-24, B14-18, B14-29, B14-30, B14-37, B14-38, B14-32.
- `c6-launcher` (Opus 5.5, high): C6, C7, C8, C10 per the spec.
- Next: C9 (after `c6-launcher`, same server files), G5 (after `g4-jobs`, same dashboard files).

## Design rules (owner)

- Machine-agnostic: a new OS or provider is data in the provider layer.
- Every new call carries the pin of its machine; no preload method defaults to the tab machine.
- No new repeated server calls from each machine; ADE's own polling and exec must not keep a cloud computer awake.
- One clean state for each thing, plain words, no raw ids, no duplicated errors.

## Owner decisions (2026-11-12)

- Yes: one trial template on Agent 37 (`ade-c6-test`, never the live `ade`).
- G5: build from the owner's beta.14 notes, review with screenshots (no mockup round).
- Yes: rename the Stripe SANDBOX products and prices for checkout (sandbox only; live money stays out of scope).
