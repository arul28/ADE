# Quick slots

Nine user-assigned actions, run with a leader chord and a digit, so the caret
can stay in the composer.

- **macOS:** hold `Option+Command`, tap `1`–`9`. `Control+Option` is the
  alternate leader (Option+Command+8 is macOS Zoom).
- **Windows:** hold `Ctrl+Shift`, tap `1`–`9`. `Ctrl+Alt` is not offered: it is
  AltGr on most layouts.
- In-app only: not global hotkeys, no Accessibility permission.

The panel opens after a 70 ms hold (a fast tap never flashes it) and never takes
focus.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/quickSlots.ts` | Slot/profile types, defaults, normalisation, leader and digit grammar, command ids, profile → mention token. Pure. |
| `apps/desktop/src/renderer/quickSlots/commands.ts` | Command catalogue (`needs`, `safety`, `kind`), target checks, model-profile runner. |
| `apps/desktop/src/renderer/quickSlots/composerTarget.ts` | Registry of mounted composers; `getQuickSlotComposer()` returns the newest one on screen and not parked. |
| `apps/desktop/src/renderer/quickSlots/useQuickSlotComposerTarget.ts` | Hook a composer calls to publish itself; permission cycles follow the pickers' option lists. |
| `apps/desktop/src/renderer/quickSlots/QuickSlotsHost.tsx` | Chord dispatcher, target resolution, HUD. Mounted once in `AppShell`. |
| `apps/desktop/src/renderer/quickSlots/quickSlotsStore.ts` | Slots and profiles, persisted to `ade.quickSlots.v1` (localStorage). |
| `apps/desktop/src/renderer/quickSlots/useQuickSlotsAccountSync.ts` | Syncs with the account value `quickSlots.v1` (scope `all`). |
| `apps/desktop/src/renderer/components/settings/keyboard/QuickSlotsCards.tsx` | Settings › Keyboard › Quick slots and Model profiles. |
| `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` | Calls `useQuickSlotComposerTarget` while its pane is the active tile. |
| `apps/desktop/src/renderer/components/ui/zLayers.ts` | `quickSlots` layer (130): above sheets, below dialogs. |

## Behavior

- **Target composer.** Parked Work pages and project tabs stay mounted, so
  several composers can be registered. The newest visible one wins. With none on
  screen, a chat slot says "Open a chat first". The target reads live props
  through a ref, so a slot never acts on a stale model.
- **Refusals are visible.** A quick tap that a slot refuses shows the reason as
  a toast.
- **Model slots by chat state:**
  - Draft: model, thinking and fast are composer state until the first send.
  - Running chat: the model change is deferred to the next send
    (`deferredComposerSessionIdRef` in `AgentChatPane.tsx`).
  - Mid-turn: model and thinking are locked; the slot refuses.
  - Model not offered / catalog not loaded: `handleComposerModelChange` returns
    `false` and the toast says so.
  - Harness change: the pane rebinds the runtime and records `modelHandoff`;
    the toast says the thread's runtime context ends. A model change offers
    **Undo**.
- **Cycle thinking** walks the model's tiers from the displayed value and clamps
  at the top (no wrap; `ultrathink` is draft text, not a tier).
- **Cycle permission** walks the provider's list and clamps. Leaving Claude's
  plan mode returns to Manual. Dangerous rungs (`Bypass`, `Full auto`,
  `allowAll`) get a warning tone.
- **Fast mode** is refused when the model has no fast tier (and on Cursor Cloud,
  which uses a service tier).

### The caret rule

A **model profile** slot (model id + thinking level, not a harness preset):

| Caret was | Pressing the slot |
|---|---|
| In the composer | Inserts an `@model:` chip; the agent reads it as an instruction for work it starts. |
| Anywhere else | Sets this chat's model and thinking level for the next message. |

Other slots have one meaning: `chat.insertPrompt` writes at the caret, `tool.*`
switches the Work tools pane, `lane.*` acts on a lane.

### Catalogue rules

- `needs` is `none`, `chat` or `lane`. A command with no target is disabled with
  a reason; it never falls back to "the first lane".
- `safety` is `instant`, `confirm` (arm on first press, run on second) or
  `surface` (opens where the action is configured).
- Lane actions are conservative: open PR, copy branch, push (armed), open
  worktree are chord-safe; create PR, rebase, create lane only open their
  surface; archive and reclaim are not in the catalogue.
- Lane slots follow the **chat's** lane. A lane on another machine is not in
  this tab's lane list, so those slots are disabled ("This chat's lane is on
  another machine"). With no composer in view they use the selected lane.
- Tool slots call the same store write as the picker (`workSidebarTool` +
  `workSidebarOpenTools`); availability still comes from the pane's
  `workToolAvailability`, which knows the lane's host.
- A slot keeps the command title from assignment time, so a removed command
  reads "Action unavailable — pick another".
- The ⌘K palette does not list quick-slot commands.

## Storage

App-wide preference, not a project setting. This computer's copy is
`ade.quickSlots.v1`; the account holds `quickSlots.v1`, and the newer copy wins.
Reads follow the account store's change event and window focus (no timer).
Another DAEX window on this computer is followed through the `storage` event.

## Settings

Settings › **Keyboard** › **Quick slots** (anchor `quick-slots`): 3×3 grid,
leader, "Keep the panel open" (sticky mode), caret behavior, Reset.
**Model profiles** (anchor `model-profiles`): saved profiles, add by model id,
or run "Save this chat's model as a profile" (`model.saveProfile`) from a slot.

## Scope

- Desktop: full.
- Hosted web: same renderer; desktop-only commands hidden by `enabled` checks.
  Browsers may claim modified digits first, so the chord is best-effort.
- TUI and iOS: no chords.
