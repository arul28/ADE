---
name: ade-scene
description: Use this skill when showing something would beat describing it — status across many items, a number that changed, a comparison, a timeline, a pipeline, a distribution, ADE's own lanes, chats or PRs. Emit a fenced `scene` block of ordinary HTML, CSS and JS and ADE renders it as a live, interactive view inside the transcript. Check it first with `ade scene preview`. Use ade-mosaic instead when you need an ANSWER from the user.
---

# ADE scenes

Emit a fenced code block with language `scene` containing plain HTML. ADE renders
it in a sandboxed frame with its own origin and its own Content-Security-Policy,
inline in your reply, on the reply's own text column and in ADE's font and
colors. You write real HTML, CSS and JavaScript — there is no schema and no
component list to stay inside.

A scene **shows**. A mosaic **asks**. Never draw your own Approve button: ADE has
native surfaces for permission, and a card that approves itself is not a
confirmation. Reach for `ade-mosaic` whenever you need a decision back.

## Decide first: does this reply need one?

Most replies need no scene. Add one only when a picture makes the answer
clearly faster to read than prose would, and only one per reply.

Good: several PRs and their check states; status across lanes or chats (use
live data); a count or metric that changed; CI stages and where it failed; a
comparison of many items; a trend or distribution; anything a reader would
want to hover, zoom or click through.

Bad: one number or one fact (say it), a short answer, a paragraph (write it),
a list a bullet list handles, anything you need answered (use `ade-mosaic`),
or a wall of text in a box (that is just text, further away). When unsure,
skip it.

Scenes cost the reader nothing to wait for: the reply streams on while the
scene draws, and a preview takes a second or two.

## The loop: write, preview, fix, then reply

1. Write the scene to a file (`/tmp/<name>.html`), body only or a whole fence.
2. `ade scene preview /tmp/<name>.html --text`. It renders the scene exactly as
   the chat will, in a hidden window, and prints a screenshot path and every
   problem: script errors, blocked requests, a scene that never settles, and
   source mistakes the policy turns into blanks.
3. Open the screenshot and look at it: `ok` only means nothing threw. Check
   the layout (columns lined up, nothing cut off or overlapping, text
   readable). Fix and preview again until it is right. Check `--theme light` if colors matter; `--width 980` for wide panes.
4. Put the fence in your reply.

Do not skip the preview for anything non-trivial: a scene that throws is a blank
box in the user's transcript.

## The block

The first line may carry a title and the live data the scene wants.
Everything after it is your markup.

````
```scene
<!-- @scene title="Merged pull requests" -->
<style>
  .n { font-size: 48px; font-weight: 600; letter-spacing: -.03em; }
  .row { display: grid; grid-template-columns: 64px 1fr auto; gap: 14px;
         padding: 8px 0; border-bottom: 1px solid var(--border); opacity: 0; }
  .row:hover { background: var(--surface); }
</style>

<div class="n" id="count">0</div>
<a class="row" data-row href="ade://pr/acme/app/1237"><span>#1237</span><span>Persistent director</span><span>passed</span></a>

<script>
  ade.countUp("#count", 3);
  document.querySelectorAll("[data-row]").forEach(function (row, i) {
    ade.animate(row, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
      { duration: 460, delay: 200 + i * 110 });
  });
  ade.ready();
</script>
```
````

No padding is added around your markup: content starts on the reply's left
edge. Draw your own card (`background: var(--surface); border: 1px solid
var(--border); border-radius: 10px`) when you want one.

## What the frame gives you

`window.ade` is injected before your code runs:

| Member | What it does |
|---|---|
| `ade.data` | The live ADE data the scene asked for (see below), or `null`. |
| `ade.on("data", fn)` | Called with each new data snapshot, and at once if one already arrived. |
| `ade.on("theme", fn)` | Called when the user switches ADE's theme. The CSS variables already changed. |
| `ade.theme` | ADE's resolved palette. Also available as CSS variables. |
| `ade.open(url)` | Opens an `ade://` deeplink in ADE, or an http(s) page in ADE's browser. Plain `<a href>` links do the same. Works only in answer to a click in the scene. |
| `ade.reducedMotion` | True when the user asked for less motion. |
| `ade.restored` | True when the scene already played once and is being brought back; `ade.animate` and `ade.countUp` skip to their end state then. |
| `ade.animate(target, keyframes, options)` | Web Animations, collapsed to the end state under reduced motion or restore. |
| `ade.countUp(target, to, { from, duration, decimals })` | Counts a number up. |
| `ade.resize()` | Re-measures the scene and asks the host for the new height. Call it after you change the content's size. |
| `ade.ready()` | Call it when your first paint is done. |

CSS variables, already set on `:root` and kept current when the theme changes:
`--bg`, `--surface`, `--border`, `--fg`, `--fg-muted`, `--accent`, `--success`,
`--warning`, `--danger`, `--font-sans`, `--font-mono`, `--font-size`. Use them
and the scene looks like the rest of ADE in every theme, light ones included.
`--font-sans` is ADE's Geist and `--font-mono` its JetBrains Mono.

## Live ADE data

Ask on the marker line, and the scene stays true after the turn ends: scrolled
back into view tomorrow, it shows tomorrow's lanes.

```
<!-- @scene title="Lanes" data="lanes,prs" -->
```

| Source | Each item |
|---|---|
| `lanes` | `id, name, branch, base, primary, color, ahead, behind, dirty, changedFiles, running, awaitingInput, sessions, url` |
| `sessions` | `id, title, laneId, laneName, tool, status, startedAt, endedAt, url` |
| `prs` | `number, title, state, checks, review, laneId, additions, deletions, updatedAt, githubUrl, url` |

`url` is an `ade://` deeplink: put it in an `<a href>` (or pass it to
`ade.open`) and a click opens that lane, chat or PR in ADE. The snapshot
`{ at, lanes?, sessions?, prs? }` arrives after load and again when it changes,
so render from `ade.on("data", render)`, and draw an empty state until the
first one arrives.

**Use live data instead of typing ADE's numbers in.** Asking for `data=` and
then hardcoding values you looked up is the worst of both: the numbers are
stale tomorrow and wrong if your lookup was. Start from this and restyle it:

````
```scene
<!-- @scene title="Lanes" data="lanes,prs" -->
<style>
  .row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 16px; align-items: center;
         padding: 8px 0; border-bottom: 1px solid var(--border); color: var(--fg); text-decoration: none; }
  .row:hover { background: var(--surface); }
  .m { color: var(--fg-muted); font-size: 12px; } .n { font-family: var(--font-mono); font-size: 12px; }
</style>
<div id="rows" class="m">Loading lanes…</div>
<script>
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  ade.on("data", function (d) {
    var prs = d.prs || [];
    document.getElementById("rows").innerHTML = (d.lanes || []).map(function (l) {
      var pr = prs.filter(function (p) { return p.laneId === l.id; })[0];
      return '<a class="row" href="' + l.url + '"><span>' + esc(l.name) + ' <span class="m">' + esc(l.branch) + '</span></span>'
        + '<span class="n">+' + l.ahead + ' −' + l.behind + '</span>'
        + '<span class="n" style="color:var(' + (l.dirty ? '--warning' : '--success') + ')">' + (l.dirty ? 'dirty' : 'clean') + '</span>'
        + '<span class="n">' + (pr ? '#' + pr.number + ' ' + esc(pr.state) : 'no PR') + '</span></a>';
    }).join("") || "No lanes.";
    ade.resize();
  });
  ade.ready();
</script>
```
````

`ade scene preview` sends a live-data scene the same snapshot the chat will,
so the preview shows real lanes, chats and PRs.

## What the frame does not give you

- **No network.** `connect-src 'none'`: no `fetch`, no XHR, no WebSocket, no
  remote fonts, no remote images, no `<script src>`. Put the data in the markup
  or ask for live data. Images must be `data:` or `blob:` URLs.
- **No storage.** `localStorage`, `sessionStorage`, `indexedDB` and cookies
  throw in the sandbox. Keep state in variables.
- **No globals named `top`, `parent`, `opener`, `frames` or `self`.** In a
  sandboxed frame those are the window's own, and touching them throws.
  `var top = []` breaks the whole script. Rename them.
- **No access to ADE beyond the above.** Different origin, sandboxed without
  `allow-same-origin`. `ade.open` and the data feed are the only bridges.
- **No external libraries.** They cannot be fetched. Native CSS animations,
  SVG, canvas and the Web Animations API are what you have, and they are enough.

## Lifetime

A scene is live while it is on screen: hovers, toggles, zoom and links keep
working in scrollback. Off screen for a few seconds, it is swapped for a still
picture of itself, and swapped back when it returns (restored: no replayed
entrance). While the reader scrolls, they see the stills; a scene comes alive
where they stop.

When a scene has settled and the reader's pointer is elsewhere, it idles:
endless CSS and SVG animations pause and `requestAnimationFrame` runs a few
times a second, until the pointer, a key or new data wakes it. So a looping
spinner costs nothing while nobody looks at it, and a canvas animation should
read well at its idle frame. Do not depend on `setInterval` loops; use
`requestAnimationFrame` or CSS so the idle rules apply.

The still is taken once, when the scene first settles fully on screen: no Web
Animation or CSS animation running and no DOM change for 600 ms (endless loops
do not count), or 4 seconds after load. Make the scene readable when it stops
moving. A scene whose meaning depends on an animation the user has to catch is
meaningless tomorrow.

## Size

Keep it under roughly 500 lines of markup. Past that it is a document, not a
view. The hard cap is 96,000 source bytes. Over it ADE renders your code as
highlighted text instead of a view. Scenes can be up to 960 px tall in the
transcript (taller ones scroll inside), and the reader can expand any scene to
a full-window view.
