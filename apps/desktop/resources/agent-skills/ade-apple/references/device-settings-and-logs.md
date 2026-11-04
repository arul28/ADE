# Device settings, log, previews

```bash
"$ADE_CLI_PATH" apple appearance dark --text
"$ADE_CLI_PATH" apple accessibility reduce-motion on --text
"$ADE_CLI_PATH" apple location 37.7749 -122.4194 --text
"$ADE_CLI_PATH" apple permission grant photos --bundle-id <id> --text
"$ADE_CLI_PATH" apple push --bundle-id <id> --title Hi --body "You have mail" --text
"$ADE_CLI_PATH" apple log-start --bundle-id <id> --text   # then: apple log --text
"$ADE_CLI_PATH" apple preview-current --text
```

`log-start` keeps the app's own process (its installed executable) and the
bundle id's `os_log` subsystem. If the app logs under another subsystem, add
`--subsystem <prefix>`; `--process <name>` follows another process. `print()`
never reaches the device log. When no app line has arrived after a few
seconds, `apple log` says so with a hint. ADE's own rows name the device they
drove, so the log of one device leaves out taps on the lane's other devices.

Also `content-size`, `status-bar`, `open-url`, `relaunch`, `terminate`,
`uninstall`, `app-state`, `log`, `log-stop`, `preview-status`, `previews`,
`preview-match`, `preview-ensure`, `preview-render`.

## Live view

```bash
"$ADE_CLI_PATH" apple stream-start --fps 60 --text
"$ADE_CLI_PATH" apple stream-start --scale-factor 0.5 --bitrate-kbps 2500 --text
"$ADE_CLI_PATH" apple stream-status --text
"$ADE_CLI_PATH" apple stream-stop --text
```

`stream-status` reports the shape and never the address or the token. A status
of `running: true` means the capture is alive, not that a picture is arriving.
