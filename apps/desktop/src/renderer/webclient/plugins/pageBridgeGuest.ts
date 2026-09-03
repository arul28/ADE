/**
 * The script that runs INSIDE a plugin page's frame in the hosted web client.
 *
 * It is one exported function on purpose. The host stringifies it into the
 * bootstrap document the service worker serves — the guest's origin is opaque,
 * so it can fetch nothing from the app: not a module, not this file, not the
 * plugin's own bytes. Everything it runs it must already have, and everything
 * it needs it must be given over `postMessage`.
 *
 * Two consequences that constrain how this file may be edited:
 *
 * 1. **The function closes over nothing.** No imports (types only, which erase),
 *    no module-level constants, no shared helpers. `Function.prototype.toString`
 *    is what ships, and a reference to an identifier outside the function is a
 *    `ReferenceError` in the frame that no test of this file would catch. Every
 *    helper lives inside.
 * 2. **No syntax that a bundler lowers into a helper call.** Object and array
 *    spread, `async`/`await` and class fields can all compile into references
 *    to a `__spread`/`__async` helper hoisted to module scope — outside the
 *    string. `Object.assign`, `.concat`, and plain promise chains cannot.
 *
 * ## Why the plugin's own files become blob URLs
 *
 * The frame is served with `Content-Security-Policy: sandbox allow-scripts`, so
 * it has an opaque origin, which is what keeps a plugin out of the reader's
 * session, storage and DOM. The price is that a service worker cannot control
 * it — a worker matches a registration by the client's storage key, and an
 * opaque origin has none (w3c/ServiceWorker#648) — so the page's `app.js` can
 * be reached over no URL the browser will fetch. What an opaque origin CAN do
 * is create and load its own blobs. So the host posts the bytes in, the guest
 * mints one blob URL per file, and the plugin's `index.html` is rewritten to
 * point at them.
 *
 * Rewriting reaches into the JavaScript because a blob URL has an opaque path:
 * `new URL("./chunk.js", "blob:https://host/uuid")` throws, so a relative
 * import inside a blob module cannot resolve, and an import map cannot rescue
 * it either (a `./`-keyed entry is normalized against the DOCUMENT's base, not
 * the importer's). Each file's import specifiers are therefore replaced with
 * the blob URL of the file they name, leaves first, so every module still
 * resolves to ONE blob and module identity — the thing that keeps a single copy
 * of React alive — is preserved.
 */

import type { PluginPageGuestConfig } from "./pageProtocol";

/**
 * Everything the guest does, as one self-contained function.
 *
 * Exported so it can be called directly against a fake window in a test, which
 * is the only way any of this is testable: the shipped copy is a string.
 */
export function pluginPageGuestMain(config: PluginPageGuestConfig): void {
  var CHANNEL = "ade-plugin-page";
  var VERSION = 1;
  var BRIDGE_FALLBACK_VERSION = 2;
  var host = window.parent;
  var nonce = config.nonce;
  var parentOrigin = config.parentOrigin;
  var nextRequestId = 1;
  var pending: Record<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = {};
  var listeners: Record<string, Array<(payload: unknown) => void>> = { changed: [], theme: [], host: [] };
  var booted = false;

  function post(body: Record<string, unknown>): void {
    var message = Object.assign({}, body);
    message.channel = CHANNEL;
    message.v = VERSION;
    message.nonce = nonce;
    // Named, never "*": the guest must not spray its plugin's data at whatever
    // window happens to be its parent if the frame is ever re-parented.
    host.postMessage(message, parentOrigin);
  }

  function call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise(function (resolve, reject) {
      var id = nextRequestId;
      nextRequestId += 1;
      pending[String(id)] = { resolve: resolve, reject: reject };
      post({ kind: "request", id: id, method: method, params: params || {} });
    });
  }

  window.addEventListener("message", function (event: MessageEvent) {
    // Identity first. `event.origin` is the host's, but a check on it would
    // only prove which origin sent the message, not which window — and every
    // frame in the app shares that origin.
    if (event.source !== host) return;
    var data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (data.channel !== CHANNEL || data.v !== VERSION || data.nonce !== nonce) return;
    if (data.kind === "response") {
      var entry = pending[String(data.id)];
      if (!entry) return;
      delete pending[String(data.id)];
      if (data.ok) entry.resolve(data.value);
      else entry.reject(new Error(typeof data.message === "string" ? data.message : "The host refused that."));
      return;
    }
    if (data.kind === "event") {
      var name = String(data.event);
      var bucket = listeners[name];
      if (!bucket) return;
      for (var index = 0; index < bucket.length; index += 1) {
        try {
          bucket[index](data.payload);
        } catch (error) {
          // One listener's failure must not stop the page hearing the next one.
          console.error("[ade plugin page] listener failed", error);
        }
      }
    }
  });

  function on(event: string, listener: (payload: unknown) => void): () => void {
    var bucket = listeners[event];
    if (!bucket || typeof listener !== "function") return function () { /* nothing subscribed */ };
    bucket.push(listener);
    return function () {
      var at = bucket.indexOf(listener);
      if (at >= 0) bucket.splice(at, 1);
    };
  }

  // -------------------------------------------------------------------------
  // window.adePlugin
  // -------------------------------------------------------------------------

  var bridge = {
    version: BRIDGE_FALLBACK_VERSION,
    pluginId: config.pluginId,
    context: null as unknown,
    collections: {
      get: function (collection: string, key: string) {
        return call("collections.get", { collection: collection, key: key });
      },
      put: function (collection: string, key: string, value: unknown) {
        return call("collections.put", { collection: collection, key: key, value: value }).then(noop);
      },
      list: function (collection: string, options?: Record<string, unknown>) {
        return call("collections.list", Object.assign({ collection: collection }, options || {}));
      },
    },
    invoke: function (action: string, args?: Record<string, unknown>) {
      return call("invoke", { action: action, args: args || {} });
    },
    config: {
      get: function () {
        return call("config.get", {});
      },
      set: function (keyOrValues: unknown, value?: unknown) {
        if (typeof keyOrValues === "string") return call("config.set", { key: keyOrValues, value: value });
        return call("config.set", { values: keyOrValues });
      },
    },
    events: { on: on },
    openDeeplink: function (url: string) {
      return call("openDeeplink", { url: url }).then(noop);
    },
    openSettings: function (target: Record<string, unknown>) {
      return call("openSettings", { target: target }).then(noop);
    },
    surface: {
      close: function () {
        return call("surface.close", {}).then(noop);
      },
    },
    composer: {
      attach: function (issue: Record<string, unknown>) {
        return call("composer.attach", { issue: issue }).then(noop);
      },
      insert: function (text: string) {
        return call("composer.insert", { text: text }).then(noop);
      },
    },
    ui: {
      toast: function (toast: Record<string, unknown>) {
        return call("ui.toast", { toast: toast });
      },
      dismissToast: function (id: string) {
        return call("ui.dismissToast", { id: id }).then(noop);
      },
      prompt: function (prompt: Record<string, unknown>) {
        return call("ui.prompt", { prompt: prompt });
      },
      confirm: function (request: Record<string, unknown>) {
        return call("ui.confirm", { confirm: request });
      },
      // The five host pickers, each forwarding its own arguments. A client that
      // cannot draw one refuses with a sentence; a reader who dismissed one
      // answers null. Neither is invented here — the host decides which.
      pickModel: function (request?: Record<string, unknown>) {
        return call("ui.pickModel", request || {});
      },
      pickLane: function (request?: Record<string, unknown>) {
        return call("ui.pickLane", request || {});
      },
      pickPermissionMode: function (request: Record<string, unknown>) {
        return call("ui.pickPermissionMode", request || {});
      },
      pickReasoningEffort: function (request: Record<string, unknown>) {
        return call("ui.pickReasoningEffort", request || {});
      },
      pickProvider: function (request?: Record<string, unknown>) {
        return call("ui.pickProvider", request || {});
      },
      openPathInEditor: function (request: Record<string, unknown>) {
        return call("ui.openPathInEditor", request || {}).then(noop);
      },
    },
    sockets: {
      list: function (socket: string) {
        return call("sockets.list", { socket: socket });
      },
      invoke: function (socketId: string, args?: Record<string, unknown>) {
        return call("sockets.invoke", { socketId: socketId, args: args || {} });
      },
    },
    hostEngine: {
      place: function (request: Record<string, unknown>) {
        return call("hostEngine.place", request || {}).then(noop);
      },
      release: function () {
        return call("hostEngine.release", {}).then(noop);
      },
    },
    clipboard: {
      read: function () {
        return call("clipboard.read", {});
      },
      write: function (text: string) {
        return call("clipboard.write", { text: text }).then(noop);
      },
    },
    theme: {
      get: function () {
        return call("theme.get", {});
      },
    },
    host: {
      subscribe: function (options: Record<string, unknown>) {
        return call("host.subscribe", { kinds: (options || {}).kinds }).then(function (token) {
          return function () {
            void call("host.unsubscribe", { token: token }).catch(noop);
          };
        });
      },
    },
  };

  function noop(): void {
    /* a verb that only does something answers undefined */
  }

  (window as unknown as Record<string, unknown>).adePlugin = bridge;

  // -------------------------------------------------------------------------
  // Boot: ask for the bytes, then draw the plugin's own document
  // -------------------------------------------------------------------------

  post({ kind: "ready" });

  call("page.boot", {}).then(
    function (payload) {
      if (booted) return;
      booted = true;
      draw(payload as Record<string, unknown>);
    },
    function (error: Error) {
      showFailure(error && error.message ? error.message : "This page didn’t load.");
    },
  );

  function draw(payload: Record<string, unknown>): void {
    bridge.version = typeof payload.bridgeVersion === "number" ? payload.bridgeVersion : BRIDGE_FALLBACK_VERSION;
    bridge.pluginId = typeof payload.pluginId === "string" ? payload.pluginId : config.pluginId;
    bridge.context = payload.context || null;
    applyTheme(payload.theme as Record<string, unknown> | null);
    on("theme", function (snapshot) {
      applyTheme(snapshot as Record<string, unknown> | null);
    });

    var files = (payload.files || []) as Array<{ path: string; mime: string; bytes: ArrayBuffer }>;
    var byPath: Record<string, { mime: string; bytes: ArrayBuffer }> = {};
    for (var index = 0; index < files.length; index += 1) {
      byPath[files[index].path] = { mime: files[index].mime, bytes: files[index].bytes };
    }
    var entry = String(payload.entry || "index.html");
    var entryFile = byPath[entry];
    if (!entryFile) {
      showFailure("This page didn’t load.");
      return;
    }

    var urls: Record<string, string> = {};
    var building: Record<string, boolean> = {};

    function blobUrlFor(path: string): string | null {
      if (Object.prototype.hasOwnProperty.call(urls, path)) return urls[path];
      var file = byPath[path];
      if (!file) return null;
      // A cycle in the import graph. Bundler output has none; a hand-written
      // page could. The specifier is left alone rather than pointed at a blob
      // that does not exist yet, so the failure is the plugin's own missing
      // module rather than a silently wrong one.
      if (building[path]) return null;
      building[path] = true;
      var bytes: BlobPart = file.bytes;
      if (isType(path, [".js", ".mjs"])) bytes = rewriteJs(decodeText(file.bytes), path);
      else if (isType(path, [".css"])) bytes = rewriteCss(decodeText(file.bytes), path);
      delete building[path];
      var url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
      urls[path] = url;
      return url;
    }

    function resolvePath(fromPath: string, specifier: string): string | null {
      var raw = String(specifier || "");
      if (!raw) return null;
      // Anything with a scheme, a protocol-relative URL or a bare specifier is
      // not this plugin's file and is left exactly as the plugin wrote it.
      if (raw.indexOf("//") === 0) return null;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
      if (raw.charAt(0) !== "." && raw.charAt(0) !== "/") return null;
      var trimmed = raw.split("?")[0].split("#")[0];
      var out: string[] = raw.charAt(0) === "/" ? [] : fromPath.split("/").slice(0, -1);
      var parts = trimmed.split("/");
      for (var part = 0; part < parts.length; part += 1) {
        var segment = parts[part];
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
          if (out.length === 0) return null;
          out.pop();
          continue;
        }
        out.push(segment);
      }
      return out.length > 0 ? out.join("/") : null;
    }

    /** A specifier's blob URL, or null to leave the source untouched. */
    function link(fromPath: string, specifier: string): string | null {
      var path = resolvePath(fromPath, specifier);
      if (!path) return null;
      return blobUrlFor(path);
    }

    function rewriteJs(source: string, fromPath: string): string {
      // Only a specifier that RESOLVES to a file in this page is rewritten,
      // which is what makes a regex safe here: a match inside an unrelated
      // string literal names no file and is left alone.
      return source.replace(
        /((?:\bfrom|\bimport|\bexport)\s*(?:\(\s*)?)(["'])([^"'\n]+)\2/g,
        function (whole, lead, quote, specifier) {
          var url = link(fromPath, specifier);
          return url ? lead + quote + url + quote : whole;
        },
      );
    }

    function rewriteCss(source: string, fromPath: string): string {
      return source.replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
        function (whole, quote, specifier) {
          var url = link(fromPath, specifier);
          return url ? "url(" + quote + url + quote + ")" : whole;
        },
      );
    }

    // The document, last: every URL it points at exists by the time it is read.
    var parsed = new DOMParser().parseFromString(decodeText(entryFile.bytes), "text/html");
    rewriteDocument(parsed, entry, link);
    adoptDocument(parsed);
    post({ kind: "resize", height: measuredHeight() });
    watchHeight();
  }

  function rewriteDocument(
    parsed: Document,
    entry: string,
    link: (fromPath: string, specifier: string) => string | null,
  ): void {
    var attributes = [
      ["script", "src"],
      ["link", "href"],
      ["img", "src"],
      ["image", "href"],
      ["source", "src"],
      ["video", "src"],
      ["video", "poster"],
      ["audio", "src"],
      ["use", "href"],
    ];
    for (var index = 0; index < attributes.length; index += 1) {
      var selector = attributes[index][0] + "[" + attributes[index][1] + "]";
      var nodes = parsed.querySelectorAll(selector);
      for (var node = 0; node < nodes.length; node += 1) {
        var element = nodes[node] as Element;
        var name = attributes[index][1];
        var url = link(entry, element.getAttribute(name) || "");
        if (url) element.setAttribute(name, url);
      }
    }
    // `crossorigin` makes a blob load a CORS request against an opaque origin,
    // and `integrity` is a hash of the file as the plugin built it, which the
    // rewritten copy no longer matches. Both are dropped rather than honoured:
    // the bytes were checked against the manifest's sha256 before they got here.
    var scripts = parsed.querySelectorAll("script, link");
    for (var script = 0; script < scripts.length; script += 1) {
      scripts[script].removeAttribute("crossorigin");
      scripts[script].removeAttribute("integrity");
    }
    // A preload of a blob URL fetches it a second time for nothing.
    var preloads = parsed.querySelectorAll("link[rel=modulepreload], link[rel=preload], link[rel=icon]");
    for (var preload = 0; preload < preloads.length; preload += 1) {
      var parentNode = preloads[preload].parentNode;
      if (parentNode) parentNode.removeChild(preloads[preload]);
    }
    var styles = parsed.querySelectorAll("style");
    for (var style = 0; style < styles.length; style += 1) {
      var element2 = styles[style];
      element2.textContent = String(element2.textContent || "").replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
        function (whole, quote, specifier) {
          var url = link(entry, specifier);
          return url ? "url(" + quote + url + quote + ")" : whole;
        },
      );
    }
  }

  /**
   * Move the parsed document into the live one.
   *
   * `innerHTML` would not do: a `<script>` inserted that way never runs, which
   * is the single most common way a page like this ends up blank. Each node is
   * imported, and script elements are rebuilt so the browser treats them as new.
   */
  function adoptDocument(parsed: Document): void {
    if (parsed.title) document.title = parsed.title;
    var bodyAttributes = parsed.body ? parsed.body.attributes : null;
    if (bodyAttributes) {
      for (var attribute = 0; attribute < bodyAttributes.length; attribute += 1) {
        document.body.setAttribute(bodyAttributes[attribute].name, bodyAttributes[attribute].value);
      }
    }
    adoptInto(parsed.head, document.head);
    adoptInto(parsed.body, document.body);
  }

  function adoptInto(from: Element | null, into: Element): void {
    if (!from) return;
    var children = Array.prototype.slice.call(from.childNodes) as Node[];
    for (var index = 0; index < children.length; index += 1) {
      var node = children[index];
      if (node.nodeType === 1 && (node as Element).tagName === "SCRIPT") {
        var original = node as HTMLScriptElement;
        var replacement = document.createElement("script");
        var attributes = original.attributes;
        for (var attribute = 0; attribute < attributes.length; attribute += 1) {
          replacement.setAttribute(attributes[attribute].name, attributes[attribute].value);
        }
        replacement.text = original.text;
        into.appendChild(replacement);
        continue;
      }
      into.appendChild(document.importNode(node, true));
    }
  }

  function applyTheme(snapshot: Record<string, unknown> | null): void {
    if (!snapshot) return;
    var scheme = snapshot.scheme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", scheme);
    var tokens = (snapshot.tokens || {}) as Record<string, string>;
    var names = Object.keys(tokens);
    for (var index = 0; index < names.length; index += 1) {
      if (names[index].indexOf("--") !== 0) continue;
      document.documentElement.style.setProperty(names[index], tokens[names[index]]);
    }
  }

  function measuredHeight(): number {
    var body = document.body;
    var element = document.documentElement;
    return Math.max(body ? body.scrollHeight : 0, element ? element.scrollHeight : 0);
  }

  /**
   * Report the content height, for the one placement that is sized to it.
   *
   * A settings section grows with the form the plugin drew, and only the guest
   * can measure that. Sent on change rather than on a timer, and the host caps
   * what it will honour.
   */
  function watchHeight(): void {
    if (typeof ResizeObserver === "undefined") return;
    var last = -1;
    var observer = new ResizeObserver(function () {
      var height = measuredHeight();
      if (height === last) return;
      last = height;
      post({ kind: "resize", height: height });
    });
    observer.observe(document.documentElement);
  }

  function isType(path: string, extensions: string[]): boolean {
    var lower = path.toLowerCase();
    for (var index = 0; index < extensions.length; index += 1) {
      if (lower.length >= extensions[index].length && lower.indexOf(extensions[index], lower.length - extensions[index].length) !== -1) {
        return true;
      }
    }
    return false;
  }

  function decodeText(bytes: ArrayBuffer): string {
    return new TextDecoder().decode(bytes);
  }

  // -------------------------------------------------------------------------
  // The page's own failures
  // -------------------------------------------------------------------------

  /**
   * Tell the host why this page is not drawing.
   *
   * The web mirror of the desktop preload's reporter, and it exists for the
   * same reason: a page that threw on its first render is exactly the page that
   * cannot raise its own notice. Rate-limited to a handful, because a render
   * loop that throws every frame is one broken page rather than a thousand
   * messages, and swallowed on failure — a report that cannot be delivered must
   * not become a second error inside the handler for the first.
   */
  var pageErrorsReported = 0;

  function reportPageError(kind: string, message: string, source?: string): void {
    if (pageErrorsReported >= 5) return;
    var trimmed = (message || "").trim();
    if (!trimmed) return;
    pageErrorsReported += 1;
    void call("page.error", {
      kind: kind,
      message: trimmed.slice(0, 240),
      source: source ? String(source).slice(0, 400) : undefined,
    }).catch(noop);
  }

  window.addEventListener("error", function (event: ErrorEvent) {
    var fromError = event.error instanceof Error ? event.error.message : "";
    reportPageError("error", fromError || event.message || "The page threw an error.", event.filename);
  });

  window.addEventListener("unhandledrejection", function (event: PromiseRejectionEvent) {
    var reason: unknown = event.reason;
    var message = reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "A promise in the page rejected and nothing caught it.";
    reportPageError("error", message);
  });

  window.addEventListener("securitypolicyviolation", function (event: SecurityPolicyViolationEvent) {
    var directive = event.effectiveDirective || event.violatedDirective || "the page policy";
    var blocked = event.blockedURI || "something outside this plugin's own files";
    reportPageError(
      "csp",
      directive + " blocked " + blocked + ". A plugin page may only load what shipped in its own directory.",
      event.blockedURI,
    );
  });

  /** The only thing the guest ever draws itself. Host words, no plugin content. */
  function showFailure(message: string): void {
    document.body.textContent = message;
    document.body.setAttribute(
      "style",
      "margin:0;padding:20px;font:12px system-ui,-apple-system,sans-serif;color:#8a8f98;background:transparent",
    );
  }
}

/**
 * The bootstrap as source, for the document the service worker serves.
 *
 * `</script>` is escaped because the string is written into a `<script>` block:
 * without it a plugin page whose bootstrap happened to contain that sequence
 * would end the block early and put the rest of the loader into the document as
 * text. It cannot today — the source is this file — which is exactly why the
 * escape belongs here rather than in a reviewer's memory.
 */
export function pluginPageGuestSource(config: PluginPageGuestConfig): string {
  const body = `(${pluginPageGuestMain.toString()})(${JSON.stringify(config)});`;
  return body.replace(/<\/(script)/gi, "<\\/$1");
}
