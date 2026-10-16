# Keyboard

ADE is driven with modifier chords: one **⌘**-chord per action, with a mnemonic
second key, so the keys are easy to remember and never collide with typing. The
registry that declares them is `shared/keybindings.ts` (rebindable through the
existing `keybindings` store), and each surface adds only the ids it handles.

Work is the first surface wired this way (`components/work/workShortcuts.ts`).
Other pages keep their existing scoped bindings until they get their own set.

## The Work page's chords

| Keys | Does |
|---|---|
| `⌘↑` / `⌘↓` | previous / next chat in the visible list |
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
