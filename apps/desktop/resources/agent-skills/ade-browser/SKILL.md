---
name: ade-browser
description: Use this skill when using ADE's built-in browser pane, shared browser tabs, screenshots, page inspection, or browser context selection through `ade browser`.
---

# ADE browser

## Scope

The ADE browser is global, not lane-scoped. Use socket mode so CLI calls and the Work sidebar share the same tabs.

## Common commands

```bash
ade help browser
ade --socket browser panel --text
ade --socket browser status --text
ade --socket browser open <url> --new-tab --text
ade --socket browser tabs --text
ade --socket browser switch --tab <id> --text
ade --socket browser screenshot --text
```

For inspection and chat context:

```bash
ade --socket browser inspect-start --text
ade --socket browser select-current --text
ade --socket browser clear-selection --text
```

## Gotchas

- Open localhost URLs and chat-output links in the ADE browser when the user expects them to show in the Work sidebar.
- Because tabs are global, confirm the active tab before taking a screenshot or selecting context.
- If there is no active browser panel/session, report the blocker rather than pretending to inspect the page.

