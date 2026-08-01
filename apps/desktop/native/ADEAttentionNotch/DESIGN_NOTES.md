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

`NotchSettings.revealMode` and `NotchSettings.expandedPanelEnabled` decide how
far the surface may grow. `NotchPresentationPolicy` derives from them and is the
only thing `NotchInteractionState` consults, so the rules live in one place and
apply identically to the physical notch and the menu-bar fallback.

| mode | pointer | alerts and celebrations | click |
| --- | --- | --- | --- |
| `minimal` | nothing | recolour the compact bar | opens a short peek |
| `hover` | surface is hidden at rest; hot zone opens the peek | stays hidden until hover | opens |
| `click` | nothing | recolour the compact bar | opens |

A click opens in **every** mode, so neither the surface nor the menu-bar status
item that stands in for it is ever an inert control. With
`expandedPanelEnabled == false` that click opens the short peek instead of the
tall panel, which is what keeps the surface clear of menu-bar content.

Both keys default to today's behaviour (`hover`, panel enabled) and decode
totally: a host that predates them, or names a mode this build has never heard
of, keeps the shipped surface rather than losing the settings frame.
`NotchInteractionState.applyPolicy(_:)` reconciles whatever is already on screen
when the user changes a mode, so the change is visible immediately.

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

It emits `open`, `action`, `surface`, and `protocol_error` JSON lines on standard
output. Diagnostic text is written only to standard error.
