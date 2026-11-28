# DAEX Inspector (Swift inspector kit)

The inspector kit lets the Apple device pane say "the user tapped *that*
SwiftUI view, defined at this file and line." It runs inside the DEBUG build of
the iOS app under inspection, writes a JSON snapshot of every annotated view's
frame into the app's data container, and the simulator service merges it with
the helper's accessibility tree and a screenshot into `IosScreenSnapshot` and
`IosElementContextItem` values.

Snapshot reads run in the DAEX runtime that owns the simulator session, which
is always a Mac (local or remote). The renderer only views the result. See
[README.md](./README.md#live-view).

The kit is **DEBUG-only**: in release builds both modifiers compile to no-ops,
so production binaries carry no inspector overhead or component metadata.

## Source file map

| Path | Role |
|---|---|
| `apps/ios/ADE/Debug/ADEInspectorKit/ADEInspectable.swift` | The whole kit: payload, preference key, emitter, the `ADEInspectorSnapshotWriter` actor, and the `View.adeInspectable(...)` / `View.adeInspectorHost()` modifiers. |
| `apps/ios/ADE/App/ContentView.swift` | Mounts `.adeInspectorHost()` at the root. |
| `apps/desktop/src/main/services/ios/iosSimulatorService.ts` | `getAppContainerPath`, `readInspectorSnapshot` (reads `Documents/ade-inspector-elements.json`), `getScreenSnapshot`, `selectPoint`. |
| `apps/desktop/src/shared/types/iosSimulator.ts` | `IosInspectorSnapshot`, `IosScreenElement`, `IosScreenSnapshot.providers[]`, `IosElementContextItem`. |
| `apps/desktop/src/main/services/ios/iosSemanticActions.ts` | `buildElementRef` turns a `componentId` into a `component:` ref ([README.md](./README.md#semantic-actions)). |
| `apps/desktop/src/renderer/lib/visualContextFormatting.ts` | `formatIosElementContextForPrompt`: chips back into prompt text. |
| `apps/ios/ADE/Views/Duo/LiveInspect*.swift` | The phone's Live Inspect stage and composer handoff. |

## Gotchas / fragile areas

- **Element ids are ephemeral.** The id is
  `componentId | file | line | key | sorted metadata`
  (`adeInspectorElementId`). Reformatting or moving the call changes it, so a
  saved context item will not re-resolve after an edit.
- **Mount the host once.** Two hosts write the same file and fight over it.
- **`schemaVersion` is reserved.** The desktop ignores it today; any breaking
  layout change must bump it and gate the reader on it.
- **Release builds have no snapshot.** The `ade-inspector` provider then
  reports an error and the snapshot falls back to accessibility.
- **The container path is bundle-scoped** and changes on reinstall.
  `readInspectorSnapshot` re-resolves it on every call; do not cache it.
- **The file lags animation.** The writer skips identical frames, so the JSON
  reflects the latest stable layout, not every frame.

## Annotating views

```swift
Button("Open settings") { /* ... */ }
  .adeInspectable("settingsButton", metadata: ["screen": "home"])

ForEach(items) { item in
  Row(item: item)
    .adeInspectable("itemRow", key: item.id, metadata: ["kind": item.kind])
}

ContentView().adeInspectorHost()   // once, at the root
```

- `componentId`: the name the agent sees; also set as the
  `accessibilityIdentifier`, so XCTest sees the same name.
- `key`: disambiguates list siblings (merged into `metadata["key"]`).
- `metadata`: free-form `[String: String]`, shown on the chat chip.

Annotate what an agent will talk about (buttons, navigation entry points, list
rows, headlines), not structural containers: those inflate the JSON and make
hit-tests ambiguous.

## Pipeline

**Swift side.** Each annotated view adds an anchor to the preference key. The
host's emitter resolves frames in the host's space, drops tiny or off-screen
frames (`minPointArea = 16`, `minPointEdge = 4`), adds the pixel frame, and
writes only when the element signature changes. The writer actor writes
`<Documents>/ade-inspector-elements.json` atomically:

```json
{ "schemaVersion": 1, "generatedAt": "…", "screen": { "width": 393, "height": 852, "scale": 3 },
  "elements": [ { "id": "…", "componentId": "settingsButton", "sourceFile": "HomeView.swift",
    "sourceLine": 42, "frame": { … }, "pixelFrame": { … }, "metadata": { "screen": "home" },
    "accessibilityIdentifier": "settingsButton" } ] }
```

**Desktop side.** `readInspectorSnapshot` needs an active session, resolves the
container with `simctl get_app_container <udid> <bundleId> data`, treats a
missing file as `null`, and rebuilds a missing `pixelFrame` from
`frame × scale`. `getScreenSnapshot({ x?, y? })` merges three providers:

| Provider | Source | Layer |
|---|---|---|
| `screenshot` | `simctl io … screenshot` | n/a |
| `ade-inspector` | `readInspectorSnapshot()` | `app` |
| `accessibility` | helper accessibility tree | `accessibility` |

`hitElement` is the smallest rectangle containing the point, preferring
`ade-inspector` matches so the chat gets the SwiftUI view, not its container.

## Selection and chat context

In inspect mode the renderer calls `selectPoint({ x, y })`. The service takes a
fresh snapshot, builds an `IosElementContextItem` from the hit (or a coordinate
fallback carrying the screenshot), stores it as `lastSelectedItem` and emits
`{ type: "selection", item }` on `ade.iosSimulator.event`. The chat pane adds
it to `iosElementContextItems` with a fresh `contextInstanceId` (the same view
picked twice makes two chips) and saves its screenshot as an attachment. On
send, `formatIosElementContextForPrompt` writes the component id, source
location and metadata into the prompt.

### On the iOS app (Live Inspect)

The phone's viewers (Simulator, App Control, Mac Desktop) freeze the stream into
`LiveInspectStage` (layout per posture in `LiveInspectStageLayout.swift`).
Tapping an element outlines it and shows a card whose one action, **Add to
chat**, appends that element's packet to the chat draft (never sends). The
first add attaches the frozen picture; a toast offers **Undo**, which removes
exactly that add. **Done** updates the draft's picture with the markup;
**Close** skips that.

The handoff is a request and reply (`LiveInspectComposerHandoff`): the composer
answers `attached`, `removed`, `attachmentLimit` or `attachmentsUnavailable`,
and no answer within `replyWindow` is `noComposer`. Preview fixtures:
`-adePreviewScreen duo-inspect-sim` (plus `-selected`, `-markup`).
