# ADE media library

Images and video used by the public Mintlify docs, the GitHub README, and the
marketing site's stills. Keep it small: a file lives here only while a page
uses it.

## Layout

```
media/
├── current/       Current product captures used by the docs
├── logos/
│   ├── models/    AI model marks (Claude, OpenAI, Gemini, …) — SVG
│   └── competitors/  "every tool = ADE" equation logos
assets/
└── readme/        Current README and landing-page stills and loops
```

## Rules

- **One current capture per surface.** When a screen changes, replace the file
  in `media/current/`; do not keep the old one.
- **Delete, do not archive.** Stale screenshots and videos are removed with
  `git rm` once no page references them. `node scripts/validate-docs.mjs` fails
  on a broken image path, so a missed reference is caught.
- **Capture from demo data.** Product captures come from the `acme-shop` demo
  snapshot (`apps/desktop/scripts/demo/build-demo-snapshot.mjs`), never from a
  real project, so no private lane, chat, or account data reaches a public
  page.
- **Names describe the surface**, e.g. `current/lanes.jpg`,
  `current/pull-requests.jpg`.
- The live website keeps its own copies under `apps/web/public/`; this library
  is additive.
