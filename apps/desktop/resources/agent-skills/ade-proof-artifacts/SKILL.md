---
name: ade-proof-artifacts
description: Use this skill when the user asks for proof, screenshots, video, artifacts, test evidence, computer-use capture, or when work should appear in ADE's proof drawer.
---

# ADE proof and artifacts

## Rule

When the user asks to capture, send, attach, or provide proof, create evidence with the relevant tool, then register it through ADE so it appears in the proof drawer for the active chat or lane.

**Attach, then confirm.** A filing command is not done until you have read its
confirmation. Run the attach, check that the last line says
`Attached 1 artifact to lane <id> / chat <id> (<title>)` and copy the `cite:`
line above it, then run
`ade proof list --text` and see the row. If the output contains `failed`, or the
list does not show it, the drawer is empty — fix it now rather than reporting
proof you did not file.

## Show the proof in your answer

The user reads your answer, not the drawer. Put each proof directly under the
claim it proves. Every proof command prints a `cite:` line with the artifact id:

```
cite: ![Preferences shows the new key](ade-proof://3f2c9a41-…)
```

Paste that line into your final message. A picture shows inline, and a video
plays inline, on the desktop, the web client and the phone.

For a before/after, write a `proof-compare` block. The two pictures show side
by side:

````
```proof-compare
before: <artifact-id> The old sidebar
after: <artifact-id> The new sidebar
caption: The rows now use the lane color.
```
````

You can also compose a picture yourself (a crop, a side-by-side, an
annotation), file it with `ade proof attach`, and cite it.

How to write it:

- Put the proof under the claim, not in a pile at the end.
- Give each item a caption that says what it shows.
- Add an honest caveat when the picture does not show everything: mock data,
  a partial state, a step you could not check.
- Cite as many items as your claims need. There is no limit. Choose the items
  that show the claim; do not paste every capture.
- Proof that ADE captured or recorded, and that your answer cites, shows as
  **Verified**. A file you attached shows "Attached by the agent".

A citation of an id ADE does not have shows "ADE has no proof with the id …".
Copy the id from the `cite:` line; do not type it.

## Commands

```bash
ade proof attach "$TMPDIR/checkout.png" --caption "Checkout completes" --text
ade proof list --text          # confirm the row is there
ade proof status --text
ade proof capture --caption "Checkout confirmation visible" --text     # the lane's display
ade proof record --seconds 20 --caption "Retry flow recovers" --text  # the lane's display
ade help proof
```

Each surface files its own proof. Use the one you worked on:

```bash
# Apple device (ade apple)
ade apple proof --caption "Onboarding shows the new step" --text
ade apple record-start --text
ade apple record-stop --keep --text
# Mac Desktop (ade mac-desktop) — the lane's own screen
ade mac-desktop proof --caption "Preferences shows the new key" --text
ade mac-desktop record start --caption "Note saved in TextEdit" --text
ade mac-desktop record stop --text
# App Control (ade app-control) — the controlled app's own window
ade app-control proof --caption "Settings saved" --text
ade app-control record start --caption "Settings save the API key" --text
ade app-control record stop --text
# ADE browser (ade browser)
ade --socket browser proof --tab <tab-id> --caption "Verified" --text
ade --socket browser proof --browser-session <session-id> --caption "Verified" --text
ade --socket browser record start --tab <tab-id> --caption "Checkout flow" --text
ade --socket browser record stop --tab <tab-id> --text
```

`ade proof capture` and `ade proof record` capture the lane's display. They
refuse the user's real screen unless you pass `--real-screen`. Pass it only
when the user asks for proof of their own screen. To pick a surface, see the
**ade-computer-use** skill.

## Where the file may live

`attach`/`ingest` only import from these roots: the project root, the lane
worktree, `.ade/artifacts`, `.ade/cache`, `.ade/tmp`, the OS temp dir
(`$TMPDIR`, which on macOS resolves under `/var/folders`), the conventional temp
dir `/tmp` (`/private/tmp` on macOS), and `~/.agent-browser`. Anywhere else —
`~/Desktop`, `~/Downloads` — is rejected; copy the file into one of the roots
first. `.ade/secrets` is denied even though it sits inside the project root, and
both sides of that check are resolved through symlinks, so a link pointing into
it is refused too.

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

- `ade proof capture --caption "…"`, `ade proof record`, `ade proof attach <path> --caption "…"`, `ade apple proof`, `ade app-control proof`, `ade browser proof`, `ade mac-desktop proof --caption "…"`, a captioned `ade mac-desktop record` and a captioned `ade app-control record` **do** file.
- `ade proof capture` and `ade proof record` never take the user's real screen unless you pass `--real-screen`. For desktop app work on a Mac host, work on the lane's own screen (see the **ade-computer-use** skill) and record there.
- A bare `screenshot_environment` / `record_environment` call **does not** — it hands you a scratch file path for your own look at the screen. Promote one with `ade proof attach <that path> --caption "…"` when a reviewer should see it. (There is no `captureScreenshot` tool; if you have seen it named somewhere, it does not exist and calling it fails.)

Artifacts worth filing:

- Screenshot or video of the UI state.
- App Control, iOS Simulator, or ADE browser capture.
- Test output or log bundle when visual proof is not the right artifact.

## Proof must be new

Proof shows what you did for this request. ADE checks:

- An attach whose bytes are already proof (an earlier recording copied to a
  new name, say) fails with `PROOF_DUPLICATE` and names the earlier proof.
  Do not work around it. Record a new one, or tell the user the recording
  failed.
- An attached MP4/MOV whose own creation time is before this request still
  files, but prints `warning: This video was recorded at …, before this
  request.` and the drawer marks it older. Repeat that warning to the user.
- The drawer says where each proof came from: recorded by ADE, captured by
  ADE, or attached by the agent. `ade proof attach` of a fresh, unchanged ADE
  capture keeps ADE's label; any other file is "attached by the agent",
  whatever label you pass.

## Gotchas

- Do not leave proof as an unregistered local file when the user expects ADE to show it.
- Do not report "proof attached" from a command whose output you did not read. Six attaches in a row once failed silently in a loop; the confirmation line and `ade proof list --text` are the check that catches it.
- Browser observations are scratch state, not proof; promote only reviewer-facing checkpoints with `ade --socket browser proof ...` or `ade proof attach`. The **ade-browser** skill documents where those scratch files live and how aggressively they prune.
- Include enough context in the artifact name/description to understand what was verified.
