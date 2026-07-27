# Files performance and universal editing — before/after evidence

Lane: `ade/files-performance-and-universal-editing-ca2a33d2` (2026-07-13).
Fixes the `files-tree-caches-unbounded-across-projects` finding from
`docs/perf/desktop-performance-audit-2026-07-12` (audit branch
`ade/perf-review-eda90e5f`), removes the artificial read-only editor gate, and
makes large-folder expansion single-page.

## Method

Real desktop app (`scripts/perf-launch.mjs --tab files`, dev runtime with
`--no-sync` beside the production brain) against the perf-pass repo seeded via
`scripts/seed-perf-pass-files.mjs` plus a committed fixture:
`fixtures/bigdir` (12,000 files) and `fixtures/meddir` (3,000 files).
A CDP probe reloaded the renderer (cold module caches), navigated to Files,
and measured click-to-expanded / click-to-visible-file with DOM polling at
16 ms resolution. Before and after ran the same fixture on the same machine;
"before" is the branch base, "after" the lane diff (verified live via the
`window.__adeFilesTreeCacheStats` hook and the tree "Load more…" cursor).

## Editability (deliverable A)

Probe: open `fixtures/notes.md` → Source → type via CDP `Input.insertText` →
Cmd+S → read the file from disk.

| | before | after |
| --- | --- | --- |
| "Cannot edit in read-only editor" badge | **shown** | absent |
| typed text accepted into buffer | no | yes |
| Cmd+S wrote file to disk | no | **yes** (tree shows `M`) |

Screenshots: `ade-md-edit-baseline-readonly.png`, `ade-md-edit-after-fix.png`
(also attached to the ADE proof drawer).

Invariant shipped: a tab is editable iff its viewer mounts Monaco over a
complete text payload (`viewerRegistry.tabIsTextEditable`) — code/plain text,
markdown Source, CSV/TSV Source — in every local primary, lane, attached,
external, and remote workspace. Read-only remains only for honest boundaries:
partial/streamed oversized text, binary/base64 payloads, and real write
failures (surfaced as errors).

## Expansion latency + IPC/work (deliverable B)

Median of two cold runs each; local runtime on local SSD (per-IPC cost ~8 ms,
so serial round trips dominate on remote links far more than here).

| metric | before | after |
| --- | --- | --- |
| expand `bigdir` (12k) click→children visible | 51–58 ms | 37–43 ms |
| `listTreeChildren` calls per expansion | 5 serial (10,000 eager) | **1** (2,000 page) |
| nodes materialized per expansion | 10,000 | 2,000 |
| expand `meddir` (3k) | 20–24 ms | 17–20 ms |
| open first file (Monaco cold) | 123–359 ms | 137–326 ms (unchanged) |
| open file, editor warm | 16–29 ms | 17–48 ms (unchanged) |
| re-expand cached dir | 17–37 ms | 17 ms |

Renderer residency after the same probe pass (probe fixture, one workspace):
before ≈ 13,000+ tree nodes retained; after = 4,014 nodes / ~0.7 MB estimated
(`__adeFilesTreeCacheStats`). Watcher-driven refreshes now re-list only the
user-grown loaded window (unit-tested at 2 pages for 4,000 loaded of 12,000)
and tree updates clone only the target branch instead of every loaded subtree.

## Cache bounds (deliverable C)

`filesTreeCache.ts`: node/byte-accounted (150k nodes / 48 MB estimated
budgets), LRU eviction of unpinned trees, mounted-workbench pins, bounded
workspace-roster LRU (12 projects), and a warm-project-surface eviction hook in
`App.tsx` (`releaseFilesProjectCaches`). Eviction never touches Monaco models,
dirty buffers, editor groups, or open tabs (covered by
`filesTreeCache.test.ts` + `FilesWorkbench.test.tsx`).
