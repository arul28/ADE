## History

Commits and lane operations for this project. The same History ADE already
ships, drawn as vocabulary panels every client can show.

This plugin replaces ADE's compiled History tab. Install it and the rail tab,
the ⌘K row and `ade history activity` reach it. Disable it and the compiled
History page comes back unchanged. `ade history list`, `show`,
`commits` and `export` stay on the compiled CLI either way — those verbs talk
to `operation.*` and `git.*` directly.

### What it adds

- The **History** tab: on the desktop and the web a real page with the commit
  DAG, the operation timeline and a Commits / Activity toggle; on the phone and
  in the terminal a host-rendered commit DAG (`canvas` / `git-dag`) plus an
  Activity list of persisted lane operations.
- One route and one rail tab, as the compiled History was. `G` `H` returns to
  the commit graph, Escape and `Mod+[` close the detail pane.
- A commit detail with the git verbs the compiled context menu had:
  cherry-pick, revert, reset, create branch / lane / tag, copy SHA, open on
  GitHub.
- Agent tools: `list_commits`, `get_commit`, `list_operations`, `get_operation`.

### Notes

- The git and operation engines stay in ADE. This plugin shapes rows and calls
  `git.*` / `operation.*`.
- Phone and terminal: there was never a compiled History screen. These panels
  are the first History UI on iOS and in the terminal. The phone lists the
  same commit rows the desktop draws as a DAG.
