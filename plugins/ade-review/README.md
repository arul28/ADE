## Review

Run AI review passes over a lane, a commit range, uncommitted changes, or a
pull request, then act on the findings — acknowledge, dismiss, snooze, or
suppress similar ones.

This plugin replaces ADE's compiled Review tab. Install it and the rail, the
PR "ADE review" button, and `ade review` talk to these panels. Disable it and
the compiled Review page comes back unchanged.

### What it adds

- The **Review** tab, on every client that draws vocabulary panels.
- Launch from the tab, the command palette, or a pull request.
- Findings with the same feedback the compiled page offered.
- Learnings: the quality report and the suppressions list.
- Agent tools and `ade review runs | launch | learnings`.

### Notes

- The review engine stays in ADE. This plugin shapes rows and calls `review.*`.
- The review agent is read-only. It never edits, commits, or pushes.
- Phone: there was never a compiled Review screen. These panels are the first
  Review UI on iOS and in the terminal.
