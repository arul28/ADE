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

## Tracks running now

- Me: C2, C3, then G2 on top.
- Agent `g1-agents` (Opus 5.5, high): B14-19, B14-16, B14-17.
- Agent `g1-lifecycle` (Opus 5.5, high): B14-11/12, B14-20/27, B14-25, the "running is not ready" wait.

## Design rules (owner)

- Machine-agnostic: a new OS or provider is data in the provider layer.
- Every new call carries the pin of its machine; no preload method defaults to the tab machine.
- No new repeated server calls from each machine; ADE's own polling and exec must not keep a cloud computer awake.
- One clean state for each thing, plain words, no raw ids, no duplicated errors.
