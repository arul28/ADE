# Linux Desktop

- **The screen is the lane's own X display.** No human pointer is on it, so
  point clicks, drags, keys and `--real` need no lease. A person who takes
  control from a viewer still wins; wait for them to hand it back.
- **Missing packages:** a plain server may lack Xvfb, the window manager,
  AT-SPI or ffmpeg. `ade screen status --text` lists them with the install
  command (`missing packages`, `install with`). You cannot install them: ask
  the user to run `ade screen setup --allow-prompt` from their ADE client, or
  the printed command on that machine.
- **Browsers:** `ade screen open https://…` starts the machine's Chrome or
  Chromium (Firefox if that is all there is) with a lane-private profile and
  its accessibility tree on. `ade screen open chrome` works too. If no browser
  is installed, `open` says so; ask the user to install one.
- **Electron and desktop apps:** `ade screen open <app or path>`; Electron
  apps get `--force-renderer-accessibility` so their elements appear in
  `observe`. For an Electron app whose DOM you need, add
  `-- --remote-debugging-port=9333` and attach with `ade app-control connect`.
- **No elements?** `observe` lists `stalledApps` with the reason (no
  accessibility bus, an app that stopped answering). Act by point from the
  screenshot (`ade screen click 640,400`) until it answers again.
- **Modifier keys:** `--ctrl`, `--alt`, `--shift`, `--win` (Super). `--cmd`
  is sent as Ctrl, so the shortcuts you know from a Mac work.
- **Windows:** `focus`, `minimize` and `close --window <id>` work as on
  Windows. There is no `claim`, `release` or "Bring to my screen": every window
  on the lane's screen is already the lane's.
- **Recording and the live view need ffmpeg.** Without it, everything else
  works and `record start` says what is missing.
