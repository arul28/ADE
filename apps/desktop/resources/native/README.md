# ADE native helpers

`ade-attention-notch` and its adjacent SwiftPM resource bundle are materialized
here by:

```bash
npm --prefix apps/desktop run build:notch
```

The generated universal Mach-O is intentionally ignored by git. Electron Builder
copies it into `ADE.app/Contents/Resources/native/` for macOS releases.
