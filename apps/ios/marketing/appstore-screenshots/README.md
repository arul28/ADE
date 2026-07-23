# ADE — App Store screenshot generator

Single-file generator (`index.html`, no build) that composes App Store marketing
slides from real app screenshots. Adapted from the Versic generator.

## Run

```bash
cd apps/ios/marketing/appstore-screenshots
python3 -m http.server 4601   # 4599 is often taken by the Versic copy
# open http://localhost:4601
```

Pick size/theme/font in the toolbar, then **Export all** (or per-card **PNG**).
Files download as `NN-id-WxH.png`, ready for App Store Connect.

## Headless export

```bash
python3 -m http.server 4601 &
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for i in 0 1 2 3 4 5 6; do
  "$CHROME" --headless=new --disable-gpu --window-size=1320,2868 --hide-scrollbars \
    --virtual-time-budget=12000 --screenshot="out/slide-$i.png" \
    "http://127.0.0.1:4601/?slide=$i"   # &size=0..3 &font=Inter
done
```

## Source screenshots (`./screenshots`)

| file | shows | source | native res |
|---|---|---|---|
| `01-chat.png` | agent chat mid-run | landing `images/hero/hero-mobile.webp` | 1206×2622 ✅ |
| `02-git.png` | worktree git view | landing `secondPage/lanesMobile.webp` | 1206×2622 ✅ |
| `03-prs.png` | PRs list | landing `secondPage/prMobile.webp` | 602×1297 (soft) |
| `04-cli.png` | mirrored terminal | landing `secondPage/chatMobile.webp` | 601×1292 (soft) |
| `desktop.png` | desktop app (devices slide) | landing `images/hero/hero-desktop.webp` | 2572×1398 |

Replace any of these with fresh iPhone 16 Pro (1206×2622+) simulator captures —
same filename, or the **Replace** button in the UI. `03`/`04` are upscaled ~2×
and slightly soft; swap them first when new captures exist.

Latest exports live in `./out` (7 slides, 1320×2868 = required 6.9" size).

Note: the project targets iPad too (`TARGETED_DEVICE_FAMILY = 1,2`), so ASC will
also require iPad screenshots (2064×2752) unless the family is cut to iPhone-only.
