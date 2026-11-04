# Keyboard

ADE is driven with modifier chords: one **⌘**-chord per action, with a mnemonic
second key, so the keys are easy to remember and never collide with typing. The
registry that declares them is `shared/keybindings.ts`, rebindable in
Settings › Keyboard (`settings/keyboard/ShortcutsCard.tsx`, which writes the
`keybindings` store), and each surface adds only the ids it handles.

Work is the first surface wired this way (`components/work/workShortcuts.ts`).
Other pages keep their existing scoped bindings until they get their own set.

## The Work page's chords

| Keys | Does |
|---|---|
| `⌘↑` / `⌘↓` | previous / next chat in the visible list, wrapping at the ends |
| `⌘I` | jump into the prompt box — press it again to leave |
| `⌘⇧A` | the chat's actions and progress drawer |
| `⌘⇧N` | new chat |
| `⌘T` | open or close the tools pane |
| `Esc` | back out (close the tools pane) |
| `?` | the shortcut sheet — press it again to close |
| `⌘K` | the command palette, from anywhere |
| `⌘B` | show or hide the sidebar, from anywhere |
| `⌘1`–`⌘5` | the main tabs, from anywhere |
| `⌃⇥` / `⇧⌃⇥` | next / previous project tab, from anywhere (with a single project, opens the picker) |
| `⌘⇧E` / `⌘⇧D` | thinking level up / down in the prompt box you last worked in |
| `⌘⇧F` | fast mode on or off in that prompt box |
| `⌘⇧→` / `⌘⇧←` (Ctrl+PageDown / Ctrl+PageUp on Windows and Linux) | next / previous shell in the terminal tool, wrapping, while the caret is in it and two or more shells are open; with one shell the keys stay the shell's. Off macOS Ctrl+Shift+←/→ is word selection in PowerShell and many line editors, so the desktop uses the usual tab chord there (`NON_MAC_KEYBINDING_DEFAULTS` in `shared/keybindings.ts`); the hosted client keeps the arrows because browsers own Ctrl+PageUp/PageDown |

Mnemonic rules: `I` is "insert" (the prompt box), `A` is the chat's actions,
`N` is a new chat, `T` is the tools pane, `B` is the sidebar, `↑`/`↓` move
through the list. `⇧` marks the variant of a letter that is already taken by
the platform (`⌘N` stays New Window; `⌘A` stays select-all in a field).

## Rules every surface follows

- **A chord is never typing.** These fire while a text field has focus, which is
  what makes them fast. The one exception is caret movement: `⌘↑`/`⌘↓` belong to
  a text field or a terminal's input, so they are skipped there and work
  everywhere else.
- **A modal, menu or listbox answers its own keys.** A chord that a dialog needs
  is left alone; `preventDefault` beats a shortcut.
- **Repeat only moves.** Held `⌘↑`/`⌘↓` walk the list; `⌘T`, `⌘I`, `⌘⇧A` and
  `⌘⇧N` fire once per press.
- **Every switch switches.** `⌘T` opens and closes the tools pane, `⌘I` enters
  and leaves the prompt box, and `?` opens and closes the sheet — the same key
  both ways, never a one-way door. `Esc` is the same "back out" for the pane
  when focus is elsewhere.
- **A shortcut that opens a surface moves focus with it.** `⌘T` puts the
  keyboard inside the pane it opened; `⌘I` puts the caret in the prompt box,
  and takes it back out again.
- **Discoverability is the command palette.** Its rows carry their chord, and
  the same ids drive Settings' keybinding store, so there is one description of
  an action rather than a second list to keep current.

## Rebinding (Settings › Keyboard)

The editor lists every id in `shared/keybindings.ts` (the web table on the
hosted client) under the scope it is listened for. Its rules live in
`shared/keybindingEditor.ts` so the page, the Quick slots page and a test ask
the same questions:

- **Recording reads the physical key** for letters and digits (`event.code`),
  so a shortcut recorded on one layout is the same key on another; punctuation
  keeps the character the layout types. IME composition and key repeat are
  ignored; Esc cancels without closing Settings.
- **Conflicts compare resolved chords**, not strings: `Ctrl+K` and `Mod+K` are
  one chord on Windows and Linux and two on macOS. Two shortcuts conflict only
  when a key press can reach both (global reaches all; prompt box and terminal
  share Work's keys; each page's own scope is alone). On a clash the editor
  offers to move the chord, unassigning it from the other action.
- **Refused outright:** a chord the OS takes first, one ADE's native menu or
  the browser (hosted client) takes first, copy/paste/undo, AltGr chords on
  Windows (`Ctrl+Alt`+character), the Windows or Super key, a bare key on a
  shortcut that works while you type, and a Quick slot chord (leader + digit),
  because Quick slots read their keys first. A shipped default on a menu chord
  (the Lanes filter's `⌘F`, delivered through the menu's Find claim) is not
  flagged.
- **Unassign** stores `KEYBINDING_UNASSIGNED` (`"none"`), which
  `getEffectiveBinding` reads as no keys. Setting a chord back to its default
  drops the override, so a later change of default still reaches the user.
- **Where it saves:** this computer (`lib/keybindingStore.ts`,
  `localStorage` key `ade.keybindings.v1`), beside Appearance and Quick slots.
  Shortcuts belong to the keyboard and OS in front of you, so every project and
  every window on the computer reads one set, a project opened from another
  machine still uses this computer's keys, and a save reaches the shell, every
  open project and other ADE windows (the `storage` event) at once. The hosted
  client keeps them in the browser. The brain's older per-project store
  (`keybindingsService`) is read once, the first time a computer has nothing
  saved, so overrides set there through `ade actions` carry over.
