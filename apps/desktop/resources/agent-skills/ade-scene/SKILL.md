---
name: ade-scene
description: Use this skill when showing something would beat describing it — status across many items, a number that changed, a comparison, a timeline, a pipeline, a distribution. Emit a fenced `scene` block of ordinary HTML, CSS and JS and ADE renders it as a live view inside the transcript. Use ade-mosaic instead when you need an ANSWER from the user.
---

# ADE scenes

Emit a fenced code block with language `scene` containing plain HTML. ADE renders
it in a sandboxed frame with its own origin and its own Content-Security-Policy.
You write real HTML, CSS and JavaScript — there is no schema and no component
list to stay inside.

A scene **shows**. A mosaic **asks**. Never draw your own Approve button: ADE has
native surfaces for permission, and a card that approves itself is not a
confirmation. Reach for `ade-mosaic` whenever you need a decision back.

## The block

The first line may carry a title. Everything after it is your markup.

````
```scene
<!-- @scene title="Merged pull requests" -->
<style>
  .n { font-size: 64px; font-weight: 600; letter-spacing: -.03em; }
  .row { display: grid; grid-template-columns: 64px 1fr auto; gap: 14px;
         padding: 11px 14px; opacity: 0; }
</style>

<div class="n" id="count">0</div>
<div class="row" data-row><span>#1237</span><span>Persistent director</span><span>passed</span></div>

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

## What the frame gives you

`window.ade` is injected before your code runs:

| Member | What it does |
|---|---|
| `ade.data` | Always `null` today. No ADE surface passes a payload into a scene. |
| `ade.theme` | ADE's resolved palette. Also available as CSS variables. |
| `ade.reducedMotion` | True when the user asked for less motion. |
| `ade.animate(target, keyframes, options)` | Web Animations, collapsed to the end state under reduced motion. |
| `ade.countUp(target, to, { from, duration, decimals })` | Counts a number up. |
| `ade.resize()` | Re-measures the scene and asks the host for the new height. |
| `ade.on("update", fn)` | Registers a listener for host messages. ADE sends none today, so it never fires. |
| `ade.emit(name, payload)` | Posts an event to the host. No ADE surface reads it today, so it is dropped. |
| `ade.ready()` | Call it when your first paint is done. |

CSS variables, already set on `:root`: `--bg`, `--surface`, `--border`, `--fg`,
`--fg-muted`, `--accent`, `--success`, `--warning`, `--danger`, `--font-sans`,
`--font-mono`. Use them and the scene looks like the rest of ADE.

## What the frame does not give you

- **No network.** `connect-src 'none'`: no `fetch`, no XHR, no WebSocket, no
  remote fonts, no remote images. Put the data in the markup.
- **No access to ADE.** Different origin, sandboxed without `allow-same-origin`.
  `ade.emit` is the only outbound call, and nothing reads it today. Treat a
  scene as a one-way view. Put everything it needs in its own markup.
- **No external libraries.** They cannot be fetched. Native CSS animations and
  the Web Animations API are what you have, and they are enough.
- Images must be `data:` or `blob:` URLs.

## Lifetime

A scene runs live for the turn or call that produced it. Where a capture route
exists, ADE then snapshots it to a still image, and scrollback shows the picture
rather than re-executed code. Where no capture route exists, such as the browser
preview, the live frame stays mounted and keeps running. Either way, make the
scene readable when it stops moving. A scene whose meaning depends on an
animation the user has to catch is meaningless tomorrow.

## When to use one

Good: several pull requests and their check states; a count that changed; CI
stages and where it failed; a lane's commits ahead and behind; anything where
shape or proportion is the point.

Bad: one number (say it), a paragraph (write it), anything you need answered
(use `ade-mosaic`), or a wall of text in a box (that is just text, further away).

Keep it under roughly 500 lines of markup. Past that it is a document, not a
view. The hard cap is 96,000 source bytes. Over it ADE renders your code as
highlighted text instead of a view.
