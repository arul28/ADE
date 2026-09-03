## iOS Sim Control

Pick a simulator, build and launch your app on it, then tap, type and inspect the
running screen — without leaving ADE.

This plugin replaces ADE's compiled simulator pane. Install it and the Work tools
talk to this package. Disable it and the compiled pane comes back unchanged.
`simctl`, `xcodebuild` and `idb` stay in ADE.

### What it adds

- The **iOS Sim Control** pane in the Work tools, and a command-palette entry
  that opens the same page.
- A `get_status` tool. Launching, tapping, typing and screenshotting from an
  agent stay on `ade ios-sim`, which is the same host underneath.

### How it is built

Three tiers, one product:

- **Desktop and web** draw the plugin's own HTML page (`page/`, built into
  `dist/`). It carries every control — the device picker, the launch-target
  picker, Launch / Apply / Stop, the Control and Inspect toolbar, the zoom rail,
  the setup chips, the ownership card and Preview Lab.
- **The live screen** is not the page's. It is a `Simulator.app` window capture
  and it stays in the host: the page reserves a rectangle, measures it, and
  calls `hostEngine.place({ engineId: "simulator", rect })`. See
  `page/README.md` for the whole contract.
- **Phone and terminal** draw the `main` panel: the status row, plus one honest
  line saying that driving a simulator needs a Mac. There is no phone-shaped
  version of `simctl`, and a tap control that cannot work is worse than none.

Every verb the page presses goes page → `adePlugin.invoke` → this plugin's child
(`pageActions.js`) → `ios_simulator` on the host. Twenty-five page actions, one
per compiled call the pane made. `page/src/host/actions.ts` carries the map;
`PARITY.md` measures it against the compiled pane and lists the gaps.

### Notes

- It needs a Mac. On anything else the pane says so and the status row reads
  "Needs a Mac".
- The page holds no project root: the host resolves the build root from the
  project this plugin is bound to, so a page cannot ask this machine to build a
  directory it named itself.
- "iOS Sim Control" is ADE's pane; "iOS Simulator" is Apple's product. Where you
  see the second — a booted runtime, Xcode's simulator — it means Apple's.
