# Unified machines: every desktop tab across all machines

Status: in progress (2026-09-27). Scope: desktop app only. Web client and TUI are out of scope.

## Goal

The project tab no longer has a machine picker. A signed-in user opens a
project and every tab shows that project's work on **every** machine, the
way the Work tab already does. No extra steps.

## The model (already true in Work; now true everywhere)

- **A lane owns its machine.** `lanes.worktree_path` is a path on exactly one
  machine. Chats, sessions, PR mappings, file reads and git calls inherit their
  machine through `laneId`. Nothing else stores a machine.
- **Machines are named absolutely**: `THIS_MACHINE_NAME`, or the machine name
  ("Mac Studio"). The word "remote" is never shown as a machine name
  (`shared/machineIdentity`).
- **Offline machines are dimmed, not hidden.** Their rows stay visible, their
  actions are disabled, and the message says "<Machine> is offline".
- **Every call names its target.** A lane action goes to the lane's machine.
  A create action asks for the machine. Project-level singletons (CTO) go to
  their home machine.
- **The tab's bound machine becomes an internal default**, not a user choice.
  It is still what an unpinned call hits (local checkout when present). `pin === null`
  keeps meaning "the tab's binding", so the common local path stays unchanged.

## Existing building blocks (reuse, don't duplicate)

- `renderer/state/crossMachineLanes.ts`: the union. `crossMachineLanesByMachineId`
  holds each other machine's `lanes`, `sessions`, `prs`, `binding`, `online`.
  `useCrossMachineLaneUnion`, `useLanesForPin`, `machineEntryForBinding`.
- `renderer/lib/chatMachineRouting.ts` + `components/terminals/useWorkMachineRouter.ts`:
  laneId → owning binding → `pin` (null when it's the tab's binding).
- `renderer/components/chat/ChatRuntimeScope.tsx`: per-subtree "which machine" context.
- `renderer/components/lanes/laneMachines.ts` + `LaneMachineSelector.tsx`: machine
  options and the picker for lane creation.
- Preload: `callPinnedOrBoundRuntimeActionOr(pin, domain, action, args, fallback)`.
  379 preload methods already accept `pin?: OpenProjectBinding | null`. Adding a pin to
  any other runtime-action call is mechanical.
- Files already supports a machine pin (`components/files/v2/pinnedFilesApi.ts`).

## Per-tab decisions (locked with the user 2026-09-27)

| Tab | Behavior |
|---|---|
| Work | Already unified. No change. |
| Lanes | One **flat list** of all lanes across machines, sorted by activity. Each lane has a machine chip. Machine filter chips across the top. Lane detail and every lane action route to the lane's machine. |
| Files | The lane/workspace picker lists all lanes on all machines with chips. Picking a lane on another machine pins Files to it automatically; no separate machine switcher. |
| PRs | The list stays GitHub-sourced. PR↔lane mapping merges every machine's `prs`. "Open lane" goes to the owning machine. Create lane from PR **always asks** which machine. |
| Automations | Rules from every machine in one list, each with a machine chip. Edit/toggle/delete/run route to the rule's machine. Creating a rule **always asks** which machine it runs on. |
| History | One timeline merged by time across machines, each item with a machine chip. Paged per machine; one slow machine never blocks the list. |
| CTO | One CTO per project on a **home machine**, chosen once (first-run chooser; default suggestion = this machine if it has the repo). All CTO calls pin to the home machine. The header shows "Runs on <Machine> · Change". The CTO can already hand work to lanes on any machine. |
| Settings | Three scopes: **Account** (applies everywhere), **Project** (shared across machines), **Machines** (one section per machine: paths, installed tools, disk, runtime). Machine sections read/write via that machine's pin. |
| Create lane (anywhere) | **Always asks** for the machine. No silent default; the dialog can't submit until a machine is chosen. |
| Project tab | The machine picker/menu on the tab is removed. The tab represents the repo. The "Connect another machine…" entry moves to Connections. |

## Cost and performance rules

- Other machines have no renderer change feed; the union refresh is shared and
  ref-counted. New tabs **must subscribe to the existing union**, not open their
  own polling loops.
- Reads to other machines are timed out, cancellable, and never gate the local list.
- History and automations: fetch lazily when their tab is visible, and page.

## Out of scope

Web client, TUI, iOS. Multi-CTO reconciliation. Per-project themes.
