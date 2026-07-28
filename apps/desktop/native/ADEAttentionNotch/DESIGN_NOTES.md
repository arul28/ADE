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
