# Android resources

## `scrcpy-server`

The device half of scrcpy. The brain pushes it to an emulator and starts it
with `app_process`. It encodes the screen as H.264 and takes touch and key
input. ADE's own client code is in
`apps/desktop/src/main/services/android/scrcpy*.ts`.

| Field | Value |
|---|---|
| Upstream | https://github.com/Genymobile/scrcpy |
| Version | 3.3.4 (tag `v3.3.4`, released 2025-12-17) |
| File | release asset `scrcpy-server-v3.3.4`, unchanged |
| SHA-256 | `8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e` |
| Licence | Apache License 2.0, full text in `scrcpy-LICENSE` |

Copyright (C) 2018 Genymobile
Copyright (C) 2018-2025 Romain Vimont

The server refuses a client that names another version. The version and the
checksum are also in `scrcpyServer.ts` (`SCRCPY_SERVER_VERSION`,
`SCRCPY_SERVER_SHA256`), and the brain checks the file against the checksum
before it pushes it. To change the version:

1. Download the new `scrcpy-server-v<version>` asset and check it against the
   release's `SHA256SUMS.txt`.
2. Replace this file, the table above and the two constants.
3. Read the protocol changes for that tag (`doc/develop.md`,
   `app/src/demuxer.c`, `app/src/control_msg.c`, `server/.../Options.java`)
   and update the client.
4. Run the stream on a real emulator before you merge.

The upstream repository has no NOTICE file.
