# Cursor Cloud page parity

What the plugin's page carries against ADE's compiled Cursor Cloud, surface by
surface, and what it does not. **The gaps at the bottom drive the acceptance
walk** — read them before judging the page, because each one is a thing the
owner will look for and not find.

Compiled sources this was measured against, all still in the binary:
`CursorCloudFleetModal.tsx`, `CursorCloudFleetRow.tsx`,
`CursorCloudQuickViewButton.tsx`, `CursorCloudSecretsPicker.tsx`,
`ChatCursorCloudPanel.tsx`, `useCursorCloudDraftState.ts`,
`cursorCloudFleetService.ts`, `cursorCloudFleetStatus.ts`.

## Placements

| Compiled placement | Page surface | Socket | Placement | State |
|---|---|---|---|---|
| Cursor Cloud rail tab | `fleet` | — | `tab` | Carried |
| One agent, deeplinked | `agent` | — | `tab` | Carried |
| Composer launch, Advanced | `launch` | `machine-entry` | `popover` | Carried |
| Cloud-agent chat | — | `chatRuntimes` | chat | Carried |
| Automations trigger tile | — | `automation-trigger-tile` | tile | Carried |
| Unread finished badge | — | `row-badge` | badge | Carried |
| Top-bar quick view | — | — | — | **Removed** |
| Work-rail fleet pane | — | — | — | **Removed** |
| Chat-header Cursor Cloud button | — | — | — | **Removed** |
| Command-palette fleet row | — | — | — | **Removed** |

The four removals are deliberate and are asserted by `test/index.test.js`. The
fleet is the rail tab and nothing else: a Work-rail pane was the same list a
second time in a column too narrow to read it in, and a palette row was a third
door to a tab already in the rail. A cloud chat keeps only the runtime's own
chrome, so it looks like every other chat rather than growing a header button no
other runtime has.

All three webview surfaces ship `mobile: true`. The phone draws the fleet, one
agent, and the launch form.

## Gaps

### Attaching a project secret to a launch

**The control is hidden, and it is hidden because nothing can fill it.**

The compiled composer listed every ADE project secret by name, through
`window.ade.projectSecrets.list`, and let the reader tick the ones to inject.
The page has no counterpart, and the child cannot build one:

- `sdk.secrets` reads the plugin's OWN store and reads it **one name at a
  time** — `get`, `set`, `delete`. There is no `list`.
- ADE's project secrets are a separate store. `manifest.projectSecrets` and the
  `caller.projectSecrets` field on the action bridge
  (`pluginHostService.ts:208`) are the beginning of a declared-names capability,
  but no SDK verb exposes it yet, so a plugin child cannot enumerate or read one
  today.

So `pageLaunchContext.secretNames` answers the names **this lane already
remembers**, from the plugin's own `laneSecrets` collection. That list is empty
until a launch puts something in it, and nothing can put the first name there.

`LaunchForm` therefore draws the secrets block only when that list is non-empty.
Before this, a reader on every fresh lane got a heading, a `Select all` row and
the line `No project secrets to inject.` — three controls for a choice they
could not make.

The vocabulary panel has the same gap and the same shape: it draws one toggle
per remembered name, plus a `Manage project secrets` button that opens ADE's own
Secrets settings.

**What closes it:** an SDK verb that lists the project secret NAMES a plugin
declared in `manifest.projectSecrets` and the user approved at install. Names
only — a value must never cross into a page, which is ordinary web content with
a network allowlist. When that verb exists, `pageLaunchContext` answers the
declared names instead of the remembered ones and the control comes back with no
change to the page.

### Model titles

Cursor's catalog answers ids, not titles, and ADE's `pickModel` answers
`{ modelId, fastMode }` with no label. `modelSelection.js:modelLabel` therefore
prefers a `displayName` Cursor sends and otherwise turns the id into words
(`composer-2` → `Composer 2`). A model whose id does not read as a name will
print something close to its id, which is still what the compiled chip did.

### Live status without a webhook

Cursor has no API to register a webhook, so the relay URL is pasted by hand. The
page polls while the relay is not `ready` and stops once it is. This is the
compiled behaviour, not a gap the page introduced.
