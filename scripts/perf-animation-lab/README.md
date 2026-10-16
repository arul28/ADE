# Animation cost lab

What a looping animation actually costs in **this Electron version, on this
display**, measured outside ADE so nothing else in the app can move the number.
It exists because ADE's "quantize every continuous animation" rule
(`--animate-spin`, `activity-hdr-pulse`, the `steps()` sheens) is a Windows
release-relevant invariant, and a rule nobody can re-measure drifts into folklore.

```bash
node scripts/perf-animation-lab/trace.mjs --count 3 --seconds 8 css smooth rootvar
```

Each named strategy runs in a fresh Electron window and is traced over CDP.
Strategies live in `index.html`:

| name | what it renders |
|---|---|
| `none` | the spinners, no animation (floor) |
| `css` | `steps(30)` keyframe rotation — what ADE ships |
| `smooth` | `linear` keyframe rotation — what ADE shipped before the Windows pass |
| `layer` / `layersmooth` | the same two with `will-change: transform` |
| `rootvar` | one JS clock writing `--lab-angle` on `:root` at 30 Hz |
| `sheet` | one JS clock rewriting a single stylesheet rule at 30 Hz |
| `opacity` | a composited opacity pulse instead of a rotation |

## Reading the output

The column that matters is `ProxyImpl::ScheduledActionDraw` — the compositor
draw — with its **event count**. A running animation holds the compositor in a
draw loop at the display's refresh rate, so the count is the display rate times
the trace length no matter how coarse the animation's steps are. Everything to
its right is renderer main-thread work.

Totals sum only the rendering events the module lists; they are for comparing
strategies against each other, not an absolute share of a core.

## Do not measure this with process CPU

The first version of this lab sampled `TotalProcessorTime` across the Electron
process tree. On a 32-core machine with other agents building, the same strategy
measured 11.0% and then 5.0% of a core, and the ordering inverted between runs.
The CDP trace repeats to within 2% (62, 62, 144, 147 ms). Use the trace.
