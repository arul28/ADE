import type { ThemeId } from "../../state/appStore";
import {
  BACKDROP_FRAME_MS,
  BACKDROP_IDLE_FRAME_MS,
  BACKDROP_IDLE_FREEZE_MS,
  FRAG,
  UNIFORMS,
  VERT,
  backdropThemeFor,
  isSoftwareRenderer,
  resolveBackdropSize,
} from "./workToolPickerBackdropShader";

/**
 * The tools picker backdrop's GL side: context, program, uniforms, the rAF loop
 * and every listener and observer that gates it.
 *
 * React-free on purpose. `WorkToolPickerBackdrop.tsx` hands this a canvas and a
 * callback and gets back a `dispose`; everything below — including the deferred
 * context release that survives a remount — lives here.
 */

/**
 * Releasing a WebGL context is not free and React remounts the backdrop for
 * every picker ↔ tool crossfade, so the release is deferred by a task and
 * cancelled if the same canvas comes straight back.
 */
const pendingContextReleases = new WeakMap<HTMLCanvasElement, number>();

/**
 * Hand the GPU context back, from anywhere that decides not to use it.
 *
 * Every refuse path runs through here, not just unmount. A context that is
 * merely abandoned stays alive until the driver's own cap evicts it, and this
 * component remounts on every picker ↔ tool crossfade: on the exact machines
 * that refuse (SwiftShader, a blacklisted Windows driver) that meant a fresh
 * context created and dropped per crossfade, walking the browser's 8–16 context
 * limit until it started killing OTHER canvases in the window. Shrinking the
 * drawing buffer to 1×1 releases the backing store even where the extension is
 * missing.
 */
function releaseContext(gl: WebGLRenderingContext, canvas: HTMLCanvasElement): void {
  try {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // An already-lost context throws on some drivers. The shrink below is the
    // part that always matters.
  }
  canvas.width = 1;
  canvas.height = 1;
}

function matches(query: string): boolean {
  try {
    return window.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

export type BackdropRenderer = { dispose: () => void };

/**
 * Start the mesh on `canvas`, or refuse.
 *
 * Returns `null` on every refuse path — no WebGL, a software rasteriser, a
 * shader that will not compile or link — having already released the context
 * and called `onRefused`. `onRefused` also fires later if the GPU takes the
 * context back, at which point the loop is already stopped.
 */
export function createBackdropRenderer(options: {
  canvas: HTMLCanvasElement;
  theme: ThemeId;
  onRefused: () => void;
}): BackdropRenderer | null {
  const { canvas, theme, onRefused } = options;

  const pendingRelease = pendingContextReleases.get(canvas);
  if (pendingRelease !== undefined) window.clearTimeout(pendingRelease);
  pendingContextReleases.delete(canvas);

  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", {
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) {
    onRefused();
    return null;
  }
  const context = gl;

  const debugInfo = context.getExtension("WEBGL_debug_renderer_info") as
    | { UNMASKED_RENDERER_WEBGL: number }
    | null;
  const rendererName = debugInfo
    ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
    : "";
  if (isSoftwareRenderer(rendererName)) {
    releaseContext(context, canvas);
    onRefused();
    return null;
  }

  const compile = (type: number, src: string) => {
    const shader = context.createShader(type);
    if (!shader) return null;
    context.shaderSource(shader, src);
    context.compileShader(shader);
    return shader;
  };
  const program = context.createProgram();
  const vertexShader = compile(context.VERTEX_SHADER, VERT);
  const fragmentShader = compile(context.FRAGMENT_SHADER, FRAG);
  if (!program || !vertexShader || !fragmentShader) {
    if (vertexShader) context.deleteShader(vertexShader);
    if (fragmentShader) context.deleteShader(fragmentShader);
    if (program) context.deleteProgram(program);
    releaseContext(context, canvas);
    onRefused();
    return null;
  }
  context.attachShader(program, vertexShader);
  context.attachShader(program, fragmentShader);
  context.linkProgram(program);
  context.deleteShader(vertexShader);
  context.deleteShader(fragmentShader);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    context.deleteProgram(program);
    releaseContext(context, canvas);
    onRefused();
    return null;
  }
  context.useProgram(program);

  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(
    context.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    context.STATIC_DRAW,
  );
  const positionLocation = context.getAttribLocation(program, "a_position");
  context.enableVertexAttribArray(positionLocation);
  context.vertexAttribPointer(positionLocation, 2, context.FLOAT, false, 0, 0);

  const uniform = {
    colors: context.getUniformLocation(program, "u_colors"),
    scene: context.getUniformLocation(program, "u_scene"),
    shape: context.getUniformLocation(program, "u_shape"),
    surface: context.getUniformLocation(program, "u_surface"),
    transform: context.getUniformLocation(program, "u_transform"),
    space: context.getUniformLocation(program, "u_space"),
    cursor: context.getUniformLocation(program, "u_cursor"),
  };

  const palette = backdropThemeFor(theme);
  const colorCount = Math.min(palette.colors.length, 8);
  const flat = new Float32Array(24);
  for (let i = 0; i < colorCount; i += 1) {
    const [r, g, b] = palette.colors[i]!;
    flat[i * 3] = r;
    flat[i * 3 + 1] = g;
    flat[i * 3 + 2] = b;
  }
  context.uniform3fv(uniform.colors, flat);
  context.uniform4f(uniform.shape, UNIFORMS.scale, palette.intensity, UNIFORMS.warp, UNIFORMS.detail);
  context.uniform4f(
    uniform.surface,
    UNIFORMS.contrast,
    palette.brightness,
    palette.saturation,
    UNIFORMS.grain,
  );
  context.uniform4f(
    uniform.transform,
    UNIFORMS.seed,
    UNIFORMS.rotate,
    UNIFORMS.drift,
    palette.vignette,
  );
  context.uniform4f(uniform.space, UNIFORMS.offsetX, UNIFORMS.offsetY, 0, 0);
  context.uniform4f(uniform.cursor, 0, UNIFORMS.cursorStrength, UNIFORMS.cursorRadius, 0);

  const reduceMotion = matches("(prefers-reduced-motion: reduce)");
  // A trackpad or a mouse can swirl the mesh. A touchscreen cannot hover, so
  // the "cursor" there is a tap that would yank the background sideways.
  const cursorEnabled = !reduceMotion && matches("(hover: hover)") && matches("(pointer: fine)");

  let bounds = canvas.getBoundingClientRect();
  let targetX = 0;
  let targetY = 0;
  let targetPresence = 0;
  let mouseX = 0;
  let mouseY = 0;
  let cursorPresence = 0;
  let pointerKnown = false;
  let pointerClientX = 0;
  let pointerClientY = 0;
  let raf = 0;
  let frameTimer = 0;
  let layoutRaf = 0;
  let lowPower = false;
  let lastNow: number | null = null;
  let lastDrawn = 0;
  let visible = document.visibilityState === "visible";
  // The clock the freeze runs off. Anything that means "someone is looking at
  // this" pushes it forward: a pointer move, the window coming back, the pane
  // being resized or scrolled into view.
  let lastActivity = performance.now();
  let focused = document.hasFocus();
  let inView = true;
  let disposed = false;
  const start = performance.now();

  const resizeCanvas = () => {
    const { width, height } = resolveBackdropSize(
      bounds.width,
      bounds.height,
      window.devicePixelRatio || 1,
    );
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      context.viewport(0, 0, width, height);
      return true;
    }
    return false;
  };

  const draw = (seconds: number) => {
    resizeCanvas();
    context.uniform4f(uniform.scene, canvas.width, canvas.height, seconds, colorCount);
    context.uniform4f(uniform.space, UNIFORMS.offsetX, UNIFORMS.offsetY, mouseX, mouseY);
    context.uniform4f(
      uniform.cursor,
      cursorEnabled ? cursorPresence : 0,
      UNIFORMS.cursorStrength,
      UNIFORMS.cursorRadius,
      0,
    );
    context.drawArrays(context.TRIANGLES, 0, 3);
  };

  /**
   * 30 fps while the swirl is still catching up with the pointer, 12 otherwise.
   *
   * "Otherwise" is not just a pointer that is elsewhere: a pointer resting
   * INSIDE the canvas has a settled swirl, and the frames it produces differ
   * only by the drift underneath — which nobody can tell apart at 12. The rate
   * goes back up the instant the pointer moves, because `updatePointerTarget`
   * pulls the next frame forward rather than waiting out the idle interval.
   */
  const chasingPointer = () =>
    Math.abs(targetPresence - cursorPresence) > 0.01
    || Math.abs(targetX - mouseX) > 0.002
    || Math.abs(targetY - mouseY) > 0.002;
  const frameInterval = () =>
    (chasingPointer() ? BACKDROP_FRAME_MS : BACKDROP_IDLE_FRAME_MS);

  const canAnimate = () =>
    !reduceMotion && !lowPower && !disposed && visible && focused && inView;

  /**
   * Twenty seconds after the last sign of life, stop drawing and keep the frame.
   *
   * A picker left open is the steady state — it sits behind a terminal or under
   * a chat the user is reading, drifting at a rate nobody is watching. The
   * canvas holds whatever it last composited, so freezing costs nothing visible;
   * `wake()` starts it again on the first pointer move or focus.
   */
  const frozen = () =>
    !chasingPointer()
    && performance.now() - lastActivity >= BACKDROP_IDLE_FREEZE_MS;

  /**
   * Sleep to the frame's deadline on a timer, and only then ask for a frame.
   *
   * The obvious loop — rAF every frame, skip the ones that arrive early — costs
   * one callback per DISPLAY refresh, and this repo is developed on a 240Hz
   * panel: measured in the real pane that was `240 rAF/s to draw 30`, and a
   * page with a pending rAF is a page Chromium schedules a BeginFrame for on
   * every vsync. Waiting on a timer instead means roughly one wake-up per drawn
   * frame, and the trailing `requestAnimationFrame` keeps the draw itself on
   * the compositor's own beat.
   */
  function requestRender() {
    if (!canAnimate() || frozen()) return;
    if (raf !== 0 || frameTimer !== 0) return;
    const wait = lastDrawn === 0
      ? 0
      // A couple of milliseconds early, so the rAF that follows lands on the
      // first vsync at or after the deadline rather than the one after it.
      : Math.max(0, frameInterval() - (performance.now() - lastDrawn) - 2);
    if (wait <= 1) {
      raf = requestAnimationFrame(render);
      return;
    }
    frameTimer = window.setTimeout(() => {
      frameTimer = 0;
      if (!canAnimate() || frozen()) return;
      raf = requestAnimationFrame(render);
    }, wait);
  }

  /**
   * Pull a sleeping frame forward.
   *
   * The idle interval is 83ms, and the pointer is the one input that must not
   * wait that long to be answered — entering the canvas would otherwise stutter
   * by up to a frame and a half before the swirl moved at all.
   */
  function requestRenderNow() {
    if (frameTimer !== 0) {
      window.clearTimeout(frameTimer);
      frameTimer = 0;
    }
    requestRender();
  }

  /** Someone is here again: restart the freeze clock and draw now. */
  function wake() {
    lastActivity = performance.now();
    requestRenderNow();
  }

  function render(now: number) {
    raf = 0;
    if (!canAnimate() || frozen()) return;
    // Gated on the timestamp as well as on the timer above: a coalesced or late
    // frame is skipped and re-requested rather than drawn early.
    if (lastDrawn !== 0 && now - lastDrawn < frameInterval() - 3) {
      requestRender();
      return;
    }
    const dt = lastNow === null ? 0 : Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    lastDrawn = now;
    const follow = 1 - Math.exp(-12 * dt);
    mouseX += (targetX - mouseX) * follow;
    mouseY += (targetY - mouseY) * follow;
    cursorPresence += (targetPresence - cursorPresence) * follow;
    draw(((now - start) / 1000) * UNIFORMS.timeScale);
    requestRender();
  }

  const stop = () => {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (frameTimer !== 0) {
      window.clearTimeout(frameTimer);
      frameTimer = 0;
    }
    lastNow = null;
  };

  const updatePointerTarget = () => {
    if (!pointerKnown || bounds.width === 0 || bounds.height === 0) return;
    const inside = pointerClientX >= bounds.left
      && pointerClientX <= bounds.right
      && pointerClientY >= bounds.top
      && pointerClientY <= bounds.bottom;
    if (!inside) {
      targetPresence = 0;
      requestRender();
      return;
    }
    const nextX = ((pointerClientX - bounds.left) / bounds.width) * 2 - 1;
    const nextY = -(((pointerClientY - bounds.top) / bounds.height) * 2 - 1);
    // Entering from cold: jump rather than sweep the swirl in from wherever
    // the pointer happened to leave last time.
    if (targetPresence === 0 && cursorPresence < 0.01) {
      mouseX = nextX;
      mouseY = nextY;
    }
    targetX = nextX;
    targetY = nextY;
    targetPresence = 1;
    // The pointer is the one input that must not wait out an idle interval.
    requestRenderNow();
  };

  /**
   * Window-level, always attached: a pointer move is what un-freezes the drift,
   * and on a device that cannot hover it is the ONLY thing that does.
   *
   * It deliberately does not measure. `getBoundingClientRect` forces layout, and
   * this fires on every move across the whole window — a pane that also holds a
   * terminal and a chat stream was being reflowed hundreds of times a second to
   * answer a question the ResizeObserver, the scroll listener and the resize
   * listener already keep `bounds` current for.
   */
  const onPointerMove = (event: PointerEvent) => {
    lastActivity = performance.now();
    if (!cursorEnabled) {
      requestRender();
      return;
    }
    pointerKnown = true;
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    updatePointerTarget();
  };
  const onPointerLeave = () => {
    pointerKnown = false;
    targetPresence = 0;
    requestRender();
  };
  const measureLayout = () => {
    bounds = canvas.getBoundingClientRect();
    if (resizeCanvas() && reduceMotion) draw(0);
    lastActivity = performance.now();
    updatePointerTarget();
    requestRender();
  };
  /**
   * One measurement per frame, never one per event.
   *
   * `getBoundingClientRect` forces layout, and this is wired to capture-phase
   * scroll: a wheel gesture over the picker fires it dozens of times a frame,
   * and every one of those was a synchronous reflow of a pane that also holds
   * a terminal and a chat stream. The rect cannot change more than once per
   * frame anyway, so coalescing loses nothing.
   */
  const updateLayout = () => {
    if (layoutRaf !== 0 || disposed) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      if (!disposed) measureLayout();
    });
  };
  const onVisibilityChange = () => {
    visible = document.visibilityState === "visible";
    if (visible) wake();
    else stop();
  };
  const onWindowFocus = () => {
    focused = true;
    wake();
  };
  const onWindowBlur = () => {
    focused = false;
    targetPresence = 0;
    pointerKnown = false;
    stop();
  };

  /**
   * The GPU took the context back — a driver reset, a tab evicted for being
   * over the context limit, a machine waking from sleep.
   *
   * No `preventDefault`: that asks for `webglcontextrestored`, and the backdrop
   * would then have to rebuild the program on a machine that has just proven it
   * is short of GPU. The static gradient is the honest answer, and it costs
   * nothing.
   */
  const onContextLost = () => {
    disposed = true;
    stop();
    onRefused();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  window.addEventListener("resize", updateLayout);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  if (cursorEnabled) {
    window.addEventListener("pointercancel", onPointerLeave);
    window.addEventListener("scroll", updateLayout, true);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
  }

  const resizeObserver = new ResizeObserver(updateLayout);
  resizeObserver.observe(canvas);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    inView = entry?.isIntersecting ?? true;
    if (inView) wake();
    else stop();
  });
  intersectionObserver.observe(canvas);

  /**
   * A machine running the battery down gets the static frame.
   *
   * `navigator.getBattery` is not in an Electron renderer (nor in Firefox or
   * Safari), so this is strictly opportunistic: where the API is missing the
   * backdrop behaves exactly as before. Where it exists, a device under 20% and
   * not charging is one where the user would rather have the screen than the
   * gradient — the canvas keeps its last composited frame, like the
   * reduced-motion path, and plugging in brings the drift back.
   */
  let detachBattery: (() => void) | null = null;
  const battery = (navigator as unknown as {
    getBattery?: () => Promise<{
      charging: boolean;
      level: number;
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    }>;
  }).getBattery;
  if (!reduceMotion && typeof battery === "function") {
    battery.call(navigator).then((status) => {
      if (disposed) return;
      const sync = () => {
        const next = !status.charging && status.level <= 0.2;
        if (next === lowPower) return;
        lowPower = next;
        if (lowPower) stop();
        else requestRender();
      };
      status.addEventListener("levelchange", sync);
      status.addEventListener("chargingchange", sync);
      detachBattery = () => {
        status.removeEventListener("levelchange", sync);
        status.removeEventListener("chargingchange", sync);
      };
      sync();
    }).catch(() => {
      // No battery, or a platform that refuses to answer. Keep drifting.
    });
  }

  // One frame unconditionally, before any of the gates get a say: a window
  // that is blurred or a tab that is hidden at mount would otherwise show an
  // empty canvas over the pane until it was looked at.
  draw(0);
  if (!reduceMotion) requestRender();

  return {
    dispose: () => {
      disposed = true;
      stop();
      if (layoutRaf !== 0) {
        cancelAnimationFrame(layoutRaf);
        layoutRaf = 0;
      }
      detachBattery?.();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pointermove", onPointerMove);
      if (cursorEnabled) {
        window.removeEventListener("pointercancel", onPointerLeave);
        window.removeEventListener("scroll", updateLayout, true);
        document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      }
      context.deleteBuffer(buffer);
      context.deleteProgram(program);
      const releaseTimer = window.setTimeout(() => {
        if (pendingContextReleases.get(canvas) !== releaseTimer) return;
        pendingContextReleases.delete(canvas);
        releaseContext(context, canvas);
      }, 0);
      pendingContextReleases.set(canvas, releaseTimer);
    },
  };
}
