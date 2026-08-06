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
ade proof screenshot --text
ade proof record --seconds 20 --text
ade --socket browser proof --tab <tab-id> --caption "Verified" --text
ade --socket browser proof --browser-session <session-id> --caption "Verified" --text
ade help proof
```

## What counts as proof

- Screenshot or video of the UI state.
- App Control, iOS Simulator, or ADE browser capture.
- Test output or log bundle when visual proof is not the right artifact.

## Gotchas

- Do not leave proof as an unregistered local file when the user expects ADE to show it.
- Browser observations are scratch state, not proof; promote only reviewer-facing checkpoints with `ade --socket browser proof ...` or `ade proof attach`. The **ade-browser** skill documents where those scratch files live and how aggressively they prune.
- Include enough context in the artifact name/description to understand what was verified.
