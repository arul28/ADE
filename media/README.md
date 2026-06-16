# ADE media library

The single, organized source of truth for **every ADE image** — the marketing
site, the GitHub README, and the raw product captures. Everything here is
deduplicated, renamed to clean kebab-case paths, and optimized (`.webp` for
stills, `.svg` for logos, `.mp4` + `.gif` for motion).

> Point a docs agent here: each folder maps to a product area, so screenshots
> can be dropped into the matching docs page. The live website keeps its own
> copies under `apps/web/public/` — this library is additive and safe to
> reorganize.

## Layout

```
media/
├── brand/                 ADE wordmark, app/dock icon, favicon, OG card
├── logos/
│   ├── models/            AI model marks (Claude, OpenAI, Gemini, …) — SVG
│   └── competitors/       "every tool = ADE" equation logos
├── landing/
│   ├── hero/              fold device trio (desktop / tui / mobile) + OG card
│   └── showcase/          "Ship code from any screen" tab compositions
│                          (worktrees / agent-chat / pull-requests / work-tools)
├── features/             product captures grouped by area
│   ├── worktrees/         create + manage lanes, the worktree graph
│   ├── agent-chat/        new chat, model picker, orchestrator, grid view
│   ├── pull-requests/     make/view PRs, files+CI, commits, rebase
│   ├── tui/               `ade code` terminal
│   ├── cto/               subagents / conductor
│   ├── browser/           built-in browser pane
│   ├── linear/            Linear integration
│   ├── remote/            remote runtimes
│   ├── files/             files tab
│   ├── settings/          settings + provider usage
│   ├── project/           add-project flow
│   ├── git/               git actions
│   └── mobile/            iOS captures
└── demos/                 compressed screen recordings (.mp4) + README previews (.gif)
```

## Notes

- **Stills are `.webp`** (q88) — small and docs-ready. Re-export to PNG if a
  surface needs it.
- **`demos/` holds the source `.mp4`s** (already compressed from the originals)
  plus the three GIF previews used in the README. Use the MP4 for embedded
  video, the GIF for inline autoplay.
- Names describe the captured surface; folders describe the feature. When a
  feature has several states, each is its own file (e.g. `worktrees/new-lane-button`
  + `worktrees/new-lane-options`).
- Source uploads originally lived in `apps/web/public/images/updatedImages/`;
  they've been converted, renamed, and filed here.
