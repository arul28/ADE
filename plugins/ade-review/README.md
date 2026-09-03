## Review

Run AI review passes over a lane, a commit range, uncommitted changes, or a
pull request, then act on the findings — acknowledge, dismiss, snooze, or
suppress similar ones.

This plugin replaces ADE's compiled Review tab. Install it and the rail, the
PR "ADE review" button, and `ade review` talk to this package. Disable it and
the compiled Review page comes back unchanged.

From **2.0.0** the desktop and the web client draw the plugin's own page — the
compiled Review UI, moved into `page/` and built into the committed `dist/`. The
phone and the terminal draw the vocabulary panels, which are unchanged and are
still the only Review UI those clients have ever had.

### What it adds

- The **Review** tab, as a page on desktop and web and as a panel everywhere
  else: the runs list, the run detail with findings and evidence, and the
  learnings view.
- Launch from the tab, the command palette, or a pull request. The PR detail
  button opens the launch form as an anchored popover.
- Findings with the same four feedback verbs the compiled page offered, and the
  same feedback dialog behind three of them.
- Learnings: the quality report and the suppressions list.
- Agent tools and `ade review runs | launch | learnings`.

### Notes

- The review engine stays in ADE. This package shapes rows, answers the page's
  reads, and calls `review.*`.
- The review agent is read-only. It never edits, commits, or pushes.
- Live progress arrives on `host.subscribe({ kinds: ["review"] })`, and falls
  back to the child's own poll on a host that does not answer that kind.
- `dist/` is committed, because an installed plugin is a copy of the tree and
  the installer runs no build step. Rebuild it with `npm run build` in `page/`
  whenever anything under `page/src/` changes.

### Layout

```
plugin.json      two webview surfaces, four panels, four tools, five sockets
index.js         the lifecycle, the panel actions, the tools and the CLI words
pageActions.js   the page's action table — one handler per `page*` id
panels.js        the vocabulary panels every non-desktop client draws
format.js        row shaping and the labels four clients share
launch.js        the panel launch form → `review.startRun` args
page/            the plugin's own HTML page (see page/README.md)
dist/            the built page — committed, written only by page/'s build
PARITY.md        what the page carries against compiled Review, and what it does not
```
