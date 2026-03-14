# ADE Project Instructions

## About this project

- ADE is a local-first desktop application for orchestrating coding agents, missions, lanes, PR workflows, and proof/artifact capture.
- The main product lives in `apps/desktop` and is built with Electron, React, and TypeScript.
- The ADE MCP server lives in `apps/mcp-server` and shares core services with the desktop app.
- State is primarily stored under `.ade/` inside the active project, with runtime metadata in SQLite and machine-local files under `.ade/secrets`, `.ade/cache`, and `.ade/artifacts`.

## Working norms

- Preserve existing desktop app patterns before introducing new abstractions.
- Prefer fixing the underlying service or shared type rather than layering renderer-only workarounds on top.
- Keep IPC contracts, preload types, shared types, and renderer usage in sync whenever an interface changes.
- For ADE MCP changes, verify both headless MCP mode and the desktop socket-backed MCP path.
- For computer-use changes, treat policy enforcement and artifact ownership as hard requirements, not prompt guidance.

## Validation

- Desktop checks:
  - `npm --prefix apps/desktop run typecheck`
  - `npm --prefix apps/desktop run test`
  - `npm --prefix apps/desktop run build`
  - `npm --prefix apps/desktop run lint`
- MCP checks:
  - `npm --prefix apps/mcp-server run typecheck`
  - `npm --prefix apps/mcp-server run test`
  - `npm --prefix apps/mcp-server run build`
- Run the smallest relevant subset first when iterating, then finish with the broader checks that cover the touched surfaces.

## Terminology

- Use "lane" for ADE worktrees/branches.
- Use "mission" for orchestrated multi-step work.
- Use "computer use" for screenshot/video/GUI/browser proof flows.
## Style preferences

- Prefer direct, operational language over marketing phrasing.
- Keep user-facing copy concrete and stateful: say what changed, what is blocked, and what the next action is.
- Use sentence case for headings and labels unless the existing UI pattern is intentionally uppercase.

## Content boundaries

- Do not reframe ADE as a docs site, Mintlify project, or generic template app.
- Do not store secrets in plaintext project files when an encrypted store already exists.
- Do not leave policy enforcement in prompts alone when a code path can enforce it directly.
