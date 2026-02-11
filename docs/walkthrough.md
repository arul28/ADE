# ADE Desktop UI Walkthrough

Last updated: 2026-02-11

This note captures the current renderer direction and the recent visual refactor so implementation docs and code stay aligned.

## Visual Direction

- Theme: **Maestro on Parchment** / **Clean Paper**
- Background: warm off-white (`#FDFBF7`)
- Borders: thin fold-line treatment (`#DBD8D3`)
- Accent: muted red used sparingly for focus and status
- Typography split:
  - serif for section identity and structural labels
  - monospace for metadata, stats, and technical signals

## Layout Architecture

- App shell is full-bleed (no floating island wrapper)
- Left navigation is a slim icon rail (`50px`)
- Main cockpit keeps explicit pane boundaries and resizable split behavior
- Top-level tabs remain unchanged from locked spec:
  - Projects (Home), Lanes, Terminals, Conflicts, PRs, History, Settings

## Component Language

- Lane rows are compact “index card” style with:
  - metadata grid (sync/state/activity)
  - hover-revealed lane actions
- Pane headers are condensed, uppercase/mono-oriented “manifest” bars

## Tech Notes

- Renderer theme tokens are CSS custom properties in Tailwind v4-style `index.css`
- Terminal rendering (`TerminalView`) resolves explicit `--color-*` variables for xterm theme colors to keep terminal foreground/background contrast legible on the paper theme
- Monaco diff editor remains lazy-loaded inside lane detail for Phase 1 quick edit flow

## Current Scope Boundary

- This walkthrough reflects completed UI work through Phase 1.
- Phase 2 process/test controls in Projects (Home) remain a planned implementation step.
