# Speech-to-text resources

This directory holds the on-device speech-to-text engine used by ADE's desktop
voice dictation feature. **Its contents are NOT committed** — they are binaries
materialized at build/release time. The directory keeps its historical
`whisper` name so packaging paths and existing installs stay stable.

## What lives here (after materialize)

- `transcribe-cli` — the per-platform [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)
  CLI binary (`transcribe-cli.exe` on Windows), statically linked. On Apple
  Silicon it is built with Metal and an embedded shader library; macOS
  universal builds are two per-arch builds merged with `lipo`.

The speech model is **not** bundled. The app downloads
`parakeet-ultra-Q4_K_M.gguf` (~464 MB, CC-BY-4.0) on demand into
`<userData>/whisper/` from a commit-pinned Hugging Face URL and verifies its
SHA-256 (see `src/main/services/transcription/speechModelStore.ts`).

## How they get here

Run, from `apps/desktop/`:

```sh
npm run materialize:whisper-resources   # builds transcribe-cli from a pinned commit
npm run validate:whisper-resources      # asserts presence + executability
```

The build needs `git` and `cmake` on PATH (plus a C++ toolchain: Xcode on
macOS, Visual Studio Build Tools on Windows). Overrides:

- `ADE_TRANSCRIBE_SRC_REPO` / `ADE_TRANSCRIBE_SRC_REF` — source repo and commit.
- `ADE_TRANSCRIBE_CLI_URL` (or `ADE_TRANSCRIBE_CLI_URL_<TARGET>`) plus the
  matching `ADE_TRANSCRIBE_CLI_SHA256` — use a prebuilt binary instead.
- `ADE_SPEECH_BUNDLE_MODEL=1` — also download the model here for local dev
  runs (with `ADE_SPEECH_MODEL_URL` / `ADE_SPEECH_MODEL_SHA256` for a mirror).
  Packaging excludes `*.gguf`, so it never ships in the app.
- `ADE_SPEECH_REQUIRE_UNIVERSAL=1` — build a universal (arm64 + x86_64) macOS
  binary; the `dist:mac:universal:*` scripts set it.

Builds never use `-march=native`: x86-64 targets AVX2 (x86-64-v3), and arm64
uses ggml's portable defaults, so a binary built on CI runs on users' CPUs.

Both steps are wired into every `dist:*` packaging script in `package.json`,
right after the runtime-resource materialize/validate.

## Packaging + auto-update delivery

These files are shipped via electron-builder `extraResources` (`from: resources/whisper`
→ `to: whisper`), landing at `<app>/Contents/Resources/whisper/` (macOS) /
`resources/whisper/` (Windows). At runtime `transcriptionService` resolves them
from `process.resourcesPath/whisper` (packaged) or `apps/desktop/resources/whisper`
(dev).

**Updater note:** because the full application bundle is delivered on every
auto-update, the binary reaches EXISTING installs automatically. Users who had
the old whisper model see the speech model as not installed after updating and
download the new one once; the old `ggml-base.en.bin` is deleted when it does.
