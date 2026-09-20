# ADE native helpers

`ade-attention-notch` and its adjacent SwiftPM resource bundle, and
`ade-desktop-driver` (the Mac Desktop native helper), are materialized here by:

```bash
npm --prefix apps/desktop run build:mac-native
```

or one at a time with `build:notch` / `build:desktop-driver`.

The generated universal Mach-O files are intentionally ignored by git. Electron Builder
copies it into `ADE.app/Contents/Resources/native/` for macOS releases.

## Capture helper

`ade-capture-helper` (macOS) and `ade-capture-helper.exe` (Windows) back the
global capture gesture. Neither can be cross-compiled, so each is built on its
own platform and each build script skips cleanly off it:

```bash
npm --prefix apps/desktop run build:capture-helper      # macOS, SwiftPM
npm --prefix apps/desktop run build:capture-helper:win  # Windows, cl.exe or mingw
```

Unlike the notch, these ship through a **top-level** `build.extraResources`
entry filtered to the two names, so one entry covers both platforms and the
package only ever contains the helper its own build produced.
