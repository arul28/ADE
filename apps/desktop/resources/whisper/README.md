# Whisper voice-to-text resources

This directory holds the on-device speech-to-text engine used by ADE's desktop
voice dictation feature. **Its contents are NOT committed** — they are large
binaries materialized at build/release time.

## What lives here (after materialize)

- `whisper-cli` — the per-platform [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
  CLI binary (`whisper-cli.exe` on Windows). The transcription service also
  accepts `main` / `whisper` as fallback binary names.
- `ggml-base.en.bin` — the ~142 MB English `base.en` ggml model.

## How they get here

Run, from `apps/desktop/`:

```sh
npm run materialize:whisper-resources   # downloads model + binary
npm run validate:whisper-resources      # asserts presence + size + executability
```

The model URL defaults to the official whisper.cpp HuggingFace mirror and can be
overridden with `ADE_WHISPER_MODEL_URL`. whisper.cpp does not publish a single
canonical cross-platform binary, so the CLI binary URL must be supplied via
`ADE_WHISPER_CLI_URL` (or the per-target `ADE_WHISPER_CLI_URL_<TARGET>` env var),
or a prebuilt `whisper-cli` can be dropped in here manually.

Both steps are wired into every `dist:*` packaging script in `package.json`,
right after the runtime-resource materialize/validate.

## Packaging + auto-update delivery

These files are shipped via electron-builder `extraResources` (`from: resources/whisper`
→ `to: whisper`), landing at `<app>/Contents/Resources/whisper/` (macOS) /
`resources/whisper/` (Windows). At runtime `transcriptionService` resolves them
from `process.resourcesPath/whisper` (packaged) or `apps/desktop/resources/whisper`
(dev).

**Updater note:** because the full application bundle is delivered on every
auto-update, these resources reach EXISTING installs automatically when they
update — no separate fetch is required. The release pipeline must ensure the
materialize/validate steps ran so the packaged bundle actually contains them.
