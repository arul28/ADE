# Vendored: expo/serve-sim `SimNative`

## Source

| | |
|---|---|
| Upstream | https://github.com/expo/serve-sim |
| Path | `packages/serve-sim/Sources/SimNative` |
| Commit | `c8206925f3e6747236714d781ef2b6244c7a36f5` (`refs/heads/main`) |
| Retrieved | 2026-09-21 |
| Licence | Apache License 2.0 (`LICENSE` in this directory, copied from the upstream repository root) |

Upstream ships **no** `NOTICE` file. The `NOTICE` beside this file is ADE's own,
written to satisfy Apache-2.0 §4 attribution for a derivative distribution.

## Files taken verbatim

Every file below is byte-for-byte upstream except the ones marked ADE-patched,
which carry documented ADE patches (see "ADE patches" below; their SHA-256 is
upstream's). Do not hand-edit the verbatim files; re-vendor from a newer commit
and update the table instead, and reapply every ADE patch to a re-vendored
patched file.

| File | SHA-256 |
|---|---|
| `AccessibilityBridge.swift` | `d3163df97c1efef3ea7aa0e45a939cfa77fa374a968e5fb7964f7f4c4630044d` (ADE-patched — see below; reapply on re-vendor) |
| `CaptureEngine.swift` | `5a796d364cf2f1e74e81fa4e3817c43c95f32bda3a3e4086f7a38ea6cf7919ba` (ADE-patched — see below) |
| `FrameCapture.swift` | `1923bf752f82a1023395b556f428861b2f5c26d1c78dfe49e6a51f8a9559399a` |
| `H264Encoder.swift` | `11dfb325ab7764009ff04e01e84b9f0fa1c9c2975fca872044c84237ac6e836b` |
| `HIDInjector.swift` | `1c62b64d37f6702964c0eb3f7824a77f69e6ba9ebb6a2a5a573f068f26482483` |
| `PixelBufferUtils.swift` | `66191afe77b60b79ba9126a9e889184e7d80f9ff3829010181ebfddc81eee0d0` |
| `SimFrameworks.swift` | `1ffd4ab81d9d09c3e0a7e7979d9e400c3c4231aa1d91e89a2538c17eb83df1ab` |
| `StreamFormat.swift` | `a43ca072045ddf63ae3f8cccb61a202c538730747e6e242c0509ae067501aca9` |
| `VideoEncoder.swift` | `f51cea194e9784af43f400621632c5b33ef5c8bb99bf55af005300ed689335a4` |
| `Xcode.swift` | `a7a800e888378d4d6a4385748613c02a45c558d7328a21a2a19fc0ba38073464` |

## ADE patches to vendored files

`CaptureEngine.swift` is patched in two places, both to let a caller cap the
H.264 encoder's bitrate (upstream fixes `AVCCEncoder` at 60 fps / 6 Mbps, which
made ADE's "Remote viewer bitrate cap" setting inert):

- `addAVCCConsumer(onFrame:bitrateKbps:)` gains an optional `bitrateKbps` and
  passes it to the encoder.
- `AVCCEncoder.init(bitrateKbps:)` builds `H264Encoder(fps: 60, bitrate:)` from
  the cap (clamped 100–20 000 kbps), defaulting to upstream's 6 000 when nil.

Everything else in the file is unchanged. The correct long-term fix is to
upstream a wider `addAVCCConsumer` API and drop this patch; until then, when
re-vendoring from a newer commit, re-apply this patch and update the note.

## Deliberately NOT vendored

`sim-module.swift` (SHA-256 `043e3d4060d59b1c27bc8afb01788ee33d0cb46bf176874c7fcedbb57e79ea6f`)
is upstream's node-swift / N-API entry point. It was read to learn the API
surface and then replaced: ADE ships a helper **process** speaking NDJSON, not an
in-process native addon, so ADE does not take a `node-swift` dependency and a
crash in CoreSimulator cannot take the Electron main process with it. Its
replacement is `../../SimHelperRuntime.swift` plus `../../DeviceSession.swift`.

## How ADE stays out of the vendored code

The vendored files are used exactly as upstream wrote them. Two upstream
behaviours that would otherwise have forced an edit are worked around from
ADE's side instead:

1. **The vendored code `print`s to stdout** (`FrameCapture`, `HIDInjector`,
   `CaptureEngine`). stdout is ADE's NDJSON control channel, so a single
   `[capture] …` line would corrupt it. `Sources/ADESimHelper/main.swift`
   `dup2`s stderr over fd 1 at startup and writes NDJSON to a saved duplicate of
   the real stdout, so every `print` in vendored code lands on stderr.
2. **`CaptureEngine.addConsumer` is private**, so ADE cannot register a
   PNG or Annex-B encoder of its own. ADE subscribes with the public
   `addAVCCConsumer` and unwraps `AVCCEnvelope` (5-byte header) in
   `../../AnnexB.swift`; PNG screenshots go through `addMJPEGConsumer` and a
   JPEG→PNG transcode in `../../DeviceSession.swift`.

If either of those stops being tenable, the fix is to upstream a wider API to
expo/serve-sim, not to fork these files.

## Added 2026-10-21: CoreDevice foldable controls (from expo/expo-device-hub)

serve-sim moved into https://github.com/expo/expo-device-hub (`packages/serve-sim/packages/serve-sim/Sources`). Only the CoreDevice pieces were taken: the hinge, pose, physical-orientation and active-display path the iPhone Duo needs. The rest of upstream (N-API addon, WebRTC) is not vendored.

| | |
|---|---|
| Upstream | https://github.com/expo/expo-device-hub |
| Commit | `2dbd92873b6ce44722cb0d283c70bd2684172c63` |
| Retrieved | 2026-10-21 |
| Licence | Apache License 2.0 (same as above) |

Verbatim, byte for byte:

| File | SHA-256 |
|---|---|
| `CoreDeviceShim/CoreDeviceDigitizerShim.m` | `dfdf9611b57e74ad828bad0505c64dd01b425603da4c63746ef39c0d57eaa78e` |
| `CoreDeviceShim/CoreDeviceDisplayShim.m` | `18335441b4687fc27fc6d0b263ef4ab5e801febe2ef74fd4f71ffc55e38c05ef` |
| `CoreDeviceShim/CoreDeviceHingeReadbackShim.c` | `a9ddd3cec795bd86639f4d1d0cd9ed40701cf5f9d06ec777fcfc24233531bbe6` |
| `CoreDeviceShim/CoreDeviceKeyboardShim.m` | `e5b0beac9310a6961432e78adb4f465775afcda7be530ed5fa4d997473e711e2` |
| `CoreDeviceShim/CoreDeviceMotionShim.c` | `e68c7c0e5a3b7e25aabaee5af5a59b1df879b3ba3342abafde4e8089cc7704bf` |
| `CoreDeviceShim/CoreDevicePoseShim.m` | `5a2bd7a50a3fe358a9ed4029cbd8e1398ea58028759499df1d2c6df5f02fea11` |
| `CoreDeviceShim/CoreDeviceShim.m` | `cb081b47bedf619510217fc2627230e4060025b8b71dbe54c0cf8455538bb7f2` |
| `CoreDeviceShim/CoreDeviceStateReadbackShim.c` | `609d00f54933fae47985085f47e3819a127aeba4438b37686c651cc1b40457a5` |
| `CoreDeviceShim/CoreDeviceTrampolines.S` | `6e1434423bc19550c0c501ba26716f54ebd299eb9589dcfd0eb29350e84263d8` |
| `CoreDeviceShim/include/CoreDeviceDigitizerShim.h` | `b1d929c9b652859ecee2790c21381bb76a84c702c9abd91ca4d25abfa5890ae3` |
| `CoreDeviceShim/include/CoreDeviceDisplayShim.h` | `05e731e413d931f8f2630a9566c4e6a9a8c7a0bcbfca00cf24640d58b0d15da1` |
| `CoreDeviceShim/include/CoreDeviceMotionShim.h` | `e28f240dba2f8093fc2b6e2f2d230e9d03a670d905d2feb381aa51668ff58513` |
| `CoreDeviceShim/include/CoreDeviceShim.h` | `90bf2bd2c3cbe6f249bd26ee70ff56afe32181ba8bd16e040a58d9dcaa8ac5a7` |
| `StreamingPolicy/BootBoundCache.swift` | `5010238be3af7df7b5586586b36bcae03292e0b78d9e0a1176eb6cad2fa582f8` |
| `StreamingPolicy/HingePoseControl.swift` | `ba58d09ba74aa5557fdb6fe87ae63a40839aa0334cbf8f30dba8eff6102ae552` |
| `StreamingPolicy/SharedReadiness.swift` | `6402890b847ab290b1d07ff41c89088a78f08ea41cf9ababada31173ade69a97` |
| `StreamingPolicy/SimulatorScreenOrientation.swift` | `ad6bdc12abae1de6e3a5905fb875e748af986ec88a3e955506fe85b63d2a8934` |
| `ADESimHelperCore/Vendor/serve-sim/CoreDeviceBridge.swift` | `181515692e839a67f71f11372c0abe05acdf11dc425f0b259c2701384edae792` |
| `ADESimHelperCore/Vendor/serve-sim/CoreDeviceState.swift` | `10723d5366354fa23d53e776b23faf3d9e313ad268919b57aab6c800aa2161b3` |
| `ADESimHelperCore/Vendor/serve-sim/CoreDeviceHingeReadback.swift` | `9e19a207ec04b597ae3dd5a7b80746e873d8e71b3c3d7f949ede9297682a3369` |
| `ADESimHelperCore/Vendor/serve-sim/CoreDeviceStateReadback.swift` | `70a8c7bfc7cd6ca2b624a7f966fa408cc72eacd65c9dd692ab7fa1758b0f0df2` |
| `ADESimHelperCore/Vendor/serve-sim/CoreDeviceDisplayInfo.swift` | `08fd4be8cbeaf0d309d857c626728fd589523d8e4ae8bab64c92c81c8d6e92d4` |
| `ADESimHelperCore/Vendor/serve-sim/CoreDeviceHIDServices.swift` | `d041f5db91db1f829ce897cdbbe9500aa45ed8438fb2049df5f835ca8d37297e` |
| `ADESimHelperCore/Vendor/serve-sim/DeviceStateDelivery.swift` | `dc483f5227caf43d7d5ab652fe761af096711d9323916c6b223cad0e22e21bc8` |

ADE's own code on top of it lives outside `Vendor/`: `DevicePosture.swift` and the `posture` and `posture-get` commands (streaming starts the posture watcher itself) in `Protocol.swift` / `SimHelperRuntime.swift`.

### ADE patches for foldables (2026-10-21)

- `FrameCapture.swift`: `setPreferredScreen(_:)` and a `screenProperties` → `screenID` read, so capture follows the panel CoreDevice reports active (the Duo keeps both panels' surfaces alive and the largest is always the inner one). With no preferred screen the upstream largest-surface pick is unchanged, which is every non-foldable device.
- `CaptureEngine.swift`: `setPreferredScreen(_:)` forwarding to it.
- `AccessibilityBridge.swift` (no longer byte-for-byte; the SHA-256 above is upstream's): `describeUI(udid:displayId:displayOrientation:)` sends the frontmost-app read and every grid hit-test to the live panel's display (the Duo's inner display is 3; display 0 finds nothing there), and `probeToFrame` turns a grid point by that panel's picture turn before the coverage check, since probes are in the app frame and element frames in the picture. Upstream's display 0 and identity turn are the defaults, which is every non-foldable device.
- `CoreDeviceShim/CoreDeviceTrampolines.S` and `CoreDeviceShim/CoreDeviceShim.m` (no longer byte-for-byte; the SHA-256s above are upstream's): on x86_64 the four cross-file async descriptors are zero (x86_64 Mach-O cannot encode that relative pointer) and `SSCoreDeviceInitialize` returns false. ADE's helper is universal; the Duo needs Xcode 27.1, which runs only on Apple silicon.

### Where ADE's accessibility code lives

ADE's additions to `AccessibilityBridge` are an `extension AccessibilityBridge` in `ADESimHelperCore/AccessibilityPlacement.swift`, outside `Vendor/`: `Description` and `limits`, `placeTree`, `cover`, `alignToGrabber`, `placeLater`, `contextId`, `isSystemElement`, `makePlacement`, `describeElement`, `focusedElement`, `frameToProbe` and the value-description role sets. The vendored file keeps only what an extension cannot hold or what must sit inside upstream's functions:

- the `currentTurn` and `systemPids` stored properties;
- the calls into the extension inside `describeUI`, `discoverByGrid` and `serialize` (the bullets below);
- `private` dropped from the members the extension uses (`lock`, `translator`, `ensureLoaded`, the token registry, `serialize`, `stringValue`, `bundleIdForPid` and the two caps), since Swift's `private` does not reach another file.

When re-vendoring, reapply those hooks and access changes; the extension file needs no change unless upstream renames what it calls.

### ADE patches for reading values and caps (2026-10-27)

- `AccessibilityBridge.swift`: a number that is not finite is no value. A SwiftUI adjustable element with no numeric value answers NaN, which `String(describing:)` wrote as `"nan"`; `stringValue` now answers nil for it and writes a finite number with `stringValue`.
- `AccessibilityBridge.swift`: each element also emits `AXValueDescription`, read only where the element responds to `accessibilityValueDescription` (the app's own words for a value, "0:29 of 0:49"). ADE prefers it over `AXValue`.
- `AccessibilityBridge.swift`: `describeUI` returns which caps cut the walk short (`elements` 500, `depth` 80, `probe-points` 600) instead of stopping silently; the helper's `ax-describe` reply carries `truncated`, `truncatedBy` and `limits`.
- `AccessibilityBridge.swift`: `describeElement(udid:x:y:…)` answers the one element at a point and its children (one hit-test, turned back into the probe space by `frameToProbe`, the inverse of `probeToFrame`), and `focusedElement` the element with keyboard focus (`accessibilityFocusedUIElement`, else the `AXFocusedUIElement` attribute, which is what this runtime's translation answers). Both live in `AccessibilityPlacement.swift`. They back the helper's `ax-hit` and `ax-focused` commands, which `fill-element` and `type` use to read a field back cheaply.

### ADE patch for iPadOS windows (2026-10-27)

- `AccessibilityBridge.swift`: an app in an iPadOS window reports its elements relative to the window (upstream's `convertFrame` delegate passes frames through, and no attribute names the window's position), while hit-tests take screen points. `describeUI` now walks the tree recording each element's window context (`_windowContextId`), places each context with ADE's `WindowPlacement` (`ADESimHelperCore/WindowPlacement.swift`, outside `Vendor/`), moves every frame onto the screen, rebuilds the grid coverage from the moved frames and samples the grid over the window where it is. `alignToGrabber` lets the app's own resize grabber (SpringBoard's, in screen points) correct a window hanging off the screen's edge. `describeElement` and `focusedElement` place their element the same way. Elements that cannot be placed carry `ADEUnplaced`; the reply says `unplaced`. With the app filling the display (every iPhone, a full-screen iPad app) or a turned panel (the Duo's inner display), nothing changes and no extra hit-test runs.
- `AccessibilityBridge.swift` (2026-10-28): on a rigid device held sideways, hit-tests take the framebuffer's portrait points and SpringBoard's elements come back in them, while the app's elements come back in the landscape picture. `describeUI`, `describeElement` and `focusedElement` take a `ScreenTurn` (ADE's, in `WindowPlacement.swift`): screen points are turned onto the framebuffer for `objectAtPoint`, the grid samples in screen points (`toProbe`), and SpringBoard's frames (told by the element's pid's bundle, `com.apple.springboard`) are turned back onto the screen and never placed. A foldable's panels keep upstream's `probeToFrame` path. The value description is read only for adjustable roles or a numeric value off on/off controls.
