# Driving details

## Element queries

- When several elements match, the answer says which one it used and why,
  lists the others with their points, and names the `--index` that picks the
  next. A control that holds the matching text wins over the text inside it.
- A row marked `(inferred)` is a SwiftUI tab ADE placed from source because
  the Tab Bar showed no tab items. Its frame is a guess, so `tap-element`
  refuses it and prints the point to `tap` instead. A real tab item carries
  its source file and line.
- `snapshot` says `truncated` when the accessibility walk hit its cap
  (500 elements, depth 80, 600 probe points). Elements past it are missing
  from `find` and `tap-element` too; scroll or open the part you need, then
  snapshot again.

## Close an app the way a person does

Bottom-edge swipes do not work: the helper sends them as ordinary touches, so
iOS never sees the home-indicator gesture, and a swipe from the bottom edge
opens nothing. Use the App Switcher instead.

```bash
"$ADE_CLI_PATH" apple button app-switcher --text
"$ADE_CLI_PATH" apple screenshot --out switcher.png --text   # check it opened
"$ADE_CLI_PATH" apple swipe 201 480 201 80 --duration-ms 150 --text
"$ADE_CLI_PATH" apple button home --text
```

- Coordinates are points. Read the screen size from `apple stream-status`
  (`screen points` in `--text`, `pointWidth` × `pointHeight` in `--json`).
  Both are empty while no stream runs; then read `screen` from `apple
  snapshot` (`402x874 @3x`), which needs no stream. The example is an
  iPhone 16 Pro (402 × 874).
- The front app's card sits in the middle of the switcher. Swipe it up from
  about (W/2, 0.55 H) to (W/2, 0.09 H), fast: 150 ms. A slow drag only lifts
  the card.
- Take a screenshot after `app-switcher`. If the switcher is not showing, do
  not keep swiping: say so, and use `apple terminate --bundle-id <id>` to stop
  the app without showing it (Safari is `com.apple.mobilesafari`).
- While a recording runs, every failed try is in the video. Check the screen
  after each step instead of repeating a gesture.
