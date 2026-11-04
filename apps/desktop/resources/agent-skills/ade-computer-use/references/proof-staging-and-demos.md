# Proof staging and demos

## Stage before showcase proof

Stage before showcase proof (the steps are in **ade-proof-artifacts**):

| Surface | Stage |
|---|---|
| Apple | `ade apple status-bar --time 9:41 --wifi-bars 3 --battery-level 100`; a device never paired with ADE (no push banners). New screens: add a hero shot with `ade apple render --angles three-quarter-left` |
| Mac / Windows / Linux Desktop | `ade screen windows --text`, then `close` or `minimize --window <id>` everything that is not the subject |
| App Control | Only the app's window is recorded: make the subject big inside it (collapse sidebars, open the panel); `ade proof step --focus` for the rest |
| Browser | `ade browser emulate --tab <id> --width 1280 --height 800 --scale 2` (not smaller: stills come out at this size); `ade browser zoom --tab <id> --factor 1.25` when text is small |

## How a recording becomes a demo

A recording becomes a **demo** when it stops. ADE cuts still time, speeds up
waits (a load, a spinner) with a small `4×` badge, zooms to the part of the
screen where the actions happen (not on a phone, unless you pass `--zoom`),
draws the pointer and a ring on each click, and keeps the file under 10 MB.
You do none of that; you only choose what to record.

- **`--plain`** files the recording as it was recorded (no cuts, zoom, pointer
  or captions), still under 10 MB. Use it only when the user asks for it.
