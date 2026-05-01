# ADE iOS Simulator private helpers

ADE uses these helpers as the primary low-latency path for local iOS Simulator
streaming and touch input on macOS.

- `sim-capture.swift` attaches to CoreSimulator's private IOSurface display
  descriptors, JPEG-encodes framebuffer updates, and writes
  `[u32 big-endian length][jpeg bytes]` frames to stdout. It accepts `--fps`
  and `--quality` so ADE can cap renderer load without changing callers.
- `sim-input.m` opens SimulatorKit's private Indigo HID client and accepts
  newline-delimited JSON input commands on stdin. Touch input is sent through
  Indigo; unsupported keyboard/text operations are reported as typed failures so
  ADE can fall back to idb for that method.
- `build.sh` compiles both helpers lazily into `build/xcode-<version>-<hash>/`.
  Set `ADE_IOS_SIM_HELPER_BUILD_ROOT` to place that cache somewhere else;
  packaged ADE builds use this to keep generated binaries outside the signed
  `.app` bundle.

These helpers intentionally use Apple private frameworks. They are local
developer tooling, not app runtime code. Keep the supported Xcode major-version
set explicit in `iosSimulatorService.ts`, and expand it only after testing the
helpers against that Xcode. Packaged ADE builds ship these sources as resources
and compile the selected-Xcode helper binaries into the user's ADE cache at
runtime.

To rebuild manually:

```sh
cd apps/desktop/native/ios-sim-helpers
bash ./build.sh --print-json --smoke
```

Known sensitivities:

- Full Xcode is required. Command Line Tools alone do not include
  `SimulatorKit.framework`.
- The helper checks both the iPhoneSimulator platform-private framework path
  and the newer selected-Xcode developer-private framework path.
- Xcode 17.x and 26.x are the currently enabled major versions in ADE.
- Xcode updates may rename private classes/selectors or change Indigo packet
  layouts.
- Multiple booted simulators are supported only when ADE passes a UDID.
