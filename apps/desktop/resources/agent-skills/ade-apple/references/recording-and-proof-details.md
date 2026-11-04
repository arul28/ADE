# Recording and proof details

## Why capture through `ade apple`

**Capture through these commands, not through `xcrun simctl io screenshot`.**
The difference is not the picture, it is the owner. An `ade apple` capture is
filed against the lane and the asking chat, so it appears in the drawer the
human is looking at. A picture you take with `simctl` and then hand to
`ade proof attach` is filed against whatever ADE can work out about your shell,
and a shell with no chat session — every OpenCode agent has one, because a
single `opencode serve` is shared across chats — used to produce a record owned
by nothing, invisible to everyone, while every command reported success. That
now fails loudly instead of lying, which is better and still not proof.

## Projects on an external drive

macOS won't let the Simulator's own service
write to a removable or external volume, and it can't ask for permission, so
`xcrun simctl io … screenshot <path>` or `recordVideo <path>` into a project on
such a drive fails with "Operation not permitted". `ade apple` handles this (it
captures on the internal disk and saves the file into the lane for you). If you
ever run `simctl io` by hand, write to `/tmp`. Builds, installs and tests work
from the drive.

## How a recording becomes a demo

When it stops, the recording becomes a demo: still time is cut, waits play
faster, tap rings are drawn, and the file ends under 10 MB. The camera does not zoom on a phone; pass
`record-start --zoom` only when the user asks for zoom, or hold on one
region with `ade proof step --focus`. Mark each step with `ade proof step "<what happens
next>"`: a caption in the video and a chapter in ADE's player.
`record-stop` reports `durationMs` (the demo), `wallDurationMs` (real time)
and `idleCutMs`. Pass `--plain` only when the user asks for the recording
as it was recorded.
