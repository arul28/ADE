/**
 * `ade scene guide` — the short rules for writing a scene.
 *
 * The prompt carries one line that says scenes exist and when to draw one. This
 * is the next layer: what an agent needs to draw one well, printed by a
 * command every provider can run, so it costs nothing in a session that never
 * draws. The `ade-scene` skill stays the full reference.
 */
export const SCENE_GUIDE = `
ADE scenes: the short guide

A scene is a fenced code block with language "scene", holding plain HTML, CSS
and JS. ADE runs it live in the chat, in a sandbox with no network.

When
  Draw one when there is an obvious thing to show and a picture reads faster
  than prose: status across many items, a comparison, a trend, a pipeline.
  Always draw one when the user asks for a visual. One scene per reply.
  Skip it for a short answer, a single fact, or a list.

Look
  The scene sits in your reply, on the chat's own background.
  - No background on html, body or the outermost element. No outer card,
    no border around the whole scene, no title banner.
  - No side padding on the outermost element: its left edge lines up with
    your reply text. Use a fluid width, never a fixed one.
  - A box that needs its own background (a panel, a mock) gets
    background: var(--surface), a 1px var(--border) border, a 10px radius and
    at least 14px of padding.
  - Colors come from variables only: --fg, --fg-muted, --surface, --border,
    --accent, --success, --warning, --danger, --chart-1 to --chart-6.
    Never a hex color for text or a surface: the user may be on a light theme.
  - Let content set the height. No 100vh, no height: 100% on html or body.

Charts
  Use ade.chart. Do not hand-draw axes in SVG.
    ade.chart("#el", { type: "bar", labels: ["Mon", "Tue"],
      series: [{ name: "Build", values: [4, 5] }], stacked: true, suffix: "m" });
  type is bar, line, area, donut or spark. One series: values: [...].

3D
  Only when depth is the point. THREE is a global (do not import it), with
  THREE.OrbitControls. One call sets up renderer, camera, lights and orbit:
    var view = ade.three.view("#el", { height: 360 });
    var mat = ade.three.paint(new THREE.MeshStandardMaterial(), "accent");
    view.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat));
    view.fit();                       // frame the scene; kept on resize
    view.onFrame(function (dt) { /* move things */ });   // only for motion
  options: height, camera [x,y,z], target [x,y,z], fov, lights: false,
    controls: false. view: scene, camera, controls, render(), fit(object?),
    onFrame(fn) -> stop(), dispose().
  Colors: ade.three.paint(material, "chart-2") paints from the theme and
    repaints on a theme switch; ade.three.color(name) for a one-off Color.
    Any variable name works (accent, fg, fg-muted, chart-1 ... chart-6).
  It draws only on change: view.render() after edits outside onFrame. Never
  your own WebGLRenderer or animation loop. Transparent background. No model
  files or remote textures; build geometry in code. Readers drag to orbit,
  right-drag to pan, pinch to zoom.

Asking
  For a larger decision, give options as buttons. A click writes a draft
  reply into the user's prompt box; they can edit it, and they send it.
    <button data-reply="Use option A: one table per tenant.">Option A</button>
  Write data-reply as a full sentence in the user's voice. Ask the question
  in your reply text too. A small question stays plain text. Never present a
  button as approval of a command or a tool call.

Live ADE data
  Start with <!-- @scene title="Lanes" data="lanes,sessions,prs" --> and draw
  from ade.on("data", fn). Do not type ADE's numbers in by hand.

Rules of the sandbox
  No fetch, no remote scripts, images or fonts, no storage. Images are data:
  URLs. End your script with ade.ready().

Check it
  Write the scene to a file, run: ade scene preview <file> --text
  Open the PNG it prints and look at it. Fix and repeat until it is right.
  "ok" only means nothing threw.

Everything else (the full ade.* list, forms, lifetime, size limits) is in the
ade-scene skill.
`.trim();
