# Devices and runtimes

## Extra devices

- Need a second model too (an iPad beside an iPhone Duo)? Give the lane an
  extra device: `device-create --extra --device-type "iPad Pro 11-inch (M5)"`
  (at most 2). It comes up booted; reach it from any command with
  `--device <udid|name>` (`rotate`, `screenshot`, `snapshot`, `relaunch`,
  `tap-element`, …). Without `--device` every command still drives the lane's
  own device. ADE deletes it with the lane; `device-delete --device <udid>`
  deletes it now. `boot --device <udid>` boots an extra that is off and
  answers only once `simctl` lists it Booted.
- An extra cannot stream, record, `launch` or run tests. To put the lane's
  app on it, run `install --device <udid|name>`: it builds once into the
  lane's DerivedData (incremental, so the lane's last build is reused;
  `--no-build` installs it as is), installs, and with `--launch` starts it.
  The lane's own device, its stream and its session are not touched. To make
  an extra the lane's own device (say it already has the build and the
  sign-in), run `device-promote --device <udid|name>`. The old lane device becomes an extra,
  so nothing installed on it is lost. It is refused while the lane device is
  streaming, recording, running tests or held by another chat: stop that
  first.

## The lane's device: runtimes

Two facts that decide what you should do:

- A **runtime** is the iOS image. It is the large download (about 8 GB),
  one per iOS version, fetched only by `ade apple runtimes install` after you
  tell the user. Point releases can be narrow: iOS 27.1 runs only the iPhone
  Duo, and every other current iPhone runs on iOS 27.0.
- A **device** is an instance made from a runtime. Creating one copies no iOS,
  so it is cheap. A new lane device is empty: it copies nothing from any other
  simulator and grows only with what the lane installs. A device that is
  `Shutdown` is installed and ready — it needs a boot, which takes seconds.

So "no device free" is almost never true: one runtime serves any number of
devices, and a new one is a folder of app data, not another copy of iOS.
A new device has no sign-ins, so the app starts at its first-run state.

## Device lifecycle

- `device-create` and `device-attach` never boot (`device-create --extra` does). `device-delete` removes the
  lane's ADE device and refuses an attached device unless `--force`, which only
  detaches. Like `stop`, it is refused while another chat is driving the device.
- `device-detach` gives the device up without deleting it now. A simulator
  the user attached stays installed. A device ADE made becomes a leftover,
  and the cleanup pass deletes it 5 to 20 minutes later; the answer prints
  the time. To keep it, `device-attach --simulator <udid>` before then.
  When the user wants it kept as a free simulator, `device-detach --keep`:
  nothing deletes it then, and the user deletes it from the picker.
- ADE deletes the lane's own device, with all its data and the lane's build
  cache, when the lane is archived or deleted. An attached device is powered
  off and loses only the apps ADE installed. ADE never deletes a simulator it
  did not create.
- An ADE device that nothing uses for 30 minutes is powered off, extras too
  (`ADE_APPLE_IDLE_POWER_OFF_MINUTES` in ADE's environment changes the
  minutes; `0` turns it off). Every command that names a device counts as
  use, and so do a boot or an app install outside ADE (a raw `simctl boot` or
  `simctl install`) and a device still booting. Prefer `apple install
  --device` and `boot --device` anyway. `status` and `device-list` then say so, for example `note: ADE powered
  iPad Air 11 off after 31 min idle at 10:12; the next --device command boots
  it again.` `start` boots the lane's device again, and the next `--device`
  command boots an extra. Do not `simctl boot` it yourself.
- `runtimes` names a missing runtime by what its models need: on Xcode 27.1
  with only iOS 27.1 installed (it runs only the iPhone Duo), every other
  iPhone needs iOS 27.0, so it says `iOS 27.0`. `runtimes install --version
  <x>` for a runtime the Mac already has is refused with
  `APPLE_RUNTIME_ALREADY_INSTALLED` and the version to install instead.

## What the user sees in the desktop

Worth knowing, because it changes what is running under you.

- The tool is **Apple Development**, one pane inside the Work tools pane.
- Closing its **tab** powers the device off, behind a confirmation when the
  device is booted. Minimising the tools pane leaves it running and shows a
  floating preview.
- The rail carries Home, Rotate, Inspect, Screenshot, Record, the 3D/Flat
  view toggle, Tools and More. The drawer has four groups: Device, App,
  Capture and Preview Lab.

## Leases per device

Each device has its own lease: the lane's device, and each extra with
`--device <udid>`. The token is your turn: keep it, renew with
`lease --token <t>`, release with `lease release --token <t>`. A `lease`
without the token is a new turn and queues, even from your own chat, so
subagents of one chat take turns instead of sharing one lease. Give each
subagent a `--holder <name>` (say `--holder ui-agent`) so `lease status`
shows who has it.
