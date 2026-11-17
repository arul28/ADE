# Apple device environment: shared names

The Apple Development tool is built (see
[docs/features/apple-device/README.md](../features/apple-device/README.md)).
Code comments point here for the error codes and the settings keys. The helper
protocol is `apps/desktop/native/ADESimHelper/Sources/ADESimHelperCore/Protocol.swift`.

## Error codes

`APPLE_NO_INSTALLED_SIMULATORS`, `APPLE_DEVICE_EXISTS`, `APPLE_DEVICE_ATTACHED_NOT_DELETABLE`,
`APPLE_RECORDING_PINNED`, `APPLE_OWNED_BY_OTHER_SESSION` (reuse existing ownership error shape),
`APPLE_HELPER_UNAVAILABLE`, `APPLE_STREAM_NOT_RUNNING`.

## Settings keys

`apple.realisticBody` (bool, default true), `apple.recordingOverlays.tapRings` (true),
`apple.recordingOverlays.keyBadges` (true), `apple.remoteBitrateKbpsCap` (number, default 2500),
`apple.recordingsWarnBytes` (number, default 5 GiB; warn only, never delete).

