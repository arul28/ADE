# ADE Attention Notch design notes

The helper is a clean ADE implementation built on public macOS AppKit and
SwiftUI APIs. No source from T3Notch was copied because that repository did not
publish a license when this implementation was created.

Interaction and geometry research included these permissively licensed projects:

- [DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit) — MIT
- [OpenNook](https://github.com/MrKai77/OpenNook) — MIT
- [CodeIsland](https://github.com/norech/CodeIsland) — MIT
- [codex-island](https://github.com/jordond/codex-island) — MIT

The ADE implementation owns its protocol, state reducer, panel geometry, hit
testing, view hierarchy, animations, and particle rendering. These repositories
are design references only and are not bundled dependencies.

Provider marks are adapted from the MIT-licensed LobeHub Lobe Icons package.
Only the five SVGs used by the helper are bundled. See
`THIRD_PARTY_NOTICES.md` for attribution and license terms.

## Physical-notch geometry

The surface is anchored to the top of the display and its top edge is **square
and flush** (`notchSurfaceCorners(...).top == 0`) in every state. Its top
`notchMenuBarBandHeight(safeAreaTop:)` points sit inside the menu-bar strip, so
compact ends exactly on the hardware cutout's bottom edge and the two blacks
read as one wider notch.

Two failure modes this replaced, both visible in production screenshots:

- **Bitten out.** The old outline started the side "ears" ~15pt below the
  display edge and curved into the cutout, leaving a sliver of wallpaper above
  each ear so the hardware notch appeared to jut out of a floating slab.
- **Blended away.** A pure-black fill is invisible against the dark menu bar of
  a full-screen window, leaving text floating with no container. Only the band
  is black; below it the surface uses ADE's `--color-card` → `--color-bg`
  gradient, and the contour carries a hairline washed with the current phase
  tone.

Colours, type scale and phase vocabulary mirror the renderer's Attention
surfaces (`index.css` tokens, `activityPresentation.ts`, the
`.attention-tone-*` palette) so a phase reads identically in the notch, the
header control and the Attention center. `NotchSurfaceShape` and
`NotchPanelController.interactivePath` are built from the same corner metrics
and the same tangent-arc construction, so the click region cannot drift from
the drawn outline.

Zero items and an unhealthy stream are states, not absences. A physical-notch
surface stays present and renders `notchStatusPresentation(...)`; on a Mac
without a cutout, the always-available menu-bar item conveys the stream state
and exposes the same detail on hover or click.

## Macs without a physical notch

A non-notch display does not imitate hardware it does not have. The resting
surface is a native `NSStatusItem` using ADE's canonical shipped app icon with a
small state dot. Hover/click transitions open the existing surface directly
beneath that item, clamped so its visible content remains on-screen and always
below the menu bar. The transparent hosting panel is ordered out in the compact
state, so there is no centered floating slab or invisible center-screen hover
target. Right-click continues to open the settings/context menu, including the
confirmed full-hide action.

## Presentation modes

Two, and they are deliberately indistinguishable once the strip is on screen.

| mode | at rest | pointer | click |
| --- | --- | --- | --- |
| `always` | the strip is pinned to the menu bar | bulge | opens the panel |
| `hover` | dormant; a bounded top-edge hot zone reveals it | reveals **the identical strip**, then bulges | opens the panel |

Takeovers (`flash`, `celebration`) interrupt in both modes: a mode says where
the strip *rests*, and an event that needs you is not a resting state.

This replaced three modes that all looked different. `hover` used to reveal into
the *expanded* rect while `minimal`/`click` drew the flush compact chrome, so the
same feature read as two products; `minimal` and `click` opened a one-item
"peek" card that was a menu with a single entry. `minimal` and `click` now
normalize to `always` on the wire — both kept a strip on screen, and an upgrade
may not silently hide a surface the user had pinned. Reveal is keyed on the
*pointer* rather than on a second presentation state (`notchSurfaceIsDormant`),
which is what guarantees the two modes cannot drift apart again.

`expandedPanelEnabled` still applies: with the tall panel off, a click opens
Activity in ADE (`open_center`) rather than growing the surface, because a
surface that eats clicks and does nothing is the one outcome no mode may
produce. The retired `automaticRevealEnabled` and `tickerEnabled` keys are
ignored if a host still sends them, and are not emitted back.

## Compact strip

Two wings around the cutout, both present in both modes:

- **left** — every nonzero state group as glyph + count, urgency-ordered:
  needs-you (amber filled dot), failed (red triangle), planning (violet
  notepad), working (blue open circle), done (emerald check). One hue is one
  meaning; amber is "your move" and nothing else.
- **right** — one signal with real content ("Checks failing #466", "Merged
  #1030", "Claude is asking"), falling back to a quiet machine summary.

Width is derived from what the wings carry (`notchStripMetrics` →
`notchCompactEarWidth`) and capped, so the strip hugs the hardware notch instead
of padding out to the widest label it could ever hold. The ears are symmetric by
construction: the cutout is centered on the display and so is the panel.

The needs-you card is a **timed takeover** (~10s), not a state: it auto-dismisses
by morphing back into its amber glyph, and also ends on click, on explicit
close, and when the row is acknowledged from another device. When the last
needs-you row clears, the strip plays a brief "all clear" beat.

## Expanded panel

`Agents` and `Events` tabs over the same section language as the desktop
Activity dropdown: Needs you / Failed / Planning / Working / Done, from the one
five-way table (`notchStripGroupKind`) the compact strip counts with, so a row
the strip counts as red is a row the panel files under Failed. The table is
pinned to the renderer's canonical `activityStateGroup` by
`ActivityStateGroupConformanceTests`, which runs the shared
`src/shared/attention/activityStateGroup.cases.json` fixture through it.
Events are clustered by repository and pull-request number —
three failing checks on one PR are one story — and a takeover clicked through
opens the panel already on the Events tab with that cluster expanded and
focused. Sections and clusters collapse (Done starts collapsed), and the panel
is keyboard navigable: arrows move through exactly the rows on screen,
left/right work the disclosure, Tab swaps tabs, Return acts, Escape closes.

## Local validation

```bash
swift test --package-path apps/desktop/native/ADEAttentionNotch
npm --prefix apps/desktop run build:notch
npx --prefix apps/desktop vitest run \
  src/main/services/attention/attentionNotchHelper.test.ts
```

The helper reads one JSON object per line from standard input. It accepts raw
`AttentionSnapshot` objects or command envelopes:

```json
{"type":"snapshot","snapshot":{"contractVersion":1,"revision":1,"generatedAt":"...","items":[]}}
{"type":"settings","settings":{"enabled":true,"hideDetails":false,"celebrationsEnabled":true,"soundsEnabled":true}}
{"type":"visibility","visible":false}
{"type":"reanchor"}
{"type":"quit"}
```

It emits `open`, `action`, `dismiss_item`, `open_center`, `open_settings`,
`refresh`, `settings`, `surface`, and `protocol_error` JSON lines on standard
output. Diagnostic text is written only to standard error. The output set is
additive by contract: a host that does not recognise a type must ignore it.
