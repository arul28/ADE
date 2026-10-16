/**
 * 3D scenes: the `ade.three` helper that runs inside a scene frame, next to a
 * host-supplied three.js (`window.THREE`, see `vite.sceneThree.ts`).
 *
 * A scene opts in by using it: a scene whose source says `THREE.`,
 * `ade.three`, `window.THREE`, or assigns `THREE` to a name of its own gets
 * three.js inlined into its document. There is no marker to declare. A bare
 * mention of the word does not count, so prose about "three" items does not
 * pull most of a megabyte into a 2D scene.
 *
 * The helper exists for cost, not convenience. A naive three.js page renders
 * at the display's refresh rate forever; `ade.three.view` renders on demand:
 * once per change (a resize, a drag of the orbit controls, a theme switch,
 * `view.render()`), and continuously only while an `onFrame` callback is
 * registered or the controls are still easing. A static model therefore costs
 * nothing once drawn. The pixel ratio is capped at 2, the renderer asks for
 * the low-power GPU, and a lost context waits to be restored instead of
 * throwing. The SDK's idle mode applies on top: an animated view nobody is
 * pointing at drops to a few frames a second.
 *
 * ES5 inside a `String.raw` template, like the SDK: a backslash typed here is
 * the backslash the frame runs.
 */

const THREE_USE = /\bTHREE\.|\bade\.three\b|\bwindow\.THREE\b|=\s*THREE\b/;

/**
 * Where the three.js bundle lives, relative to the renderer's output (and the
 * dev server's root). Written by `vite.sceneThree.ts`, read back by
 * `ade scene preview` in main; one name so the two cannot drift.
 */
export const SCENE_THREE_ASSET = "assets/ade-scene-three.js";

/** True when a scene's markup uses three.js and needs it in its document. */
export function sceneUsesThree(html: string): boolean {
  return THREE_USE.test(html);
}

export const SCENE_THREE_HELPER_SOURCE = String.raw`
(function () {
  var THREE = window.THREE;
  var ade = window.ade;
  if (!THREE || !ade) return;
  var reducedMotion = false;
  try { reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  // A theme name ("accent", "--accent", "chart-2", "fg-muted") or any CSS
  // colour, as a THREE.Color. Theme names resolve through the CSS variables,
  // so every variable the guide lists works, chart colours included. The
  // canvas normalises any CSS syntax (rgb(), hsl(), oklch() ...); alpha is
  // dropped here, because a material colour has none and three.js warns about
  // it. Use material.opacity for a faded colour.
  var probe = null;
  function resolve(name) {
    var text = String(name == null ? "" : name).trim();
    var variable = /^--/.test(text) ? text : /^[a-z][a-z0-9-]*$/i.test(text) ? "--" + text : "";
    if (variable) {
      var value = window.getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
      if (value) return value;
    }
    return text;
  }
  function setColor(target, name) {
    try {
      probe = probe || document.createElement("canvas").getContext("2d");
      probe.fillStyle = "#808080";
      probe.fillStyle = resolve(name);
      var css = probe.fillStyle;
      var rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(css);
      if (rgba) target.setRGB(+rgba[1] / 255, +rgba[2] / 255, +rgba[3] / 255, THREE.SRGBColorSpace);
      else target.set(css);
    } catch (e) {
      target.set(0x808080);
    }
    return target;
  }
  function color(name) {
    return setColor(new THREE.Color(), name);
  }

  // Materials painted from the theme, repainted when the theme switches.
  var painted = [];
  function paint(material, name, property) {
    var key = property || "color";
    if (!material || !material[key] || !material[key].isColor) {
      throw new Error("ade.three.paint: the material has no colour named " + key);
    }
    setColor(material[key], name);
    painted.push({ material: material, name: name, key: key });
    return material;
  }
  var views = [];
  ade.on("theme", function () {
    for (var i = 0; i < painted.length; i++) setColor(painted[i].material[painted[i].key], painted[i].name);
    for (var j = 0; j < views.length; j++) views[j]();
  });

  function view(target, options) {
    options = options || {};
    var host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("ade.three.view: no element matches " + target);
    if (!host.style.height && !host.clientHeight) host.style.height = (options.height || 320) + "px";
    if (window.getComputedStyle(host).position === "static") host.style.position = "relative";

    var renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    var canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);

    var scene = new THREE.Scene();
    var cameraAt = options.camera || [3, 2.5, 4];
    var camera = new THREE.PerspectiveCamera(options.fov || 45, 1, 0.05, 2000);
    camera.position.set(cameraAt[0], cameraAt[1], cameraAt[2]);
    var lookAt = options.target || [0, 0, 0];
    camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);

    if (options.lights !== false) {
      scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.4));
      var sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(4, 6, 3);
      scene.add(sun);
    }

    var controls = null;
    var frameFns = [];
    var scheduled = false;
    var disposed = false;
    var lastTime = 0;
    var lost = false;

    function loop(now) {
      scheduled = false;
      if (disposed || lost) return;
      var dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0;
      lastTime = now;
      for (var i = 0; i < frameFns.length; i++) {
        try { frameFns[i](dt, now / 1000); } catch (e) {
          // Drop the callback that threw and keep drawing; the error still
          // reaches the host through the SDK's error listener.
          frameFns.splice(i, 1);
          i -= 1;
          setTimeout(function () { throw e; }, 0);
        }
      }
      // update() answers whether damping moved the camera this frame.
      var easing = controls ? controls.update() : false;
      renderer.render(scene, camera);
      if ((frameFns.length && !reducedMotion) || easing) schedule();
      else lastTime = 0;
    }
    function schedule() {
      if (scheduled || disposed) return;
      scheduled = true;
      requestAnimationFrame(loop);
    }

    if (options.controls !== false) {
      controls = new THREE.OrbitControls(camera, canvas);
      controls.target.set(lookAt[0], lookAt[1], lookAt[2]);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.addEventListener("change", schedule);
      controls.addEventListener("start", function () { userMoved = true; });
      // The view sits in a scrolling transcript: a plain wheel must scroll
      // the chat, not get stuck zooming the model. Pinch (a ctrl wheel on a
      // trackpad) and cmd/ctrl + wheel zoom. Decided on the host, in capture,
      // so it runs before the controls' own wheel listener on the canvas.
      host.addEventListener("wheel", function (event) {
        controls.enableZoom = event.ctrlKey || event.metaKey;
      }, { capture: true, passive: true });
    }

    // Framing: keep the camera's direction and move it along that line until
    // every corner of the object's bounding box is inside both the height and
    // the width of the view. Corners rather than a bounding sphere, so a wide
    // flat thing (a row, a disc of orbits) fills a wide view. Kept on resize
    // until the reader moves the camera themselves.
    var fitted = null;
    var userMoved = false;
    function applyFit() {
      if (!fitted) return;
      var box = new THREE.Box3().setFromObject(fitted.object);
      if (box.isEmpty()) return;
      var center = box.getCenter(new THREE.Vector3());
      var direction = camera.position.clone().sub(controls ? controls.target : center);
      if (direction.lengthSq() < 1e-9) direction.set(0, 0.5, 1);
      direction.normalize();
      var forward = direction.clone().negate();
      var right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
      var up = new THREE.Vector3().crossVectors(right, forward).normalize();
      var tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      var tanH = tanV * camera.aspect;
      var distance = 0;
      var corner = new THREE.Vector3();
      for (var i = 0; i < 8; i++) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
        var toward = corner.dot(direction);
        distance = Math.max(
          distance,
          toward + Math.abs(corner.dot(right)) * fitted.margin / tanH,
          toward + Math.abs(corner.dot(up)) * fitted.margin / tanV
        );
      }
      if (!(distance > 0)) return;
      if (controls) controls.target.copy(center);
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(distance / 100, 0.01);
      camera.far = distance * 100;
      camera.updateProjectionMatrix();
      camera.lookAt(center);
      schedule();
    }
    function fit(object, fitOptions) {
      fitted = { object: object || scene, margin: (fitOptions && fitOptions.margin) || 1.1 };
      userMoved = false;
      applyFit();
    }

    function resize() {
      var width = host.clientWidth;
      var height = host.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (fitted && !userMoved) applyFit();
      schedule();
    }
    var observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    if (observer) observer.observe(host);
    resize();

    canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      lost = true;
    });
    canvas.addEventListener("webglcontextrestored", function () {
      lost = false;
      schedule();
    });
    views.push(schedule);

    function dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("pagehide", dispose);
      frameFns = [];
      if (observer) observer.disconnect();
      if (controls) controls.dispose();
      views = views.filter(function (fn) { return fn !== schedule; });
      var released = [];
      scene.traverse(function (node) {
        if (node.geometry) node.geometry.dispose();
        var materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
        for (var i = 0; i < materials.length; i++) {
          materials[i].dispose();
          released.push(materials[i]);
        }
      });
      // Its painted materials are gone too: a theme switch must not keep
      // repainting them, and a scene that rebuilds its view must not pile up.
      painted = painted.filter(function (entry) { return released.indexOf(entry.material) === -1; });
      renderer.dispose();
    }
    window.addEventListener("pagehide", dispose);

    schedule();
    return {
      THREE: THREE,
      scene: scene,
      camera: camera,
      renderer: renderer,
      controls: controls,
      canvas: canvas,
      /** Run fn(dtSeconds, timeSeconds) every frame; returns a function that stops it. */
      onFrame: function (fn) {
        frameFns.push(fn);
        schedule();
        return function () {
          frameFns = frameFns.filter(function (f) { return f !== fn; });
        };
      },
      /** Draw once more: call after changing the scene outside onFrame. */
      render: schedule,
      /** Frame an object (default: the whole scene) to fill the view; kept on resize. */
      fit: fit,
      dispose: dispose,
    };
  }

  ade.three = { view: view, color: color, paint: paint };
})();
`;
