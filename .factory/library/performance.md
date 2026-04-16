# Performance hotspots

Mission-specific performance notes for ADE iOS parity work.

**What belongs here:** known lag sources, hot-path rendering issues, and the kinds of fixes workers should prioritize while preserving behavior.

---

## Work tab
- Large monolith (`Views/WorkTabView.swift`) with repeated full-transcript derivation and sorting across many computed properties
- Timeline/tool/event/file-change/message models are rebuilt repeatedly from the same transcript data
- Loose JSON parsing, regex extraction, markdown parsing, ANSI parsing, and string concatenation happen in hot paths
- Read-only terminal and artifact rendering should avoid repeated expensive conversions in `body`

## Files tab
- Syntax highlighting and diff generation should not rerun needlessly on every render
- File metadata/history loading and diff building should avoid repeated expensive recomputation from `localStateRevision` churn
- Keep the locked read-only scope simple; do not carry write/edit state machinery that no longer serves the mobile product

## PRs tab
- Avoid eager rendering of large diff/detail content for every PR file row at once
- Keep list/detail/workflow slices split into smaller files and lazy containers where possible
- Preserve cached detail readability when offline instead of forcing repeated failed reloads

## Settings / shared shell
- Avoid over-animating decorative backgrounds or high-frequency pulse effects when they do not improve task clarity
- Shared tab-shell navigation and cross-tab request handling should not trigger duplicate pushes or repeated refresh loops

## Global guidance
- Prefer lazy containers for large lists and card stacks
- Move expensive sorting/parsing/merging work out of SwiftUI `body`
- Cache or memoize derived models when the source data has not changed
- Coalesce `localStateRevision`-driven refreshes instead of reloading multiple times per update burst
- Validate that back navigation preserves context instead of resetting and rebuilding the entire screen unnecessarily
