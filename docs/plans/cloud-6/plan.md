# Cloud 6 — lane plan (C1–C10)

Scope: `cloud-6-work-ledger.md` (final split at the top) and `cloud-beta12-test-ledger.md` in this folder.
Plan of record: `~/.claude/plans/account-owned-projects/plan-final.md`.

## Stack (bottom up)

| Layer | Branch | Contents |
|---|---|---|
| 1 | `ade/cloud-6-fixes-launcher-and-contracts` | C2 + C3 contracts, G1 (lifecycle blockers) |
| 2 | `ade/cloud-6-connections` | G2 (B14-31, B14-35, B14-32, one lane id / chat id) on top of C2/C3 |
| 3 | `ade/cloud-6-sign-ins` | C4 (git credential check, no token in `.git/config`), G3, C5 (sync down, one card per account) |
| 4 | `ade/cloud-6-launcher` | C6 (server launcher), C7 (browser/phone routes), C8 (sign-in from phone/web) |
| 5 | `ade/cloud-6-automations` | C9 (Runs on: ADE Cloud), C10 (delete a project's cloud computers) |
| 6 | `ade/cloud-6-chat-ux` | G4 |
| 7 | `ade/cloud-6-dashboard` | G5 |

No PR merges until the whole stack is complete; then the owner runs the deep review.

## C2 — connect to any machine of the account by machine key

Input: the machine key only. Reads no tab or window machine, changes none, adds no default route.
The caller gets one `MachineAddress` and passes it with each call.

- Types: `apps/desktop/src/shared/machineAddress.ts`
  - `MachineAddress` (`{ kind: "this", machineKey }` | `{ kind: "remote", machineKey, targetId, name }`)
  - `MachineConnectFailure` (`reason`: `not_in_account` | `gone` | `unreachable` | `signed_out`) and `MachineConnectError`
  - `projectPinOn(address, project)` → the `OpenProjectBinding` pin for one project on that machine (null for `this`)
- Main: `apps/desktop/src/main/services/machines/machineConnector.ts` — `createMachineConnector(deps)` →
  `{ connect(machineKey, options?), addressFor(machineKey) }`. One flight per machine key. A saved
  connection is reused; a machine this computer never saved is paired through the account first.
- IPC / preload: `window.ade.machines.connect(machineKey)`, `window.ade.machines.addressFor(machineKey)`.
- Renderer: `apps/desktop/src/renderer/lib/machineConnect.ts` — `connectMachine(machineKey)`, `projectPinOnMachine(...)`.

## C3 — a lane follows its computer

Same lane id and chat id, new machine key, after a move or a new computer.

- Types: `apps/desktop/src/shared/laneComputer.ts` — `LaneComputer`, `LaneMovedEvent`, `laneComputerChanges(prev, next)`.
- Main: `apps/desktop/src/main/services/adeCloud/cloudLaneFollow.ts` — `createLaneFollower(deps)` →
  `{ laneComputer(laneId), note(machines), onMoved(listener) }`.
- IPC / preload: `window.ade.cloud.laneComputer(laneId)`, `window.ade.cloud.onLaneMoved(cb)`.
- Renderer: `useLaneComputer(laneId)` and the chat pane re-pin.

## Progress (2026-11-12)

Branch commits are grouped per item; the layer branches are cut from them at the end.

- **C2, C3: done, validated live** (own test computer, dev app on this branch). Proof: `6217434d` (before),
  `1f1ae7b1` (B14-31 fixed), the move proof (B14-35). Extras that came out of the live test:
  - `machines/goneTargets.ts`: a pin to a removed connection (or a saved chat's stand-in pin
    `cloud-saved:<key>`) reaches its machine by key; only a person's write re-pairs and wakes, the
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
