# Troubleshooting

## Error codes

Three more (`APPLE_DEVICE_NOT_LANE_OWNED`, the `--out` path rule, and
`--text` against `--text-match`) are under Gotchas in SKILL.md.

- `APPLE_NO_INSTALLED_SIMULATORS` — no installed runtime. `ade apple runtimes`
  shows what this Xcode needs; tell the user, then `ade apple runtimes install`
  (about 8 GB, in the background). Never download one without telling them.
- `APPLE_HELPER_UNAVAILABLE` — no usable helper on that Mac: missing (the message lists where ADE looked) or from another ADE version. Tell the user; updating ADE.app or the brain fixes it.
  `status` → `tools.helper.present` is the check.
- `APPLE_STREAM_NOT_RUNNING` — `frame` needs a live stream; use `screenshot`.
- `APPLE_DEVICE_OFF` — the lane's device is powered off, and watching never
  boots it. `apple start` (or `stream-start`) powers it on.
- `APPLE_ROTATE_NOT_ADOPTED` — the device turned and the app on screen did
  not. Launch a landscape-capable app first; it is not a fault to report.
- `APPLE_ROTATE_UNMEASURABLE` — the screen could not be read, so the rotation
  is unconfirmed either way. Check the device is still booted.
- `APPLE_BUTTON_UNSUPPORTED` — that button has no helper or `simctl`
  equivalent. Today: `shake`.
- `APPLE_DEVICE_ATTACHED_NOT_DELETABLE` — `device-delete` without `--force` on
  an attached simulator. `--force` detaches; it does not delete.
- `APPLE_DEVICE_EXISTS` — this lane already owns a device. Use it, remove it
  first, or add another model beside it with `device-create --extra`.
- `APPLE_EXTRA_DEVICE_LIMIT` — the lane already has 2 extra devices. Delete
  one with `device-delete --device <udid>`.
- `APPLE_DEVICE_IS_EXTRA` — that command needs the lane's own device and you
  named an extra. For a build on the extra, `install --device <udid>
  --launch`; or run the `device-promote --device <udid>` the message prints
  to make the extra the lane's device.
- `APPLE_LANE_DEVICE_BUSY` — `device-promote` found the lane's device
  streaming, recording, testing, launching or leased. Finish or stop that, then
  promote again.
- `APPLE_RUNTIME_NOT_INSTALLED` — the runtime or model you named is not on
  this Mac. The message lists what is; ADE never downloads one.
- `APPLE_RUNTIME_ALREADY_INSTALLED` — `runtimes install --version` named a
  runtime the Mac has. The message names the version the missing models need.
- `APPLE_BUILD_BUSY` — a launch, a test run or an `install` is already
  building in the lane's DerivedData. Wait for it, then run again.
- `APPLE_WINDOWING_UNAVAILABLE` — `window` found no resizable window; see
  `references/ipad-windows.md`.
- `APPLE_TEST_RUN_BUSY` — another `apple test` is running. Wait and run again.
- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` — re-run `"$ADE_CLI_PATH" apple apps --text`.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET` — pass `--target-id` or `--bundle-id`
  only when you deliberately want the installed app.
