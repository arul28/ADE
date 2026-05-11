# ADE Inspector (Swift inspector kit)

ADE Inspector is the bridge that lets the iOS Simulator panel say
"the user just tapped *that* SwiftUI view, defined at this file
and line, with these accessibility tags." It runs entirely inside the
debug build of the iOS app under inspection, publishes a JSON snapshot
of every annotated view's frame to a known path inside the app's data
container, and the iOS Simulator service correlates that snapshot with
a fresh simctl screenshot to produce `IosScreenSnapshot` and
`IosElementContextItem` values.

Snapshot reads happen inside whichever runtime daemon owns the active
simulator session. Because the simulator is macOS-only, that runtime
is always a Mac (local or remote-Mac); the renderer is purely a viewer
over the resulting elements.

The kit is **DEBUG-only**: under `#if DEBUG` the modifiers attach
preference values and the snapshot host emits JSON; under release
builds both modifiers compile to a no-op so production binaries do
not carry inspector overhead or expose component metadata.

## Source file map

| Path | Role |
|---|---|
| `apps/ios/ADE/Debug/ADEInspectorKit/ADEInspectable.swift` | The whole kit: `ADEInspectablePayload`, the `ADEInspectablePreferenceKey` that aggregates per-view anchors, the `ADEInspectorSnapshotEmitter` that converts anchors to JSON, the `ADEInspectorSnapshotWriter` actor that atomically writes to disk, and the public `View.adeInspectable(...)` / `View.adeInspectorHost()` modifiers. |
| `apps/ios/ADE/App/ContentView.swift` | Calls `.adeInspectorHost()` on the root view so every screen below it can publish anchors. |
| `apps/desktop/src/main/services/ios/iosSimulatorService.ts` | `getAppContainerPath()` resolves the active bundle's data dir via `xcrun simctl get_app_container <udid> <bundleId> data`; `readInspectorSnapshot()` reads `Documents/ade-inspector-elements.json` and normalises it into `IosInspectorSnapshot` (`schemaVersion: 1`, `screen { width, height, scale }`, `elements: IosInspectableElement[]`). |
| `apps/desktop/src/shared/types/iosSimulator.ts` | `IosInspectorSnapshot`, `IosInspectableElement`, `IosInspectableFrame`, `IosScreenElement` (the unified app + accessibility row), `IosScreenSnapshot.providers[]` (which sources contributed), `IosElementContextItem` (what the chat composer ends up with). |

## Annotating views

Wrap any SwiftUI view with `.adeInspectable("componentId")`. The
modifier pulls compile-time metadata from `#fileID` and `#line` and
captures it alongside the runtime frame:

```swift
Button("Open settings") { /* ... */ }
  .adeInspectable("settingsButton", metadata: ["screen": "home"])

ForEach(items) { item in
  Row(item: item)
    .adeInspectable("itemRow", key: item.id, metadata: ["kind": item.kind])
}
```

Three argument shapes the kit cares about:

- `componentId` — the human-readable id the agent sees. The kit also
  forwards this to SwiftUI's `accessibilityIdentifier(...)`, so
  XCTest, Accessibility Inspector, and `idb ui describe-all` see the
  same name.
- `key` — disambiguator inside a list/forEach. When set, the kit
  merges it into `metadata["key"]` so the resulting element id stays
  stable and unique across siblings.
- `metadata` — free-form `[String: String]` payload. It is
  serialised verbatim and surfaces inside the chat composer chip
  alongside the source file/line.

The element id used for the snapshot is derived deterministically
from `componentId | file | line | key | sortedMetadata` (see
`adeInspectorElementId(payload:)` in `ADEInspectable.swift`). Two
views with the same `componentId` at the same source location will
collide on id unless they carry distinct keys or metadata — that is
intentional, because re-rendering the same view should write the
same id, so the desktop side does not see spurious churn.

Mount the host once, near the root of the view hierarchy, so
preference values bubble up to a single emitter:

```swift
ContentView()
  .adeInspectorHost()
```

The host is what installs the
`overlayPreferenceValue(ADEInspectablePreferenceKey.self)` that
collects every annotated view's anchor + payload into a single array
and hands it to `ADEInspectorSnapshotEmitter`.

## Snapshot pipeline (Swift side)

1. Each `.adeInspectable(...)` call adds an
   `ADEInspectableAnchor { id, payload, bounds }` to the preference
   key. `bounds: Anchor<CGRect>` is resolved against the host's
   `GeometryProxy` so the captured frame is in the host's coordinate
   space, regardless of where the view is in the hierarchy.
2. `ADEInspectorSnapshotEmitter` runs inside an
   `overlayPreferenceValue` overlay. For every anchor it:
   - Resolves the bounds via `proxy[item.bounds]`.
   - Drops zero-area, sub-4 pt edge, and out-of-screen frames
     (`minPointArea = 16`, `minPointEdge = 4`). This filters off-screen
     `ScrollView` rows and SwiftUI's invisible structural views.
   - Computes the pixel frame (`× displayScale`) so the desktop side
     does not have to know the device's screen scale.
   - Builds an `ADEInspectorElementSnapshot` and merges it into a
     full `ADEInspectorSnapshot { schemaVersion, generatedAt, screen,
     elements }`.
3. The emitter passes the snapshot through a
   `task(id: snapshotIdentity)` keyed on the JSON shape of the
   elements (`id:px:py:pw:ph` joined per element) so the underlying
   `await ADEInspectorSnapshotWriter.write(...)` only fires when the
   snapshot actually changed.
4. `ADEInspectorSnapshotWriter` is an `actor` that JSON-encodes
   the snapshot, dedupes against the last bytes it wrote, and
   atomically writes to
   `<Documents>/ade-inspector-elements.json` via
   `Data.write(to:options: [.atomic])`. The writer is a singleton so
   two hosts cannot race the file.

The on-disk schema is a small versioned envelope:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-28T12:34:56Z",
  "screen": { "width": 393.0, "height": 852.0, "scale": 3.0 },
  "elements": [
    {
      "id": "settingsButton|HomeView.swift|42|metadata-hash",
      "componentId": "settingsButton",
      "sourceFile": "HomeView.swift",
      "sourceLine": 42,
      "frame": { "x": 16.0, "y": 24.0, "width": 44.0, "height": 44.0 },
      "pixelFrame": { "x": 48.0, "y": 72.0, "width": 132.0, "height": 132.0 },
      "metadata": { "screen": "home" },
      "accessibilityIdentifier": "settingsButton"
    }
  ]
}
```

## Snapshot pipeline (Electron side)

`iosSimulatorService.readInspectorSnapshot()`:

1. Requires an `activeSession` (otherwise the call throws — there is
   no project-root fallback because the file lives inside the running
   app's data container).
2. Resolves the data container with
   `xcrun simctl get_app_container <udid> <bundleId> data`.
3. Reads `<container>/Documents/ade-inspector-elements.json`.
   `ENOENT` is normal (the bundle was not built with the kit, or the
   active screen has no annotated views) and resolves to `null`
   instead of throwing.
4. Normalises every element through `normalizeFrame`. When the Swift
   side emits a missing/zero `pixelFrame`, the desktop reconstructs
   it from `frame × screen.scale` so downstream consumers always have
   pixel-accurate rectangles.

`getScreenSnapshot({ x?, y? })` then merges three sources into the
final `IosScreenSnapshot`:

| Provider | Source | Layer | Notes |
|---|---|---|---|
| `screenshot` | `xcrun simctl io ... screenshot --type=png` | n/a | Always present. Pixel-accurate framebuffer. |
| `ade-inspector` | `readInspectorSnapshot()` | `app` | App-defined components with `componentId`/`sourceFile`/`sourceLine`. |
| `accessibility` | `idb ui describe-all --json --nested` | `accessibility` | OS accessibility tree — labels, roles, values. Best-effort; missing idb downgrades to ADE-inspector-only. |

Each element ends up as an `IosScreenElement` with a unified shape:
`source` (`ade-inspector` | `accessibility`), `layer` (`app` |
`accessibility`), `label`, `value`, `role`, `elementType`,
`identifier`, `frame`, `pixelFrame`, plus the originating
`componentId` / `sourceFile` / `sourceLine` when known.
`hitElement` is the smallest containing rectangle for the requested
(x, y), preferring `ade-inspector` matches over accessibility-only
ones (so the chat composer attaches the SwiftUI view, not the
surrounding accessibility container, when both apply).

## Selection and chat-context flow

When the user taps in inspect mode the renderer calls
`selectPoint({ x, y })`. The service:

1. Runs `getScreenSnapshot({ x, y })` to get a fresh frame +
   `hitElement`.
2. Builds an `IosElementContextItem` either from the matched
   `IosScreenElement` (preferred) or, if nothing matched, from a
   coordinate-fallback synthetic element. The item carries
   `componentId`, `sourceFile`, `sourceLine`, `frame`,
   `accessibilityIdentifier`, `metadata`, and an optional
   `screenshotDataUrl` (the same PNG that produced the hit).
3. Stores the item as `lastSelectedItem` and emits
   `{ type: "selection", item }` over `ade.iosSimulator.event`.

`AgentChatPane` listens for `selection`, stamps a fresh
`contextInstanceId` onto the item (so the same component selected
twice produces two separable chips), optionally pairs it with the
attachment that was just added (within a 10 s window), and folds it
into `iosElementContextItems`. The composer renders each item as a
chip, and on submit it serialises the chips back into the prompt
via `formatIosElementContextForPrompt` so the model receives a
structured tag containing the component id, source location, and
metadata.

## What does and does not need annotation

The kit is opt-in by design. Without `.adeInspectable(...)`:

- Selections fall through to the accessibility tree (when idb is
  installed) — labels and roles are still useful, but the agent does
  not get a source file/line.
- Accessibility-only fallback also fails (idb missing) — the renderer
  still attaches a coordinate-fallback context item carrying the
  screenshot and the hit (x, y), so the agent can reason about the
  region even without component metadata.

Annotate the views the agent is most likely to want to talk about
(buttons, navigation entry points, list rows, headline labels). Do
not annotate every container — the snapshot filter already drops
zero-area frames, but uselessly tagging structural containers
inflates the JSON and creates ambiguous hit-tests when the user taps
inside a button that lives inside an annotated card.

## Fragile and tricky wiring

- **Element id stability.** The id is computed from
  `componentId | file | line | key | sortedMetadata`. Renaming a
  metadata key, swapping line numbers via reformatting, or moving
  the `.adeInspectable` call across files all change the id. That is
  fine for the live snapshot (the desktop just sees a new element),
  but cached `IosElementContextItem`s referencing an old id will not
  re-resolve to the new view on a re-tap. Treat ids as ephemeral.
- **Hosts must be unique per scene.** Mounting `.adeInspectorHost()`
  twice in the same hierarchy causes both overlays to write to the
  same JSON path and last-writer-wins; in practice they will fight
  over the file. Mount once at the root.
- **Schema version is load-bearing.** The Electron side currently
  ignores `schemaVersion` but the field is reserved for breaking
  changes. Any layout change (frame shape, new mandatory metadata)
  must bump the version and the desktop reader must gate on it; do
  not silently extend the existing schema.
- **`#if DEBUG` is the on/off switch.** Release builds compile both
  modifiers to no-ops. The desktop side correctly reports
  `providers[ade-inspector].error: "No ADEInspector snapshot..."` in
  that case, which the chat panel surfaces as "use accessibility
  fallback" rather than failing the whole snapshot.
- **The data container path is bundle-scoped.** Every reinstall and
  every app switch invalidates the path the desktop is reading from.
  `readInspectorSnapshot` re-resolves the container on every call so
  it tolerates app re-launches, but background readers should not
  cache the path.
- **Snapshot timing.** `task(id: snapshotIdentity)` lets the writer
  skip identical frames, but it also means the on-disk file lags
  behind any view that is changing every render frame (e.g. an
  animated counter). The desktop should not assume the JSON is
  current down to the millisecond — only that it reflects the most
  recent stable layout.
