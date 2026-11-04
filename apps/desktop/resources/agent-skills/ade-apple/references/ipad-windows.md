# iPad windows

On an iPad in windowed mode (iPadOS 26+, the default), `apple window` lays
out the app in front and reads the frame back:

```bash
"$ADE_CLI_PATH" apple window --text                 # where the window is
"$ADE_CLI_PATH" apple window --size 600x800 --text  # resize
"$ADE_CLI_PATH" apple window --move 0,0 --text      # top-left corner to 0,0
"$ADE_CLI_PATH" apple window --left --text          # also --right, --top, --bottom
"$ADE_CLI_PATH" apple window --split --text         # also --thirds, --quarters
"$ADE_CLI_PATH" apple window --fill --text          # full screen
"$ADE_CLI_PATH" apple window --slide-over --text
```

- `--size` drags the window's resize grabber, correcting until it is within
  3 points. The layouts are the window's own menu (a long press on its green
  button). Either way the answer says `applied` and exits 1 when the window
  did not land; read the `reason`.
- The frame is the real one, off-screen parts included: `window` says when
  the window hangs past an edge, and a layout never counts as landed while
  part of it is off the screen. A layout first drags such a window back on.
- A size that does not fit from the window's top-left corner is refused:
  move it first (`--move 0,0`, `--left`, `--top`).
- `--move` says where iPadOS left the window: it snaps a window near a
  screen edge to that edge and keeps its bottom above the Dock, so a few
  points off is iPadOS, not a failed drag. A layout whose window is larger
  than its slot (the app's minimum size) lands with a `note`; it may then run
  past one screen edge.
- A window pushed past the right edge is stashed by iPadOS; when `window`
  says it cannot find the window, `relaunch --bundle-id <id>` brings it back.
- `APPLE_WINDOWING_UNAVAILABLE`: the app in front is not in a window (an
  iPhone, or an iPad set to Full Screen Apps in Settings ▸ Multitasking &
  Gestures), or ADE cannot find the window. Portrait and landscape both
  work.
- `snapshot`, `find` and `tap-element` give screen points wherever the
  window is. If a read could not place a window (one still opening), its rows
  say `(unplaced)` and `tap-element` refuses them: run it again.
