# ADE native helpers

`ade-desktop-driver` (the Mac Desktop native helper) is materialized here by:

```bash
npm --prefix apps/desktop run build:mac-native
```

or alone with `build:desktop-driver`.

The generated universal Mach-O file is intentionally ignored by git. Electron Builder
copies it into `ADE.app/Contents/Resources/native/` for macOS releases.

## Capture helper

`ade-capture-helper` (macOS) and `ade-capture-helper.exe` (Windows) back the
global capture gesture. Neither can be cross-compiled, so each is built on its
own platform and each build script skips cleanly off it:

```bash
npm --prefix apps/desktop run build:capture-helper      # macOS, SwiftPM
npm --prefix apps/desktop run build:capture-helper:win  # Windows, cl.exe or mingw
```

Unlike the Mac Desktop driver, these ship through a **top-level** `build.extraResources`
entry filtered to the two names, so one entry covers both platforms and the
package only ever contains the helper its own build produced.

## Demo engine

`ade-media` (macOS only, `native/ADEMedia`) analyzes a raw recording and
renders its demo plan into the filed MP4 (see
`src/shared/demoVideo/demoContract.ts`). It ships through the same top-level
`resources/native` entry as the capture and simulator helpers:

```bash
npm --prefix apps/desktop run build:ade-media   # resources/native/ade-media
npm --prefix apps/desktop run test:ade-media
```

Off macOS the chromium engine renders demos instead, so there is no Windows
build.
