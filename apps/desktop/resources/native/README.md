# ADE native helpers

`ade-attention-notch` and its adjacent SwiftPM resource bundle, and
`ade-desktop-driver` (the Mac Desktop native helper), are materialized here by:

```bash
npm --prefix apps/desktop run build:mac-native
```

or one at a time with `build:notch` / `build:desktop-driver`.

The generated universal Mach-O files are intentionally ignored by git. Electron Builder
copies it into `ADE.app/Contents/Resources/native/` for macOS releases.
