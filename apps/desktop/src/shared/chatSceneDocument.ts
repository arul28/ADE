import {
  SCENE_CONTENT_SECURITY_POLICY,
  SCENE_FALLBACK_THEME,
  SCENE_LIMITS,
  SCENE_SETTLE_MAX_MS,
  SCENE_SETTLE_QUIET_MS,
  sceneThemeVariables,
  type SceneTheme,
} from "./chatScene";

/**
 * Assembling the document a scene frame loads: the CSP, the frame's base
 * styles, the injected values, and the in-frame SDK (`window.ade`).
 *
 * Kept apart from `chatScene.ts`, which owns the fence, the theme and the
 * message protocol: the SDK is a few hundred lines of ES5 that runs on the
 * other side of the sandbox and shares nothing else with them. This module
 * imports from `chatScene.ts` and never the reverse.
 */

/**
 * A value as a `<script>` literal. `</script>` inside a JSON blob would close
 * the tag early, and U+2028 / U+2029 are legal in a JSON string but literal
 * line terminators in JS source, so all three travel as escapes.
 */
export function escapeForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The in-frame SDK.
 *
 * Deliberately dependency-free: the frame has `connect-src 'none'`, so it could
 * not fetch an animation library even if one were referenced, and inlining a
 * third-party one would put its licence inside every generated view. The Web
 * Animations API and CSS animations are native to Chromium, cost nothing, and
 * are what models reach for anyway.
 *
 * A const rather than a function: it never varies, so building it per scene
 * only re-trimmed the same four kilobytes.
 */
const SCENE_SDK_SOURCE = `
(function () {
  var listeners = Object.create(null);
  var reducedMotion = false;
  try { reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  /*
   * Restored: this scene already played once and is being brought back (it
   * scrolled back into view, or a reopened chat is waking its still). Its
   * entrance must not replay: ade.animate and ade.countUp jump to their end
   * state, and finite CSS animations started while restoring are finished on
   * the spot, so the live frame comes up looking like the still it replaces.
   * Ends at the first settle.
   */
  var restoring = !!window.__ADE_SCENE_RESTORED__;

  // Measure the CONTENT, not the frame. document.documentElement is sized by
  // the iframe element itself, so measuring it lets a scene grow but never
  // shrink below the host's initial guess.
  function measure() {
    var body = document.body;
    if (!body) return 0;
    var style = window.getComputedStyle(body);
    return Math.ceil(body.scrollHeight + parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0"));
  }

  // Every message carries the nonce of the document it was sent from. The host
  // keeps ONE mounted frame and swaps its src, and a contentWindow's identity
  // survives that swap — so without this an outgoing document's late 'settled'
  // is indistinguishable from the incoming one's.
  function post(type, payload) {
    var message = { __adeScene: 1, type: type, payload: payload };
    try {
      if (window.__ADE_SCENE_NONCE__) message.nonce = String(window.__ADE_SCENE_NONCE__);
    } catch (e) {}
    try { parent.postMessage(message, "*"); } catch (e) {}
  }

  function emitLocal(type, payload) {
    var fns = (listeners[type] || []).slice();
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](payload); } catch (e) { post("error", { message: String(e && e.message || e) }); }
    }
  }

  var ade = {
    data: window.__ADE_SCENE_DATA__ || null,
    theme: window.__ADE_SCENE_THEME__ || null,
    reducedMotion: reducedMotion,
    restored: restoring,
    on: function (event, fn) {
      if (typeof fn !== "function") return function () {};
      (listeners[event] = listeners[event] || []).push(fn);
      // Data that already arrived is delivered to a late listener too, so a
      // scene can register after its first snapshot without missing it.
      if (event === "data" && ade.data !== null) {
        // The snapshot current when this fires, not when it was scheduled: a
        // newer one may have arrived in between.
        setTimeout(function () {
          try { fn(ade.data); } catch (e) { post("error", { message: String(e && e.message || e) }); }
        }, 0);
      }
      return function () {
        listeners[event] = (listeners[event] || []).filter(function (f) { return f !== fn; });
      };
    },
    emit: function (name, payload) { post("emit", { name: String(name), payload: payload }); },
    /** Open an ade:// link in ADE or an http(s) page in ADE's browser. Needs a click in the scene. */
    open: function (url) { post("open", { url: String(url) }); },
    ready: function () { post("ready", { height: measure() }); },
    resize: function () { post("resize", { height: measure() }); },
    /** WAAPI wrapper that collapses to the end state under reduced motion. */
    animate: function (target, keyframes, options) {
      var el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return null;
      var opts = Object.assign({ duration: 420, easing: "cubic-bezier(.22,.61,.36,1)", fill: "both" }, options || {});
      if (reducedMotion || restoring) { opts.duration = 0; opts.delay = 0; }
      return el.animate(keyframes, opts);
    },
    /** Count a number up; the single most-wanted effect in a live view. */
    countUp: function (target, to, options) {
      var el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return;
      var o = options || {};
      var from = typeof o.from === "number" ? o.from : 0;
      var duration = reducedMotion || restoring ? 0 : (typeof o.duration === "number" ? o.duration : 900);
      var decimals = typeof o.decimals === "number" ? o.decimals : 0;
      if (duration <= 0) { el.textContent = Number(to).toFixed(decimals); return; }
      var start = null;
      function frame(now) {
        if (start === null) start = now;
        var t = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = (from + (to - from) * eased).toFixed(decimals);
        if (t < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    },
  };

  window.ade = ade;

  // The host sends the theme with the exact variables it becomes, so a live
  // switch sets what the first paint set (sceneThemeMessage).
  function applyTheme(payload) {
    if (!payload || typeof payload !== "object" || !payload.theme) return;
    var root = document.documentElement;
    var pairs = Array.isArray(payload.variables) ? payload.variables : [];
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      if (pair && typeof pair[0] === "string" && typeof pair[1] === "string" && pair[1].length) {
        root.style.setProperty(pair[0], pair[1]);
      }
    }
    var scheme = payload.theme.scheme;
    if (scheme === "light" || scheme === "dark") root.style.colorScheme = scheme;
    ade.theme = payload.theme;
  }

  // Only the parent may speak to a scene. Anything else that posts here (a
  // nested window the scene opened, another frame) is ignored.
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.__adeSceneHost !== 1 || typeof msg.type !== "string") return;
    if (msg.type === "theme") {
      applyTheme(msg.payload);
      wake(1500);
      emitLocal("theme", ade.theme);
      return;
    }
    if (msg.type === "data") { ade.data = msg.payload; wake(1500); }
    emitLocal(msg.type, msg.payload);
  });

  // A link in a scene goes through ADE rather than navigating the frame (which
  // is blocked): ade:// opens in ADE, http(s) in ADE's browser.
  document.addEventListener("click", function (event) {
    var target = event.target;
    var anchor = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
    if (!anchor) return;
    var href = anchor.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;
    event.preventDefault();
    post("open", { url: href });
  }, true);

  // Blocked requests are the most common silent failure; say what was blocked.
  var policyReports = 0;
  document.addEventListener("securitypolicyviolation", function (event) {
    if (policyReports >= 5) return;
    policyReports += 1;
    // Marked as a policy block: a blocked font or image is not a scene that
    // failed to draw, and the host must not treat it as one.
    post("error", { message: "Blocked by the scene policy (" + event.effectiveDirective + "): " + (event.blockedURI || "inline"), policy: true });
  });

  window.addEventListener("error", function (event) {
    post("error", { message: String(event.message || "scene error") });
  });

  /*
   * Idle: a settled scene nobody is touching should cost nothing.
   *
   * A view that loops (a spinner, a pulsing dot, a canvas particle field) keeps
   * the GPU compositing every frame at the display's refresh rate — 240 times a
   * second on the panels ADE is developed on — for a picture that is not
   * changing what it says. So once the scene has settled and the pointer and
   * focus are elsewhere: endless animations pause where they are, SVG (SMIL)
   * animations pause, and requestAnimationFrame callbacks are batched into a
   * few frames a second rather than dropped, so a scene that redraws on new
   * data still redraws. Pointer, focus, wheel or a key wakes it at full rate.
   */
  var IDLE_RAF_INTERVAL_MS = 250;
  var IDLE_AFTER_LEAVE_MS = 1200;
  var settleReported = false;
  var engaged = false;
  var idle = false;
  var paused = [];
  var idleTimer = null;
  var wakeUntil = 0;
  var nativeRaf = window.requestAnimationFrame.bind(window);
  var nativeCaf = window.cancelAnimationFrame.bind(window);
  var rafQueue = [];
  var rafSeq = 0;
  var rafFlush = null;
  // Ids cancelled after their callback left the queue for a flush batch that
  // has not run yet. Without this a cancel in that gap was silently ignored.
  var rafCancelled = Object.create(null);
  var rafBatchesPending = 0;

  function flushRafQueue() {
    rafFlush = null;
    if (!rafQueue.length) return;
    var batch = rafQueue;
    rafQueue = [];
    rafBatchesPending += 1;
    nativeRaf(function (now) {
      for (var i = 0; i < batch.length; i++) {
        var entry = batch[i];
        if (rafCancelled[entry.id]) continue;
        try { entry.cb(now); } catch (e) { post("error", { message: String(e && e.message || e) }); }
      }
      // With no batch in flight, every remembered cancel is moot (its callback
      // ran or was skipped), so the record cannot grow.
      rafBatchesPending -= 1;
      if (rafBatchesPending === 0) rafCancelled = Object.create(null);
    });
  }

  window.requestAnimationFrame = function (cb) {
    if (!idle) return nativeRaf(cb);
    rafSeq += 1;
    // Negative ids never collide with the browser's own positive handles.
    var id = -rafSeq;
    rafQueue.push({ id: id, cb: cb });
    if (rafFlush === null) rafFlush = setTimeout(flushRafQueue, IDLE_RAF_INTERVAL_MS);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (typeof id === "number" && id < 0) {
      var before = rafQueue.length;
      rafQueue = rafQueue.filter(function (entry) { return entry.id !== id; });
      // Not in the queue: it may be in a batch waiting for its frame.
      if (rafQueue.length === before) rafCancelled[id] = true;
      return;
    }
    nativeCaf(id);
  };

  function isEndless(animation) {
    try {
      return animation.effect && animation.effect.getComputedTiming().endTime === Infinity;
    } catch (e) {
      return false;
    }
  }

  // SVG <animate>/<animateTransform> (SMIL) is not in getAnimations(), and
  // Chromium repaints an animated SVG on the main thread every frame.
  function setSvgPaused(pause) {
    try {
      var svgs = document.querySelectorAll("svg");
      for (var i = 0; i < svgs.length; i++) {
        var svg = svgs[i];
        if (pause && typeof svg.pauseAnimations === "function") svg.pauseAnimations();
        if (!pause && typeof svg.unpauseAnimations === "function") svg.unpauseAnimations();
      }
    } catch (e) {}
  }

  function pauseEndless() {
    try {
      var running = document.getAnimations();
      for (var i = 0; i < running.length; i++) {
        var a = running[i];
        if (a.playState === "running" && isEndless(a)) { a.pause(); paused.push(a); }
      }
    } catch (e) {}
    setSvgPaused(true);
  }

  function setIdle(next) {
    if (idle === next) return;
    idle = next;
    if (idle) { pauseEndless(); return; }
    var resume = paused;
    paused = [];
    for (var i = 0; i < resume.length; i++) { try { resume[i].play(); } catch (e) {} }
    setSvgPaused(false);
    if (rafFlush !== null) { clearTimeout(rafFlush); rafFlush = null; }
    flushRafQueue();
  }

  function scheduleIdle(delay) {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      idleTimer = null;
      var remaining = wakeUntil - Date.now();
      if (remaining > 0) { scheduleIdle(remaining); return; }
      if (settleReported && !engaged) setIdle(true);
    }, delay);
  }

  /** Run at full rate for a moment: a new theme or new data arrived. */
  function wake(ms) {
    wakeUntil = Math.max(wakeUntil, Date.now() + ms);
    setIdle(false);
    scheduleIdle(ms);
  }

  function engage() {
    engaged = true;
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    setIdle(false);
  }
  function disengage() {
    engaged = false;
    scheduleIdle(IDLE_AFTER_LEAVE_MS);
  }
  document.addEventListener("pointerover", engage, true);
  document.addEventListener("pointerdown", engage, true);
  document.addEventListener("wheel", engage, { capture: true, passive: true });
  document.addEventListener("keydown", engage, true);
  document.addEventListener("pointerout", function (event) {
    // relatedTarget is null only when the pointer left this document.
    if (!event.relatedTarget) disengage();
  }, true);
  window.addEventListener("blur", function () { if (engaged) disengage(); });

  // An endless animation that starts while idle (a row turning into a spinner
  // on new data) is paused as soon as it appears.
  var idleWatch = null;
  try {
    idleWatch = new MutationObserver(function () {
      if (!idle) return;
      setTimeout(function () { if (idle) pauseEndless(); }, 50);
    });
  } catch (e) {}

  // Report height once layout settles so the host can size the frame, and again
  // on any resize the scene causes itself.
  function reportHeight() { post("resize", { height: measure() }); }

  /*
   * Settle watch: tell the host the moment this view has finished moving.
   *
   * The host needs it because a scene's still has to be taken WHILE the scene
   * is still up, after the animation the author wrote has played.
   *
   * Two signals, because neither alone is enough. getAnimations() sees
   * WAAPI and CSS animations (ade.animate, a keyframed reveal) but not a
   * requestAnimationFrame loop; the MutationObserver sees ade.countUp writing
   * into a text node but not a transform that never touches the DOM. Quiet on
   * both for SETTLE_QUIET_MS is the definition of stopped. Endless animations
   * never finish, so they do not hold a settle back.
   *
   * Reported exactly once. A scene that keeps changing forever hits the cap
   * and is reported anyway — a frame of a loop is a truthful picture of a view
   * that loops — and a late mutation after that must not produce a second
   * settle, because the host acts on the first one.
   */
  var quietTimer = null;
  var capTimer = null;
  var settleObserver = null;

  function animationsRunning() {
    try {
      if (typeof document.getAnimations !== "function") return false;
      var running = document.getAnimations();
      for (var i = 0; i < running.length; i++) {
        if (running[i].playState === "running" && !isEndless(running[i])) return true;
      }
      return false;
    } catch (e) {
      // A browser without the API cannot report an animation; the mutation
      // half still speaks for itself.
      return false;
    }
  }

  // While restoring, a finite CSS animation is the entrance replaying: finish it.
  function finishEntrances() {
    if (!restoring) return;
    try {
      var running = document.getAnimations();
      for (var i = 0; i < running.length; i++) {
        if (!isEndless(running[i])) { try { running[i].finish(); } catch (e) {} }
      }
    } catch (e) {}
  }

  function reportSettled() {
    if (settleReported) return;
    settleReported = true;
    restoring = false;
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (capTimer !== null) clearTimeout(capTimer);
    try { if (settleObserver) settleObserver.disconnect(); } catch (e) {}
    try {
      if (idleWatch) idleWatch.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch (e) {}
    post("settled", { height: measure() });
    if (!engaged) scheduleIdle(0);
  }

  function armQuiet() {
    if (settleReported) return;
    finishEntrances();
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(function () {
      // Re-arm rather than settle while something finite is still playing: a
      // long animation mutates nothing, so the debounce alone would call it
      // quiet half a second in.
      if (animationsRunning()) { armQuiet(); return; }
      reportSettled();
    }, ${SCENE_SETTLE_QUIET_MS});
  }

  function watchForSettle() {
    if (settleObserver || settleReported) return;
    try {
      settleObserver = new MutationObserver(armQuiet);
      settleObserver.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
    } catch (e) {
      settleObserver = null;
    }
    capTimer = setTimeout(reportSettled, ${SCENE_SETTLE_MAX_MS});
    armQuiet();
  }

  window.addEventListener("load", function () {
    finishEntrances();
    reportHeight();
    post("ready", { height: measure() });
    // Started from 'ready' on purpose: the cap is measured from the moment the
    // scene is up, not from a document that has not run its script yet.
    watchForSettle();
  });
  if (typeof ResizeObserver === "function") {
    try { new ResizeObserver(reportHeight).observe(document.body); } catch (e) {}
  }
})();
`.trim();

/**
 * The frame's own defaults. No padding: a scene's content lines up with the
 * reply text around it, the way a chart in a document does, and a scene that
 * wants a card draws one. `flow-root` keeps a first heading's margin inside the
 * measured height instead of collapsing out of the body and getting clipped.
 */
function baseStyles(theme: SceneTheme, fontFaceCss: string): string {
  const variables = sceneThemeVariables(theme).map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `
${fontFaceCss}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  display: flow-root;
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: var(--font-size);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}
:root {
${variables}
  color-scheme: ${theme.scheme};
}
a { color: var(--accent); }
code, pre, kbd, samp { font-family: var(--font-mono); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg) 18%, transparent); border-radius: 999px; }
::-webkit-scrollbar-track { background: transparent; }
`.trim();
}

export type SceneDocumentArgs = {
  html: string;
  title?: string | null;
  theme?: SceneTheme;
  data?: unknown;
  /**
   * Transcript-row key. It lands on `<body>` so two byte-identical scenes at
   * different positions produce different documents — without it the host's
   * memo yields the same string and both rows share one frame.
   */
  scopeKey?: string | null;
  /**
   * This DOCUMENT's identity, echoed back on every message the frame sends.
   *
   * The scope key cannot do this job: it names a scene's position in the
   * transcript, and a caller may swap document after document into one frame
   * under one key. What the host has to tell apart is the outgoing document
   * from the incoming one, and only a value minted per build can do that.
   *
   * Carried in the document itself, so it survives both delivery paths — the
   * `ade-scene:` URL and the blob fallback both serve these exact bytes.
   */
  nonce?: string | null;
  /**
   * This scene already played once and is being brought back on screen; its
   * entrance animations must not replay. See the SDK's `restoring`.
   */
  restored?: boolean;
  /**
   * `@font-face` rules for ADE's own fonts, as data URLs (the frame may load
   * fonts from `data:` only). Empty means the system fallbacks in the theme.
   */
  fontFaceCss?: string;
};

/**
 * The scope key, made safe for an HTML attribute without losing identity.
 *
 * A plain strip of everything outside `[A-Za-z0-9_:-]` was lossy: two transcript
 * keys differing only in stripped characters produced the same attribute, the
 * same document, and therefore the same memoized frame — the exact bug the key
 * exists to prevent. Percent-encoding is reversible, so every key stays
 * distinct, and its output is already limited to the unreserved set plus `%` —
 * none of which can close an attribute or open a tag.
 */
function sceneScopeAttribute(scopeKey: string): string {
  return encodeURIComponent(scopeKey);
}

/**
 * Host-built font CSS, kept from closing the `<style>` it is placed in. It is
 * ADE's own string, not the agent's, but it is assembled from fetched bytes, so
 * it is held to the one property that matters here.
 */
function sanitizeFontFaceCss(css: string | null | undefined): string {
  if (!css) return "";
  return /<\/style/i.test(css) ? "" : css;
}

/**
 * Assemble the document served to the frame. The CSP meta is the FIRST element
 * in <head> on purpose: a policy that arrives after markup has already parsed
 * is a policy that arrived too late. In Electron the same policy is also sent
 * as a response header by the `ade-scene:` handler, so neither half is load
 * bearing alone.
 */
export function buildSceneDocument(args: SceneDocumentArgs): string {
  const theme = args.theme ?? SCENE_FALLBACK_THEME;
  const title = (args.title ?? "Generated view").slice(0, SCENE_LIMITS.maxTitleLength);
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SCENE_CONTENT_SECURITY_POLICY}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta charset="utf-8">',
    `<title>${title.replace(/[<>&]/g, "")}</title>`,
    `<style>${baseStyles(theme, sanitizeFontFaceCss(args.fontFaceCss))}</style>`,
    "<script>",
    `window.__ADE_SCENE_DATA__ = ${escapeForScript(args.data ?? null)};`,
    `window.__ADE_SCENE_THEME__ = ${escapeForScript(theme)};`,
    `window.__ADE_SCENE_NONCE__ = ${escapeForScript(args.nonce ?? null)};`,
    `window.__ADE_SCENE_RESTORED__ = ${args.restored ? "true" : "false"};`,
    "</script>",
    `<script>${SCENE_SDK_SOURCE}</script>`,
    `</head><body${args.scopeKey ? ` data-scene-scope="${sceneScopeAttribute(args.scopeKey)}"` : ""}>`,
    args.html,
    "</body></html>",
  ].join("\n");
}
