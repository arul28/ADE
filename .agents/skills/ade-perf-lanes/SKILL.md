---
name: ade-perf-lanes
description: Performance patterns discovered for ADE's Lanes tab. Read before
  editing files under apps/desktop/src/renderer/components/lanes/** or
  apps/desktop/src/main/services/lanes/**. Append-only knowledge base populated
  by ade-autoresearch runs. Skip patterns that contradict the current scenario
  contract.
metadata:
  author: ade-autoresearch
  version: 0.1.0
  status: seed
---

# ade-perf-lanes

Patterns discovered for the Lanes tab. Each entry has run-traced provenance — do not delete entries without explicit user approval.

## How to use this file

- Read all entries before making any change in lanes code.
- If a proposed change conflicts with an entry: prefer the entry. If you believe you can do better, run `ade-autoresearch lanes` and prove it with metrics.
- New entries are appended by `ade-autoresearch` at the end of each run.

## Scenarios this tab is benchmarked against

Defined in `apps/desktop/src/renderer/perf/scenarios/lanes.ts`:

- `lanes.cold-list` — cold open of /lanes route.
- `lanes.switch-rapid` — fast route switching to/from /lanes.
- `lanes.idle-at-rest` — 30s on /lanes, measures background polling cost.
- `lanes.stress-poll` — 2min on /lanes, catches leaks.
- `lanes.scroll-list` — scroll the lanes list repeatedly.

## Patterns

_No patterns recorded yet — populated by the first `ade-autoresearch lanes` run._

<!--
Template for new entries (the autoresearch skill appends these — don't edit by hand):

### Pattern: <one-line name>
- **Why it helped**: <bottleneck + metric delta>
- **How to recognize when to apply**: <signs in code that same pattern fits>
- **Anti-pattern**: <what NOT to do>
- **Verification**: <scenario + metric affected>
- **Provenance**: run `<runId>`, commit `<sha>`, fitness `<old> → <new>`
-->
