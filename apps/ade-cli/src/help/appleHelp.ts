import { ADE_BANNER } from "./banner";

/** Help for each `ade apple` subcommand, by name. */
export const IOS_SIMULATOR_SUBCOMMAND_HELP: Record<string, string> = {
  status: `${ADE_BANNER}
  iOS Simulator: status

  Shows macOS support, Xcode and simulator-control readiness, the active booted device,
  and the drawer's active simulator session. Start here when a simulator action
  fails or when an agent needs to know whether ADE owns a running session.

    $ ade --socket apple status --text

  Flags:
    --text                 Compact human-readable readiness summary.
    --json                 Full JSON payload with tool install hints.
`,
  devices: `${ADE_BANNER}
  iOS Simulator: devices

  Lists available iOS simulator devices. Aliases: list, ls.

    $ ade --socket apple devices --text

  Flags:
    --text                 Compact table.
    --json                 Full device records.
`,
  apps: `${ADE_BANNER}
  iOS Simulator: apps

  Lists launchable app targets from root-level .xcodeproj bundles,
  apps/*/*.xcodeproj projects, DerivedData, and apps already installed on the
  selected simulator. Aliases: targets, launchable, launchables.

    $ ade --socket apple apps --device <udid> --text

  Flags:
    --device, --udid <id>  Simulator device to inspect.
    --project-root <path>  Root to scan; defaults to the lane worktree.
    --lane, --lane-id <id> Lane whose worktree to scan.
    --text                 Compact table with target ids.
`,
  launch: `${ADE_BANNER}
  iOS Simulator: launch

  Boots the simulator, resolves/builds/installs a target, launches the app, and
  claims the ADE drawer session. Use --socket when the drawer and agents should
  share one long-lived simulator service. Alias: open.

    $ ade --socket apple launch --target <id> --text
    $ ade --socket apple launch --bundle-id com.example.app --no-build --text

  Flags:
    --device, --udid <id>       Simulator device.
    --target, --target-id <id>  Target id from "apple apps".
    --bundle-id, --bundle <id>  Launch an installed app by bundle id.
    --app-bundle, --app <path>  Install/launch a built .app bundle.
    --project, --xcodeproj <p>  Xcode project path.
    --scheme <name>             Xcode scheme.
    --project-root <path>       Build root; defaults to the lane worktree.
    --lane, --lane-id <id>      Lane to build in and bind the session to.
    --chat-session <id>         Owner chat session for the single-owner lock.
    --no-build                  Skip xcodebuild.
    --force, -f                 Take over another chat's session; the new target
                                is validated before the owner is evicted.
    --mode snapshot|live        Inspector launch mode; default live.
    --foreground                Bring Simulator.app to the front; default is background.
    --background                Accepted, no-op: background is the default.
    --open-drawer               Also open the iOS drawer for the user.
    --follow                    Announce the wait up front; per-step progress is
                                not streamed, the summary prints at the end.
    --arg KEY=VALUE             Extra service args for advanced launch options.
`,
  proof: `${ADE_BANNER}
  iOS Simulator: proof

  Captures a simulator screenshot and files it in the chat's proof drawer.
  Alias: promote.

    $ ade --socket apple proof --caption "Settings screen after the fix" --text

  Flags:
    --caption <text>       Artifact description; also the default title.
    --title <text>         Artifact title.
    --out <path>           Screenshot path; relative to the build root.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Build root; defaults to the lane worktree.
`,
  claim: `${ADE_BANNER}
  iOS Simulator: claim

  Attributes an already-running simulator session to a lane and chat. This is
  not a step in a normal launch — "launch" claims the session itself.

  Claim rewrites the owning chat, so it is an ownership call: taking a session
  another chat owns is refused with IOS_SIMULATOR_OWNED_BY_OTHER_SESSION unless
  you say you mean it. Re-attributing only the lane never trips the guard.

    $ ade --socket apple claim --lane <lane-id> --text
    $ ade --socket apple claim --lane <lane-id> --ignore-ownership --text

  Flags:
    --lane, --lane-id <id>   Required; defaults to $ADE_LANE_ID.
    --chat-session <id>      Owner chat session; defaults to $ADE_CHAT_SESSION_ID.
    --ignore-ownership       Take a session another chat owns, deliberately. No
                             teardown: the session, its helper capture and the
                             launch lock all stay up, only the owner changes.
    --force, -f              Same bypass, spelled the way launch/shutdown spell
                             it. Unlike "shutdown --force" it resets nothing.
    --arg ignoreOwnership=true
                             The generic escape hatch; equivalent to the flags.
`,
  shutdown: `${ADE_BANNER}
  iOS Simulator: shutdown

  Stops live view state, releases the drawer session, and clears related simulator work.
  Aliases: stop, teardown, end, end-session.

  Shutdown carries the caller's chat session ($ADE_CHAT_SESSION_ID or
  --chat-session). Releasing a session owned by a different chat is refused.
  The check is cooperative — it stops accidents, not determined callers:
  --force gets through, so does --ignore-ownership (the bypass without the
  hard reset), and so does naming the owner's own chat session id, which
  "ios-sim status" reports to anyone who asks. Ask before evicting another chat.

    $ ade --socket apple shutdown --text
    $ ade --socket apple shutdown --force --text
    $ ade --socket apple shutdown --ignore-ownership --text

  Flags:
    --force, -f            Release a session owned by another chat, and hard-reset
                           the launch lock and the helper's capture with it.
    --ignore-ownership     Release a session owned by another chat without the
                           hard reset: no capture teardown, no launch-lock reset.
    --chat-session <id>    Caller chat session; defaults to $ADE_CHAT_SESSION_ID.
`,
  actions: `${ADE_BANNER}
  iOS Simulator: actions

  Lists every callable ios_simulator action exposed through ADE's generic action
  bridge. Use this when a typed subcommand is missing a niche argument.

    $ ade --socket apple actions --text
    $ ade actions run ios_simulator.getStatus --text
`,
  screenshot: `${ADE_BANNER}
  iOS Simulator: screenshot

  Captures a one-shot PNG from the simulator via simctl. Alias: capture.
  Prints the written file path; read that file instead of the data URL.

    $ ade --socket apple screenshot --out shot.png --text

  Flags:
    --out <path>           Where to write the PNG; relative to the build root.
    --device, --udid <id>  Simulator device; defaults to the active session or booted device.
    --project-root <path>  Build root; defaults to the lane worktree.
`,
  snapshot: `${ADE_BANNER}
  iOS Simulator: snapshot

  Captures screenshot + ADEInspector/accessibility elements for the current
  simulator screen. Use this before asking an agent to find the current screen
  in SwiftUI code. Aliases: screen, elements.

    $ ade --socket apple snapshot --text

  Flags:
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root for source matching.
    --arg x=<n> --arg y=<n> Optional hit-test point in screenshot pixels.
`,
  inspector: `${ADE_BANNER}
  iOS Simulator: inspector

  Reads the DEBUG ADEInspector snapshot published by the launched app. This is
  lower-level than "snapshot" and does not include screenshot/accessibility fallback.

    $ ade --socket apple inspector --text

  Flags:
    --device, --udid <id>  Simulator device.
`,
  inspect: `${ADE_BANNER}
  iOS Simulator: inspect

  Hit-tests a point and returns the best matching context item without committing
  it to the drawer composer. Aliases: hit-test, hover.

    $ ade --socket apple inspect --x 120 --y 420 --screenshot --text

  Flags:
    --x <n> --y <n>        Required screenshot-pixel coordinates.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root for Swift source matching.
    --screenshot           Include screenshot data in the context result.
`,
  "preview-status": `${ADE_BANNER}
  iOS Simulator: preview-status

  Checks Xcode Preview Lab readiness: Xcode version, mcpbridge availability,
  Xcode running state, selected project window, setup warnings, and docs URL.
  Alias: preview-doctor.

    $ ade --socket apple preview-status --source apps/ios/ADE/Views/Home.swift --line 42 --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Swift file used to bias preview discovery.
    --line <n>             Source line used to bias preview discovery.
`,
  previews: `${ADE_BANNER}
  iOS Simulator: previews

  Lists discoverable #Preview and PreviewProvider definitions, ranked around a
  selected Swift file when supplied. Aliases: preview-list, list-previews.

    $ ade --socket apple previews --source apps/ios/ADE/Views/Home.swift --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Swift file to rank nearby previews.
    --line <n>             Optional source line.
`,
  "preview-match": `${ADE_BANNER}
  iOS Simulator: preview-match

  Resolves the best Preview Lab target for the current simulator/source context.
  Aliases: match-preview, resolve-preview.

    $ ade --socket apple preview-match --source apps/ios/ADE/Views/Home.swift --line 42 --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Selected Swift file.
    --line <n>             Optional source line.
    --label <text>         Visible element label used for a suggested preview title.
    --component-id <id>    ADEInspector component id used for a suggested preview.
`,
  "preview-ensure": `${ADE_BANNER}
  iOS Simulator: preview-ensure

  Opens this lane's iOS project in Xcode when needed and waits briefly for
  Xcode MCP Preview Lab readiness. Aliases: ensure-preview, preview-workspace.

    $ ade --socket apple preview-ensure --text

  Flags:
    --project-root <path>  ADE project root.
    --source, --file <p>   Optional Swift file context.
    --line <n>             Optional source line.
    --no-open              Check readiness without opening Xcode.
    --timeout-ms <n>       Wait time for Xcode readiness; default 12000.
`,
  "preview-render": `${ADE_BANNER}
  iOS Simulator: preview-render

  Renders a SwiftUI preview through Xcode MCP and returns the snapshot path/data.
  This is the final command agents should run after finding or adding a preview.
  Aliases: render-preview, preview.

    $ ade --socket apple preview-render --source apps/ios/ADE/Views/Home.swift --index 0 --text

  Flags:
    --source, --file <p>   Required Swift source file. Absolute, project-relative,
                           or Xcode-project-relative paths are accepted.
    --index <n>            Preview definition index in the file; default 0.
    --tab, --tab-identifier <id> Xcode window tab from preview-status.
    --timeout <sec>        Render timeout, 5-240 seconds; default 120.
    --project-root <path>  ADE project root.
`,
  "preview-current": `${ADE_BANNER}
  iOS Simulator: preview-current

  Resolves and renders the Preview Lab target for the current simulator
  selection. Run "select" first, or pass --source/--line explicitly.
  Aliases: current-preview, preview-open-current, open-current-preview.

    $ ade --socket apple select --x 120 --y 420 --text
    $ ade --socket apple preview-current --text
    $ ade --socket apple preview-current --source apps/ios/ADE/Views/Home.swift --line 42 --text

  Flags:
    --source, --file <p>   Optional Swift source file; defaults to last selected element.
    --line <n>             Optional source line; defaults to last selected element.
    --label <text>         Visible element label used for a suggested preview title.
    --component-id <id>    ADEInspector component id used for a suggested preview.
    --tab, --tab-identifier <id> Xcode window tab from preview-status.
    --timeout <sec>        Render timeout, 5-240 seconds; default 120.
    --project-root <path>  ADE project root.
`,
  "preview-open": `${ADE_BANNER}
  iOS Simulator: preview-open

  Opens apps/ios/ADE.xcodeproj in Xcode so Xcode MCP Preview Lab can connect.
  Aliases: open-preview-workspace, open-xcode.

    $ ade apple preview-open --project-root <path> --text

  Flags:
    --project-root <path>  ADE project root.
`,
  "stream-start": `${ADE_BANNER}
  iOS Simulator: stream-start

  Starts ADE's live H.264 view of the device framebuffer via the vendored
  helper. No Screen Recording grant and no Simulator.app window. There is one
  encoder now, so there is no backend to choose and no second start verb.
  Boots the device first if it is off: this is an explicit start. Viewers
  (the pane, a phone) never boot and get APPLE_DEVICE_OFF instead.
  Aliases: start-stream, stream, window-start, start-window, mirror-start,
  start-mirror, preview-start, start-preview.

    $ ade --socket apple stream-start --fps 60 --text
    $ ade --socket apple stream-start --scale-factor 0.5 --bitrate-kbps 2500 --text

  Flags:
    --device, --udid <id>       Simulator device.
    --fps <n>                   Target fps.
    --scale-factor, --scale <n> Downscale 0.1 to 1. Lower sends fewer pixels.
    --bitrate-kbps <n>          Encoder bitrate cap in kilobits per second.
    --compression-quality <n>   0.1 to 1. Lower spends fewer bits.
`,
  "stream-status": `${ADE_BANNER}
  iOS Simulator: stream-status

  Shows whether the live view is active, the refresh rate, simulator control
  status, and last error.

    $ ade --socket apple stream-status --text
`,
  "stream-stop": `${ADE_BANNER}
  iOS Simulator: stream-stop

  Stops the live view without necessarily releasing the simulator session.
  Aliases: stop-stream, live-stop, stop-live.

    $ ade --socket apple stream-stop --text
`,
  select: `${ADE_BANNER}
  iOS Simulator: select

  Hit-tests a point, emits a drawer selection event, and attaches the resulting
  iOS context to the active chat composer. Use --socket so the drawer receives it.

    $ ade --socket apple select --x 120 --y 420 --text

  Flags:
    --x <n> --y <n>        Required screenshot-pixel coordinates.
    --device, --udid <id>  Simulator device.
    --project-root <path>  Project root for Swift source matching.
`,
  tap: `${ADE_BANNER}
  iOS Simulator: tap

  Sends a tap when simulator controls are available.

    $ ade --socket apple tap --x 120 --y 420 --text
    $ ade --socket apple tap 120 420 --text

  Flags:
    --x <n> --y <n>        Required point coordinates.
    --device, --udid <id>  Simulator device.
`,
  drag: `${ADE_BANNER}
  iOS Simulator: drag / swipe

  Sends a swipe to the active launched app. "swipe" is an alias of drag.

    $ ade --socket apple drag --start-x 120 --start-y 700 --end-x 120 --end-y 250 --text
    $ ade --socket apple swipe 120 700 120 250 --duration-ms 250 --text

  Flags:
    --start-x <n> --start-y <n> Required start coordinates.
    --end-x <n> --end-y <n>     Required end coordinates.
    --duration-ms <n>           Swipe duration in milliseconds.
    --device, --udid <id>       Simulator device.
`,
  type: `${ADE_BANNER}
  iOS Simulator: type

  Types text into the active launched app. Alias: text.

    $ "$ADE_CLI_PATH" apple type "hello" --text
    $ "$ADE_CLI_PATH" apple type "reddit" --submit --text
    $ "$ADE_CLI_PATH" apple type --value "hello" --text

  Flags:
    --value, --message <v> Text to type. --text <value> is also accepted for
                           compatibility, but --text by itself controls ADE's
                           human-readable output mode.
    --submit               Press Return after the text (submits a search or form).
    --device, --udid <id>  Simulator device.
`,
  key: `${ADE_BANNER}
  iOS Simulator: key

  Presses one named key on the simulator keyboard.

    $ "$ADE_CLI_PATH" apple key return --text
    $ "$ADE_CLI_PATH" apple key tab --text

  Keys: return (alias enter), tab.
  To type text and then press Return, use: apple type "<text>" --submit.

  Flags:
    --device, --udid <id>  Simulator device.
`,
  "open-device": `${ADE_BANNER}
  iOS Simulator: open-device

  Boots a simulator and opens a device session on it. Aliases: open-sim, boot.

  A device session is not an app session. It builds nothing and installs
  nothing. Use it to look at a simulator, or to drive an app that is already
  installed. Use "launch" when you want ADE to build and install your code.

  ADE shuts the device down again only when ADE booted it.

    $ ade --socket apple open-device --text
    $ ade --socket apple open-device --device <udid> --no-window --text

  Flags:
    --device, --udid <id>  Simulator device; defaults to a booted device.
    --lane, --lane-id <id> Lane to bind the device session to.
    --chat-session <id>    Owner chat session for the single-owner lock.
    --no-window            Keep the device headless; skip Simulator.app.
    --force, -f            Take a device session another chat owns.
`,
  "close-device": `${ADE_BANNER}
  iOS Simulator: close-device

  Releases this chat's device session. Alias: close-sim.

  The simulator keeps running unless ADE booted it. Pass --shutdown to shut
  down a device ADE did not boot.

  A shutdown is skipped while another chat runs an app on that device, even
  with --shutdown. Only --force goes through. --ignore-ownership does not:
  it steps around the device-session guard in your own name and nothing else.

    $ ade --socket apple close-device --text
    $ ade --socket apple close-device --shutdown --text

  Flags:
    --device, --udid <id>  Simulator device.
    --chat-session <id>    Caller chat session; defaults to $ADE_CHAT_SESSION_ID.
    --force, -f            Release a session another chat owns, and shut the
                           device down even when another chat runs an app there.
    --ignore-ownership     Skip the device-session owner check in your own name.
                           Never shuts down a device another chat is using.
    --shutdown             Shut the device down even when ADE did not boot it.
`,
  "device-session": `${ADE_BANNER}
  iOS Simulator: device-session

  Reports the device session ADE holds: which simulator, which chat owns it,
  which lane it is bound to, when it opened, and whether ADE booted the device.
  Alias: session.

  Answers null when no device session is open. "status" reports the same record
  alongside the app session and the live view; this reads it on its own.

    $ ade --socket apple device-session --text

  Flags:
    --text                 Compact human-readable record.
    --json                 Full device session record.
`,
  settings: `${ADE_BANNER}
  iOS Simulator: settings

  Reads the device's appearance, content size, accessibility options, last set
  location, and status bar override state. Alias: device-settings.

  simctl cannot read a location or a status bar back. Those two fields report
  what ADE last set in this process, and reset when the runtime restarts.

    $ ade --socket apple settings --text

  Flags:
    --device, --udid <id>  Simulator device.
`,
  appearance: `${ADE_BANNER}
  iOS Simulator: appearance

  Switches the device between light and dark mode. Runs "simctl ui appearance".

    $ ade --socket apple appearance dark --text
    $ ade --socket apple appearance --appearance light --text

  Flags:
    --appearance light|dark  Appearance to set; a positional value works too.
    --device, --udid <id>    Simulator device.
`,
  "content-size": `${ADE_BANNER}
  iOS Simulator: content-size

  Sets the Dynamic Type size. Runs "simctl ui content_size". Alias: text-size.

    $ ade --socket apple content-size accessibility-extra-large --text

  Flags:
    --content-size, --size <name>  Size to set; a positional value works too.
                                   Values: extra-small, small, medium, large,
                                   extra-large, extra-extra-large,
                                   extra-extra-extra-large, accessibility-medium,
                                   accessibility-large, accessibility-extra-large,
                                   accessibility-extra-extra-large,
                                   accessibility-extra-extra-extra-large.
    --device, --udid <id>          Simulator device.
`,
  accessibility: `${ADE_BANNER}
  iOS Simulator: accessibility

  Turns one accessibility option on or off. Alias: a11y.

  Only increase-contrast is a "simctl ui" option. ADE writes the rest to
  com.apple.Accessibility and then posts a notifyutil notification, because a
  preference written without the notification is read by nothing until the app
  relaunches.

    $ ade --socket apple accessibility reduce-motion on --text
    $ ade --socket apple a11y --option bold-text --off --text

  Flags:
    --option <name>        Option to set; a positional value works too. Values:
                           increase-contrast, reduce-motion, reduce-transparency,
                           button-shapes (Show Borders), bold-text, invert-colors,
                           grayscale, voice-over.
    --on, --off            State to set; positional on/off works too.
    --device, --udid <id>  Simulator device.
`,
  location: `${ADE_BANNER}
  iOS Simulator: location

  Sets or clears the simulated GPS location. Runs "simctl location".

    $ ade --socket apple location 37.7749 -122.4194 --text
    $ ade --socket apple location --latitude 37.7749 --longitude -122.4194 --text
    $ ade --socket apple location --clear --text

  Flags:
    --latitude, --lat <n>  Latitude, -90 to 90; a positional value works too.
    --longitude, --lon <n> Longitude, -180 to 180; a positional value works too.
    --clear                Clear the override instead of setting one.
    --device, --udid <id>  Simulator device.
`,
  permission: `${ADE_BANNER}
  iOS Simulator: permission

  Grants, revokes, or resets one privacy permission. Runs "simctl privacy".
  Alias: privacy.

  A reset takes the whole service back to its default and needs no bundle id.
  A grant or a revoke acts on one app and needs one.

    $ ade --socket apple permission grant photos --bundle-id com.example.app --text
    $ ade --socket apple privacy reset location --text

  Flags:
    --action <name>        grant, revoke, or reset; a positional works too.
    --service <name>       Privacy service; a positional works too. Values: all,
                           calendar, contacts-limited, contacts, location,
                           location-always, photos-add, photos, media-library,
                           microphone, motion, reminders, siri.
    --bundle-id <id>       App to act on; required for grant and revoke.
    --device, --udid <id>  Simulator device.
`,
  push: `${ADE_BANNER}
  iOS Simulator: push

  Sends an APNs notification to an installed app. Runs "simctl push".

  Pass --title and --body for a simple alert. Pass --payload for a full APNs
  body. ADE fills aps.alert in from --title and --body when the payload omits
  it. The payload file is deleted after the send.

    $ ade --socket apple push --bundle-id com.example.app --title Hi --body "You have mail" --text
    $ ade --socket apple push --bundle-id com.example.app --payload '{"aps":{"badge":3}}' --text

  Flags:
    --bundle-id <id>       Required target app.
    --title <text>         Alert title.
    --body <text>          Alert body.
    --payload <json>       APNs payload as a JSON object string.
    --device, --udid <id>  Simulator device.
`,
  "open-url": `${ADE_BANNER}
  iOS Simulator: open-url

  Opens a URL or a deeplink on the device. Runs "simctl openurl".

    $ ade --socket apple open-url myapp://settings --text

  Flags:
    --url <url>            URL to open; a positional value works too.
    --device, --udid <id>  Simulator device.
`,
  terminate: `${ADE_BANNER}
  iOS Simulator: terminate

  Stops a running app on the device. Runs "simctl terminate". Alias: kill-app.

    $ ade --socket apple terminate --bundle-id com.example.app --text

  Flags:
    --bundle-id <id>       Required app to stop.
    --device, --udid <id>  Simulator device.
`,
  relaunch: `${ADE_BANNER}
  iOS Simulator: relaunch

  Restarts the app that is already installed. Runs "simctl terminate" and then
  "simctl launch". It does not build. Use "launch" to see a code change; use
  this to see the app from its first screen again.

    $ ade --socket apple relaunch --bundle-id com.example.app --text

  Flags:
    --bundle-id <id>       Required app to restart.
    --device, --udid <id>  Simulator device.
`,
  uninstall: `${ADE_BANNER}
  iOS Simulator: uninstall

  Removes an app and its container from the device. Runs "simctl uninstall".
  Use it to prove a first-run flow.

  This is the one guarded device tool. It refuses a caller that is not the chat
  holding the device session. Name your chat with --chat-session, or take it
  anyway with --force.

    $ ade --socket apple uninstall --bundle-id com.example.app --text

  Flags:
    --bundle-id <id>       Required app to remove.
    --chat-session <id>    The chat asking. Defaults to $ADE_CHAT_SESSION_ID.
    --force                Uninstall even when another chat holds the device.
    --device, --udid <id>  Simulator device.
`,
  "status-bar": `${ADE_BANNER}
  iOS Simulator: status-bar

  Overrides or clears the status bar. Runs "simctl status_bar". Set 9:41 and
  full bars before a screenshot so the shot stays stable.

    $ ade --socket apple status-bar --time 9:41 --wifi-bars 3 --battery-level 100 --text
    $ ade --socket apple status-bar --clear --text

  Flags:
    --time <text>          Displayed time, such as 9:41.
    --data-network <name>  Network label, such as wifi or 5g.
    --wifi-bars <n>        Wi-Fi bars, 0 to 3.
    --cellular-bars <n>    Cellular bars, 0 to 4.
    --battery-level <n>    Battery percentage, 0 to 100.
    --battery-state <name> charging, charged, or discharging.
    --clear                Remove the override instead of setting one.
    --device, --udid <id>  Simulator device.
`,
  "app-state": `${ADE_BANNER}
  iOS Simulator: app-state

  Reports whether an app runs right now, and its pid. Reads "launchctl list"
  on the device. A shut down device answers "not running" rather than failing.

    $ ade --socket apple app-state --bundle-id com.example.app --text

  Flags:
    --bundle-id <id>       Required app to check.
    --device, --udid <id>  Simulator device.
`,
  "log-start": `${ADE_BANNER}
  iOS Simulator: log-start

  Starts the device event log. Alias: logs-start.

  ADE streams "log stream" from the device and interleaves its own actions in
  the same order, so the log shows what ADE did between two app log lines.

    $ ade --socket apple log-start --bundle-id com.example.app --text

  The log follows one app. "log stream" reads the whole device, so a run with
  no bundle id returns every other app's rows and the system's besides.

  There is one log process per host, so this is refused for a chat that owns
  neither half of the simulator, and refused again for a chat that did not
  start the log already running — a stake in the simulator is not a stake in
  the log. A log nobody started is free to take.

  Flags:
    --device, --udid <id>  Simulator device.
    --bundle-id <id>       Required. Keep only rows from this app.
    --chat-session <id>    Caller chat session; defaults to $ADE_CHAT_SESSION_ID.
    --force, -f            Start it anyway: skips both checks and takes over a
                           log another chat started.
`,
  "log-stop": `${ADE_BANNER}
  iOS Simulator: log-stop

  Stops the device event log and returns the final page. Alias: logs-stop.

  There is one log process per host, so the chat that started the running log
  is the only one that can stop it. Owning the device session or the app
  session is not enough on its own.

    $ ade --socket apple log-stop --text

  Flags:
    --chat-session <id>    Caller chat session; defaults to $ADE_CHAT_SESSION_ID.
    --force, -f            Stop a log another chat started.
`,
  log: `${ADE_BANNER}
  iOS Simulator: log

  Reads buffered event log rows. Alias: logs.

  Each page returns a cursor. Pass it back as --since to read only new rows.
  The page also reports how many rows the ring dropped since the last read.

    $ ade --socket apple log --limit 100 --text
    $ ade --socket apple log --since 412 --text

  Flags:
    --device, --udid <id>  Simulator device.
    --since, --since-id <n> Return only rows after this id.
    --limit <n>            Maximum rows to return.
`,
  "find-element": `${ADE_BANNER}
  iOS Simulator: find-element

  Finds one on-screen element by query and reports how many matched. Alias:
  find. Run "snapshot" first to read the available refs, labels, and roles.

  A query is a claim about the app, such as "the button labelled Continue".
  A coordinate tap is a guess that the layout did not move.

    $ ade --socket apple find-element --label Continue --text
    $ ade --socket apple find --role Button --index 1 --text

  Flags:
    --ref <id>             Element ref from the last snapshot.
    --identifier <id>      Accessibility identifier.
    --label <text>         Exact accessibility label.
    --text <text>          Case-insensitive substring of the label or value.
                           --text-match spells the same thing unambiguously.
    --role <name>          Element role, such as Button or TextField.
    --index <n>            Which match to take when several match.
    --device, --udid <id>  Simulator device.
    --lane, --lane-id <id> Lane whose worktree backs source matching.
    --project <path>       Project root for source matching.
`,
  "tap-element": `${ADE_BANNER}
  iOS Simulator: tap-element

  Taps the element the query names. Prefer this over a coordinate tap: it
  fails loudly when the element is gone, where a coordinate tap hits whatever
  moved into that spot.

    $ ade --socket apple tap-element --label Continue --text
    $ ade --socket apple tap-element --identifier signup-submit --text

  Flags:
    Same element query as "find-element": --ref, --identifier, --label, --text,
    --role, --index, --device, --lane, --project.
`,
  "fill-element": `${ADE_BANNER}
  iOS Simulator: fill-element

  Taps a text field and types into it. Alias: fill.

    $ ade --socket apple fill-element --identifier email-field --value ada@example.com --text
    $ ade --socket apple fill --label Email "ada@example.com" --text

  Flags:
    --value <text>         Text to type; a positional value works too.
    --no-focus             Type without tapping the field first.
    Same element query as "find-element": --ref, --identifier, --label, --text,
    --role, --index, --device, --lane, --project.
`,
  "wait-for-element": `${ADE_BANNER}
  iOS Simulator: wait-for-element

  Waits until an element appears, or disappears with --gone. Alias: wait-for.
  Use it after a tap instead of a fixed sleep.

    $ ade --socket apple wait-for-element --label Welcome --timeout-ms 8000 --text
    $ ade --socket apple wait-for --label Spinner --gone --text

  Flags:
    --timeout-ms <n>       Wait budget; defaults to 5000 and caps at 60000.
    --gone                 Wait for the element to disappear.
    Same element query as "find-element": --ref, --identifier, --label, --text,
    --role, --index, --device, --lane, --project.
`,
  "assert-visible": `${ADE_BANNER}
  iOS Simulator: assert-visible

  Checks that an element is on screen right now. Alias: assert. Use it as the
  last step of a flow so the result states what was proven.

    $ ade --socket apple assert-visible --label "Order confirmed" --text

  Flags:
    Same element query as "find-element": --ref, --identifier, --label, --text,
    --role, --index, --device, --lane, --project.
`,
  "proof-bundle": `${ADE_BANNER}
  iOS Simulator: proof-bundle

  Captures a screenshot plus the metadata a reviewer asks for. The bundle names
  the machine, the device, the build root, the elements on screen, and the
  recent event log rows. A bare PNG answers none of that.

  The bundle leaves "log.json" out when the event log follows a different
  device from the one captured, and records the reason in the metadata rather
  than pairing one device's shot with another device's rows.

    $ ade --socket apple proof-bundle --caption "Signup succeeds" --text
    $ ade --socket apple proof-bundle --out .ade/tmp/proof --log-rows 200 --text

  Flags:
    --out <path>           Directory to write into; relative to the build root.
    --caption <text>       One line describing what the shot proves.
    --no-elements          Skip the element dump.
    --log-rows <n>         Event log rows to include.
    --device, --udid <id>  Simulator device.
    --lane, --lane-id <id> Lane whose worktree to resolve.
    --project <path>       Project root for source matching.
`,
  "device-create": `${ADE_BANNER}
  Apple device: device-create

  Clones an installed simulator for this lane. With no --from, uses the
  project's last-used installed simulator, else the newest installed iPhone.
  Never downloads a runtime. Fails with APPLE_NO_INSTALLED_SIMULATORS when
  none are installed (open Xcode ▸ Settings ▸ Components).

    $ ade --socket apple device-create --text
    $ ade --socket apple device-create --from "iPhone 17" --name "iPhone 17 — lane-ab3" --text

  Flags:
    --from, --simulator <id>  Installed simulator to clone (udid or name).
    --name <name>             Clone name; defaults to "<source> — <lane>".
    --lane, --lane-id <id>    Lane that will own the clone.
`,
  "device-attach": `${ADE_BANNER}
  Apple device: device-attach

  Binds an existing installed simulator to this lane without cloning. ADE
  never deletes an attached simulator.

    $ ade --socket apple device-attach --simulator <udid|name> --text

  Flags:
    --simulator, --device, --udid <id>  Required installed simulator.
    --lane, --lane-id <id>              Lane to bind.
`,
  "start": `${ADE_BANNER}
  Apple device: start

  Brings the lane's device up in one step: attaches (or clones, with
  --create) when the lane owns no device yet, boots it if it is shut down,
  waits for simctl bootstatus, then starts the live view. Progress arrives
  as apple.device.state events (starting → booted → streaming). Unlike
  device-attach and device-create, this boots.

    $ ade --socket apple start --text
    $ ade --socket apple start --udid <udid> --text
    $ ade --socket apple start --create <sourceUdid> --text

  Flags:
    --udid, --simulator, --device <id>  Installed simulator to attach when the lane has none.
    --create <sourceUdid>               Clone this installed simulator for the lane instead.
    --lane, --lane-id <id>              Lane that owns (or will own) the device.
`,
  "device-list": `${ADE_BANNER}
  Apple device: device-list

  Lists installed simulators and/or the one device this lane owns.

    $ ade --socket apple device-list --installed --text
    $ ade --socket apple device-list --text

  Flags:
    --installed            Installed simulators for a picker. ADE never downloads one.
    --lane, --lane-id <id> The lane whose device to report; defaults to $ADE_LANE_ID.
`,
  "device-delete": `${ADE_BANNER}
  Apple device: device-delete

  Deletes this lane's cloned simulator. Attached devices refuse unless --force,
  and --force only detaches them — ADE never deletes a simulator it did not create.

    $ ade --socket apple device-delete --text
    $ ade --socket apple device-delete --force --text

  Flags:
    --force, -f            Detach an attached device instead of refusing.
    --lane, --lane-id <id> Lane whose device to delete.
`,
  "record-start": `${ADE_BANNER}
  Apple device: record-start

  Starts a manual recording of the device framebuffer. Overlays (tap rings and
  typed-text badges) follow Settings unless --overlays is passed. Starting
  while an auto recording is running converts it to manual (no restart, no gap).

  Still time is cut: a still screen longer than 2 s keeps 0.75 s in the video.
  record-stop reports durationMs (video), wallDurationMs (real time) and
  idleCutMs. A recording a chat owns stops itself after 10 minutes of real
  time (stopReason "cap") and is filed as proof.

    $ ade --socket apple record-start --text
    $ ade --socket apple record-start --overlays off --label "signup" --text
    $ ade --socket apple record-start --keep-idle --max-seconds 1200 --text

  Flags:
    --overlays on|off      Overlay compositor; default is Settings.
    --label <text>         Human label for the recording.
    --keep-idle            Keep still stretches at real length.
    --max-seconds <n>      Stop after n seconds of real time (default 600).
    --lane, --lane-id <id> Lane whose device to record.
`,
  "record-stop": `${ADE_BANNER}
  Apple device: record-stop

  Stops the running recording. --discard is only allowed for a recording this
  chat owns that is not marked proof.

    $ ade --socket apple record-stop --text
    $ ade --socket apple record-stop --keep --text
    $ ade --socket apple record-stop --discard --text

  Flags:
    --keep                 Keep the file (default).
    --discard              Delete the file; refused for proof-pinned recordings.
    --lane, --lane-id <id> Lane whose recording to stop.
`,
  "record-list": `${ADE_BANNER}
  Apple device: record-list

  Lists recordings for this lane. There is no auto-delete.

    $ ade --socket apple record-list --text

  Flags:
    --lane, --lane-id <id> Lane whose recordings to list.
`,
  "record-delete": `${ADE_BANNER}
  Apple device: record-delete

  Deletes a recording this chat owns that is not marked proof. Anything else
  is refused with APPLE_RECORDING_PINNED.

    $ ade --socket apple record-delete --id <id> --text

  Flags:
    --id <id>              Recording id from record-list.
    --force, -f            Take a recording another chat owns, if the service allows.
    --lane, --lane-id <id> Lane that owns the recording.
`,
  frame: `${ADE_BANNER}
  Apple device: frame

  Grabs one decoded frame from the running stream. Cheaper than screenshot,
  which round-trips simctl. Fails with APPLE_STREAM_NOT_RUNNING when no stream
  is active; screenshot does not need one.

    $ ade --socket apple frame --text
    $ ade --socket apple frame --out shot.png --text

  Flags:
    --out, --out-path <p>  File path; relative to the build root.
    --lane, --lane-id <id> Lane whose stream to read.
`,
  button: `${ADE_BANNER}
  Apple device: button

  Presses a hardware button through the vendored helper. Shake is named so
  the column can call it, but this Xcode's simctl has no shake verb and the
  helper does not implement it — the service refuses with
  APPLE_BUTTON_UNSUPPORTED.

    $ ade --socket apple button home --text
    $ ade --socket apple button volume-up --text
    $ ade --socket apple button app-switcher --text

  Names: home, lock, volume-up, volume-down, siri, shake, app-switcher.

  app-switcher is Simulator's own App Switcher command: two home presses
  150 ms apart, sent by the helper as one command. To close an app the way a
  person does, open the switcher, then swipe the app's card up (see the
  ade-apple skill). "apple terminate --bundle-id <id>" stops an app without
  showing anything.

  Flags:
    --name, --button <n>   Button name; also accepted as the next positional.
    --device, --udid <id>  Simulator device.
    --lane, --lane-id <id> Lane whose device to press.
`,
  show: `${ADE_BANNER}
  Apple device: show

  Puts this chat's Apple device on the user's screen: the Apple tool in the
  tools pane, or the floating player with --floating. Same as "ade ui show
  apple" / "ade ui show floating-apple".

    $ ade apple show --text
    $ ade apple show --floating --text

  Prints shown, held (a window has the project open but not this chat; it opens
  when the user goes to the chat) or no_desktop (nothing was shown; exits 1).

  Flags:
    --floating             Show the floating player instead of the pane.
    --session <id>         Chat to show it in. Defaults to ADE_CHAT_SESSION_ID.
`,
  rotate: `${ADE_BANNER}
  Apple device: rotate

  Turns the device, then reads the screen to see whether it moved.

    $ ade --socket apple rotate landscape-left --text
    $ ade --socket apple rotate --orientation portrait --text

  Orientations: portrait, portrait-upside-down, landscape-left, landscape-right.

  applied means the framebuffer was SEEN on the requested axis, not that an
  event was sent. iOS always takes the device orientation; the app on screen
  decides whether to follow it. The Home Screen and Settings are portrait-only
  on an iPhone, and no iPhone supports portrait upside down, so a rotate with
  one of those in front answers applied false with reason
  APPLE_ROTATE_NOT_ADOPTED. Turning within one axis (the two portraits, or the
  two landscapes) leaves the pixel size unchanged and reports
  verification already-on-axis, which does not confirm the exact side.

  Flags:
    --orientation <o>      Orientation; also accepted as the next positional.
    --device, --udid <id>  Simulator device.
    --lane, --lane-id <id> Lane whose device to rotate.
`,
};

/** Subcommand aliases that share another subcommand's help page. */
export const IOS_SIMULATOR_HELP_ALIASES: Record<string, string> = {
  list: "devices",
  ls: "devices",
  targets: "apps",
  launchable: "apps",
  launchables: "apps",
  open: "launch",
  teardown: "shutdown",
  end: "shutdown",
  "end-session": "shutdown",
  capture: "screenshot",
  promote: "proof",
  screen: "snapshot",
  elements: "snapshot",
  "hit-test": "inspect",
  hover: "inspect",
  "preview-doctor": "preview-status",
  "preview-list": "previews",
  "list-previews": "previews",
  press: "button",
  "press-button": "button",
  reveal: "show",
  orientation: "rotate",
  "match-preview": "preview-match",
  "resolve-preview": "preview-match",
  "ensure-preview": "preview-ensure",
  "preview-workspace": "preview-ensure",
  "render-preview": "preview-render",
  preview: "preview-render",
  "current-preview": "preview-current",
  "preview-open-current": "preview-current",
  "open-current-preview": "preview-current",
  "render-current-preview": "preview-current",
  "open-preview-workspace": "preview-open",
  "open-xcode": "preview-open",
  "start-stream": "stream-start",
  stream: "stream-start",
  "window-start": "stream-start",
  "start-window": "stream-start",
  "mirror-start": "stream-start",
  "start-mirror": "stream-start",
  "preview-start": "stream-start",
  "start-preview": "stream-start",
  "stop-stream": "stream-stop",
  "live-stop": "stream-stop",
  "stop-live": "stream-stop",
  "preview-stop": "stream-stop",
  "stop-preview": "stream-stop",
  swipe: "drag",
  text: "type",
  "open-sim": "open-device",
  boot: "open-device",
  "close-sim": "close-device",
  session: "device-session",
  "device-settings": "settings",
  "text-size": "content-size",
  a11y: "accessibility",
  privacy: "permission",
  "kill-app": "terminate",
  "restart-app": "relaunch",
  "logs-start": "log-start",
  "logs-stop": "log-stop",
  logs: "log",
  find: "find-element",
  fill: "fill-element",
  "wait-for": "wait-for-element",
  assert: "assert-visible",
};
