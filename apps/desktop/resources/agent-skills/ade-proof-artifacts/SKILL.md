---
name: ade-proof-artifacts
description: Use this skill when the user asks for proof, screenshots, video, artifacts, test evidence, computer-use capture, or when work should appear in ADE's proof drawer.
---

# ADE proof and artifacts

## Rule

When the user asks to capture, send, attach, or provide proof, create evidence with the relevant tool, then register it through ADE so it appears in the proof drawer for the active chat or lane.

## Commands

```bash
ade proof status --text
ade proof list --text
ade proof capture --caption "Checkout confirmation visible" --text
ade proof record --seconds 20 --caption "Retry flow recovers" --text
ade proof attach "$TMPDIR/checkout.png" --caption "Checkout completes" --text
ade --socket browser proof --tab <tab-id> --caption "Verified" --text
ade --socket browser proof --browser-session <session-id> --caption "Verified" --text
ade help proof
```

## Where the file may live

`attach`/`ingest` only import from these roots: the project root, the lane
worktree, `.ade/artifacts`, `.ade/cache`, `.ade/tmp`, the OS temp dir
(`$TMPDIR`, which on macOS resolves under `/var/folders` — plain `/tmp` is
**not** allowed), and `~/.agent-browser`. Run the command from inside the lane
worktree; a shell cwd outside it is rejected.

## What counts as proof — and what does not

Only a proof-named command files a drawer entry. Taking a screenshot is not the same as filing proof:

- `ade proof capture --caption "…"`, `ade proof record`, `ade proof attach <path> --caption "…"`, and `ade browser proof` **do** file.
- A bare `screenshot_environment` / `record_environment` call **does not** — it hands you a scratch file path for your own look at the screen. Promote one with `ade proof attach <that path> --caption "…"` when a reviewer should see it. (There is no `captureScreenshot` tool; if you have seen it named somewhere, it does not exist and calling it fails.)

Artifacts worth filing:

- Screenshot or video of the UI state.
- App Control, iOS Simulator, or ADE browser capture.
- Test output or log bundle when visual proof is not the right artifact.

## Gotchas

- Do not leave proof as an unregistered local file when the user expects ADE to show it.
- Browser observations are scratch state, not proof; promote only reviewer-facing checkpoints with `ade --socket browser proof ...` or `ade proof attach`. The **ade-browser** skill documents where those scratch files live and how aggressively they prune.
- Include enough context in the artifact name/description to understand what was verified.
