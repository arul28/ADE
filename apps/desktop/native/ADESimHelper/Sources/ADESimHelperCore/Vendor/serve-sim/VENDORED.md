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

Every file below is byte-for-byte upstream except `CaptureEngine.swift`, which
carries one documented ADE patch (see "ADE patches" below). Do not hand-edit the
verbatim files; re-vendor from a newer commit and update the table instead.

| File | SHA-256 |
|---|---|
| `AccessibilityBridge.swift` | `d3163df97c1efef3ea7aa0e45a939cfa77fa374a968e5fb7964f7f4c4630044d` |
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
