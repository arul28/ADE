# DAEX icon masters — v2 (less glossy)

Chosen 2026-11-27: a white "æ" ligature on deep violet glass with a calm finish (faint depth, no hard reflections). Beta is orange, Alpha is teal.

| File | Use |
|---|---|
| `icon-macos-release.png`, `icon-macos-beta.png`, `icon-macos-alpha.png` | 1024×1024 squircle with transparent padding: macOS `.icns`, Linux and large Windows sizes (≥128 px) |
| `icon-ios-release.png`, `icon-ios-beta.png`, `icon-ios-alpha.png` | 1024×1024 full bleed, opaque, no corners: iOS app icons (iOS masks the corners) |
| `icon-flat-release.png`, `icon-flat-beta.png`, `icon-flat-alpha.png` | Flat version of the same glyph on a rounded tile, transparent corners: 16–64 px, Windows `.ico` small layers, tray, favicon |
| `glyph-mask.png` | The æ glyph alone as a grayscale mask: monochrome/template icons (macOS menu bar) and new sizes |

The macOS 26 icons are Icon Composer packages in `apps/desktop/build/` (`icon.icon`, `icon.beta.icon`, `icon.alpha.icon`): a `background.png` layer (the `icon-ios-*.png` art with the glyph painted out by a wide blur fill) under a `glyph.png` layer (white, alpha from `glyph-mask.png`, Liquid Glass on). Remake both layers when the art changes; see `docs/brand/desktop-packaging.md`, "macOS 26 app icon".

Generated with Higgsfield (GPT Image 2.6); the Alpha and flat versions are derived locally from the release art so the glyph matches.
