# Quick slots

Nine user-assigned actions, run with one leader chord and a digit. The point is
to stop reaching for the model picker, the tools strip, or the lane's PR button
with a pointer while the caret is already in the composer.

- **macOS:** hold `Option+Command`, tap `1`–`9`. `Control+Option` is the
  alternate leader (Option+Command+8 belongs to macOS Zoom).
- **Windows:** hold `Ctrl+Shift`, tap `1`–`9`. `Ctrl+Alt` is deliberately not a
  leader: it is AltGr on most layouts and would type characters.
- The leader is in-app only. Quick slots are not global hotkeys and need no
  Accessibility permission.

The panel appears after a 70 ms hold, so a fast tap never flashes it. It never
takes focus: the caret stays in the composer, which is what makes the model
profile rule work.

## The caret rule

A **model profile** slot has two meanings, chosen by where the caret was when
the chord was pressed:

| Caret was | Pressing the slot |
|---|---|
| In the composer | Inserts an `@model:` chip naming the profile's model and thinking level. The agent reads it as an instruction for work it starts. |
| Anywhere else | Sets this chat's model and thinking level. The composer applies it on the next message. |

Every other slot has one meaning. `chat.insertPrompt` writes text at the caret;
`tool.*` switches the Work tools pane; `lane.*` acts on the selected lane.

The toast says which one happened, and a model change offers **Undo**. A
harness change is called out in the toast: the chat's runtime is rebound, so the
existing thread's runtime context ends.

## What a slot holds

- A stable command id and, when needed, its arguments (`profileId`, prompt text).
- The command title at assignment time, used only when the id no longer exists,
  so a removed command reads "Action unavailable — pick another" instead of
  becoming a dead key.

Slots live in `ade.quickSlots.v1` (localStorage) through
`renderer/quickSlots/quickSlotsStore.ts`, not in the project database. They are
an app-wide preference like the theme. The hosted web client reads the same key
from its own browser storage; cross-device sync is a follow-up.

## The catalogue

`renderer/quickSlots/commands.ts` is the renderer half of the command registry:
the HUD and Settings read the same ids. (The ⌘K palette does not list these yet;
that is the next discoverability step.) Each command declares:

- `needs`: `none`, `chat`, or `lane`. The HUD disables a command with no target
  and says why; it never falls back to "the first lane" or "the last chat".
- `safety`: `instant`, `confirm` (the HUD arms on the first press and runs on
  the second), or `surface` (opens the place where the action is configured).
- `kind`: `run`, `set`, `go`, or `write`, printed under the label.

The shipped groups are Chat, Model, Lane, Tools and Navigate. Lane actions are
deliberately conservative:

- Chord-safe: open the lane's PR, copy the branch, push (armed), open the
  worktree.
- Surface-only: create a PR, rebase, create a lane. Rebase always asks for a
  scope and a push review; create PR needs a base branch and a dirty-tree
  decision.
- Archive and reclaim are not in the catalogue. They stop live chats, PTYs,
  watchers and simulators, and belong in the lane's own confirm flow.

Lane slots follow the **chat's** lane, not the sidebar's selection. A chat
whose lane lives on another machine keeps its lane id, which is not in this
tab's lane list; those slots are then disabled with "This chat's lane is on
another machine" rather than acting on a same-named lane here. With no composer
in view they fall back to the selected lane.

Work tools are pane tabs, not routes. A chord calls the same store write the
picker uses (`workSidebarTool` + `workSidebarOpenTools`), reveals the pane, and
never steals focus. Capability availability (iOS, App Control, Mac Desktop,
Windows Desktop) is still decided by the pane's `workToolAvailability`, which
knows the lane's host; the HUD does not guess from the viewer's OS.

A profile stores a model id and a thinking level, not a harness preset. A model
that is reachable only through a Custom provider must still be picked from the
composer's own picker; capturing a preset into a profile is a follow-up.

## Model action edge cases

`AgentChatComposer` publishes itself through `useQuickSlotComposerTarget`
while its pane is the active tile. Every function reads the live props through a
ref, so a slot never acts on a stale model. Work pages and other project tabs
stay mounted (parked) while another page shows, so several composers can be
registered at once: `getQuickSlotComposer()` returns the newest one that is on
screen and not inside a parked surface, and a slot or prompt-box shortcut
pressed with none on screen says "Open a chat first" instead of changing,
stopping or pushing a chat the user cannot see.

A quick tap (no panel) that a slot refuses shows the reason as a toast, so a
refused chord is never a dead key. Slots, profiles and the leader follow a save
made in another ADE window on this computer (`storage` event), as shortcuts do.

- **Draft:** model, thinking and fast mode are composer state only; nothing
  reaches the runtime before the first send.
- **Running chat:** the model change is deferred to the next send by the
  pane (`deferredComposerSessionIdRef`). Thinking and fast are local until then.
- **Mid-turn:** model and thinking are locked. The slot refuses and says "wait
  for this turn to end" instead of writing a value the next sync would overwrite.
- **Catalog not loaded / model not offered here:** the pane's
  `handleComposerModelChange` returns `false`, the target reports it, and the
  toast names the consequence. It does not claim success.
- **No thinking tiers:** "This model has no thinking levels". The slot does not
  write a value the model cannot use.
- **Cycle thinking** walks the model's own tiers, starts from the *displayed*
  value, and clamps at the top; it never wraps and never treats `ultrathink`
  (draft text, not a tier) as a level.
- **Cycle permission** walks the provider's own list and clamps. Claude's plan
  mode is an interaction mode, so leaving plan returns to Manual. Codex and
  Cursor cycle through the modes their composer control exposes. A dangerous
  rung (`Bypass`, `Full auto`, `allowAll`) gets a warning tone; the control is
  always available to undo it.
- **Fast mode** is refused when the model advertises no fast tier; Cursor Cloud
  uses a service tier, so it is not offered there.
- **Harness change:** the pane rebinds the runtime and records `modelHandoff`.
  The toast says the thread's runtime context ends; there is no silent switch.

## Settings

Settings › **Keyboard** › **Quick slots** (anchor `quick-slots`) shows the 3×3 grid, the
leader choice, "Keep the panel open" (sticky mode for anyone who cannot hold two
modifiers), the model-profile caret behavior, and Reset.
Settings › **Keyboard** › **Model profiles** (anchor `model-profiles`) lists saved
profiles and can add one by model id. The faster path is the
`model.saveProfile` command: set a chat's model and thinking level, then run
"Save this chat's model as a profile" from ⌘K or a slot.

The action picker shares the catalogue and searches titles, hints and keywords.
A prompt slot asks for its text when it is assigned.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/quickSlots.ts` | Slot/profile types, defaults, normalisation, leader and digit grammar, profile→mention token. Pure; no React. |
| `apps/desktop/src/renderer/quickSlots/commands.ts` | The renderer command catalogue, target checks, safety classes, and the model-profile runner. |
| `apps/desktop/src/renderer/quickSlots/composerTarget.ts` | Registry of active composers; answers with the newest one on screen and not parked, plus the functions a slot may call. |
| `apps/desktop/src/renderer/quickSlots/useQuickSlotComposerTarget.ts` | The hook a composer calls to publish itself; the permission cycles follow the pickers' own option lists. |
| `apps/desktop/src/renderer/quickSlots/QuickSlotsHost.tsx` | The chord dispatcher, target resolution, and the HUD. Mounted once in `AppShell`. |
| `apps/desktop/src/renderer/quickSlots/quickSlotsStore.ts` | The nine slots and profiles, persisted to `ade.quickSlots.v1`. |
| `apps/desktop/src/renderer/quickSlots/quickSlots.css` | HUD and settings styling, including reduced-motion behavior. |
| `apps/desktop/src/renderer/components/settings/keyboard/QuickSlotsCards.tsx` | The Settings surface: grid, action picker, profiles, leader, sticky mode. |
| `apps/desktop/src/renderer/components/settings/keyboard/KeyboardPage.tsx` | Settings › Keyboard, the This-computer page that hosts the cards. |
| `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` | Calls `useQuickSlotComposerTarget` while the pane is active, handing it the model, thinking, permission, fast, picker and stop state. |
| `apps/desktop/src/renderer/components/app/AppShell.tsx` | Hosts `QuickSlotsHost` once for the whole window. |
| `apps/desktop/src/renderer/components/ui/zLayers.ts` | The `quickSlots` layer (130): above sheets, below dialogs. |

## Scope

- **Desktop:** full.
- **Hosted web:** the same renderer and catalogue; desktop-only commands are
  hidden by their `enabled` checks. A browser may claim a modified digit before
  the page sees it, so the chord is best-effort; the panel is also reachable
  from Settings.
- **TUI:** no chords. `/quick-slots` (list) and `/quick-slots <n>` can be added
  against the same ids; the TUI has no default keybindings today.
- **iOS:** no hardware-keyboard chord. A read-only "Quick slots" menu item is
  the parity surface if it is added.

Not in v1: global hotkeys, arbitrary macros, slot assignment on web/TUI/iOS,
per-slot custom chords, cross-device slot sync.
