---
name: ade-proof-artifacts
description: Use this skill when the user asks for proof, screenshots, video, artifacts, test evidence, computer-use capture, or when work should appear in ADE's proof drawer.
---

# ADE proof and artifacts

## Rule

When the user asks to capture, send, attach, or provide proof, create evidence with the relevant tool, then register it through ADE so it appears in the proof drawer for the active chat or lane.

**Attach, then confirm.** A filing command is not done until you have read its
confirmation. Run the attach, check that the last line says
`Attached 1 artifact to lane <id> / chat <id> (<title>)`, then run
`ade proof list --text` and see the row. If the output contains `failed`, or the
list does not show it, the drawer is empty — fix it now rather than reporting
proof you did not file.

## Commands

```bash
ade proof attach "$TMPDIR/checkout.png" --caption "Checkout completes" --text
ade proof list --text          # confirm the row is there
ade proof status --text
ade proof capture --caption "Checkout confirmation visible" --text
ade proof record --seconds 20 --caption "Retry flow recovers" --text
ade --socket browser proof --tab <tab-id> --caption "Verified" --text
ade --socket browser proof --browser-session <session-id> --caption "Verified" --text
ade help proof
```

## Where the file may live

`attach`/`ingest` only import from these roots: the project root, the lane
worktree, `.ade/artifacts`, `.ade/cache`, `.ade/tmp`, the OS temp dir
(`$TMPDIR`, which on macOS resolves under `/var/folders`), the conventional temp
dir `/tmp` (`/private/tmp` on macOS), and `~/.agent-browser`. Anywhere else —
`~/Desktop`, `~/Downloads` — is rejected; copy the file into one of the roots
first.

## Which directory the call claims

You do not have to be standing in the lane worktree. `ADE_WORKSPACE_ROOT` (the
lane worktree) beats the shell cwd, and with only `ADE_LANE_ID` set the runtime
resolves the worktree itself. If a call is still refused, the error names the
path used, where it came from (`cwd` vs `env …`), and the authorized root — read
those three before retrying.

## Confirming it landed

`attach`, `capture`, `ingest`, and `record` re-read the record they filed and,
with `--text`, end with:

```
Attached 1 artifact to lane improving-browser-4bb19b3f / chat 8f3c2a11 (Checkout completes)
```

They exit 0 only when that record exists. Any failure exits non-zero and prints
one line containing `failed`, e.g.
`ade: proof attach failed — Artifact path is outside allowed import roots: …`.
`ade proof list --text` names the scope it listed and carries an `owner` column,
so you can see whether you are looking at your own lane and chat.

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
- Do not report "proof attached" from a command whose output you did not read. Six attaches in a row once failed silently in a loop; the confirmation line and `ade proof list --text` are the check that catches it.
- Browser observations are scratch state, not proof; promote only reviewer-facing checkpoints with `ade --socket browser proof ...` or `ade proof attach`. The **ade-browser** skill documents where those scratch files live and how aggressively they prune.
- Include enough context in the artifact name/description to understand what was verified.
