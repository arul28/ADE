import type { ThemeId } from "../../state/appStore";
import {
  BACKDROP_FRAME_MS,
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
  let layoutRaf = 0;
  let lastNow: number | null = null;
  let lastDrawn = 0;
  let visible = document.visibilityState === "visible";
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

  function requestRender() {
    if (reduceMotion || disposed || !visible || !focused || !inView) return;
    if (raf === 0) raf = requestAnimationFrame(render);
  }

  function render(now: number) {
    raf = 0;
    if (disposed || !visible || !focused || !inView) return;
    // 30 fps, gated on the timestamp rather than on a timer: the frame is
    // simply skipped and re-requested, so a 240Hz panel costs eight cheap
    // no-ops instead of eight mesh evaluations.
    if (lastDrawn !== 0 && now - lastDrawn < BACKDROP_FRAME_MS - 1) {
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
    requestRender();
  };

  const onPointerMove = (event: PointerEvent) => {
    pointerKnown = true;
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    bounds = canvas.getBoundingClientRect();
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
    if (visible) requestRender();
    else stop();
  };
  const onWindowFocus = () => {
    focused = true;
    requestRender();
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
  if (cursorEnabled) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointercancel", onPointerLeave);
    window.addEventListener("scroll", updateLayout, true);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
  }

  const resizeObserver = new ResizeObserver(updateLayout);
  resizeObserver.observe(canvas);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    inView = entry?.isIntersecting ?? true;
    if (inView) requestRender();
    else stop();
  });
  intersectionObserver.observe(canvas);

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
      canvas.removeEventListener("webglcontextlost", onContextLost);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      if (cursorEnabled) {
        window.removeEventListener("pointermove", onPointerMove);
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
