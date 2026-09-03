/**
 * `ade-plugin://<pluginId>/<path>` — the origin a plugin's own HTML page is
 * served from.
 *
 * The whole point of a custom scheme here is the ORIGIN. A plugin page could be
 * loaded from `file:` with far less code, and it would then share one origin
 * with every other page on disk: `'self'` in the CSP would mean "the whole
 * filesystem", storage would be shared between plugins, and a page could fetch
 * any file the user can read. One origin per plugin makes the browser's own
 * same-origin machinery do the isolation, and this handler's only job is to
 * make that origin resolve to exactly one directory.
 *
 * Two rules it never bends:
 *
 * 1. **The install directory is the whole world.** Every request resolves
 *    against `<pluginRoot>` and is refused unless its REAL path (symlinks
 *    followed) is still inside it. A refusal is a 403 that carries no bytes —
 *    never a file, and never a directory listing that would map the machine.
 * 2. **Only an installed, enabled plugin has an origin at all.** An unknown or
 *    disabled plugin 404s, so disabling a plugin closes its pages rather than
 *    leaving a live origin nobody can see in the UI.
 *
 * Deliberately Electron-free: `session.protocol.handle` is the only Electron
 * surface involved, and it is reached through a structural type. Everything
 * that decides what a request is allowed to reach is a pure function of a URL
 * and the filesystem, so it is tested as one.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  parsePluginWebviewUrl,
  PLUGIN_WEBVIEW_CSP,
  PLUGIN_WEBVIEW_PROTOCOL,
} from "../../../shared/plugins/webviewBridge";
import { readPluginInstallRecords } from "./pluginRegistryFile";

export type PluginWebviewProtocolDeps = {
  /**
   * The install directory for a plugin that is installed AND enabled on this
   * machine, or null. Null-returning rather than throwing: "no such plugin" is
   * an ordinary answer here, and it is the same 404 as a missing file.
   */
  resolvePluginRoot: (pluginId: string) => string | null;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

/** A `session` as this module needs it. Structural so tests need no Electron. */
export type PluginWebviewProtocolSession = {
  protocol: {
    handle: (
      scheme: string,
      handler: (request: { url: string }) => Response | Promise<Response>,
    ) => void;
  };
};

/**
 * Extension → content type, as a closed map.
 *
 * Closed rather than a lookup through a mime library because this decides what
 * the renderer will EXECUTE. An unknown extension is `application/octet-stream`
 * — which, with `nosniff`, means the browser refuses to guess for us.
 */
const PLUGIN_WEBVIEW_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
};

const PLUGIN_WEBVIEW_FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * Largest single file this origin serves.
 *
 * The install cap already bounds a plugin's whole tree (5,000 files / 64 MiB),
 * so this is not about disk — it is about the read: `readFileSync` here blocks
 * the MAIN process, and a plugin that ships one enormous asset would freeze
 * every window while a guest fetched it. A refusal is a 413 rather than a
 * truncated body, because half a script is a syntax error the author cannot
 * explain.
 */
export const PLUGIN_WEBVIEW_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** A directory request resolves to this, and to nothing else. */
const PLUGIN_WEBVIEW_DIRECTORY_INDEX = "index.html";

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return PLUGIN_WEBVIEW_CONTENT_TYPES[ext] ?? PLUGIN_WEBVIEW_FALLBACK_CONTENT_TYPE;
}

/**
 * Headers every response carries, refusals included.
 *
 * The CSP on a 403 matters as much as the CSP on the page: an error body is
 * still a document the renderer parses, and one served without a policy would
 * be the one document in this origin that could execute anything.
 */
function pluginWebviewHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": PLUGIN_WEBVIEW_CSP,
    "X-Content-Type-Options": "nosniff",
  };
}

function refusal(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: pluginWebviewHeaders("text/plain; charset=utf-8"),
  });
}

/** Path containment, with the case-insensitive comparison Windows requires. */
function isInside(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  if (process.platform === "win32") {
    const file = normalizedCandidate.toLowerCase();
    const dir = normalizedRoot.toLowerCase();
    return file === dir || file.startsWith(dir + path.sep);
  }
  return (
    normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(normalizedRoot + path.sep)
  );
}

/**
 * The requested path, or null when the request is an escape attempt.
 *
 * Exactly ONE leading slash is stripped before decoding, and that ordering is
 * the load-bearing part: the URL form contributes that slash, so anything still
 * absolute after decoding was written as `%2F…` by the page and is asking for a
 * filesystem root rather than for a file in the plugin. Decoding first would
 * fold the two cases together and let an absolute request read as a relative
 * one.
 */
export function resolvePluginWebviewRequestPath(rawPathname: string): string | null {
  const withoutLeadingSlash = rawPathname.startsWith("/") ? rawPathname.slice(1) : rawPathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutLeadingSlash);
  } catch {
    return null;
  }
  // Written as the ESCAPE, never as a literal NUL byte: a source file holding
  // one is binary to git, which stops diffing it and hides every later change.
  if (decoded.includes("\u0000")) return null;
  if (decoded === "" || decoded.endsWith("/")) decoded += PLUGIN_WEBVIEW_DIRECTORY_INDEX;
  // `path.isAbsolute` answers for the host platform; the explicit tests cover
  // the two spellings a POSIX build would otherwise let through.
  if (path.isAbsolute(decoded) || decoded.startsWith("/") || decoded.startsWith("\\")) return null;
  if (/^[A-Za-z]:/.test(decoded)) return null;
  // Backslash is a separator on Windows and an ordinary character elsewhere, so
  // both spellings are split before the `..` check rather than after.
  if (decoded.split(/[\\/]+/).some((segment) => segment === "..")) return null;
  return decoded;
}

/**
 * The `protocol.handle` handler.
 *
 * Returns a `Response` for every input — there is no path through here that
 * throws, because a rejected promise inside `protocol.handle` shows the guest a
 * Chromium network error whose text is not ours to choose.
 */
export function createPluginWebviewProtocolHandler(
  deps: PluginWebviewProtocolDeps,
): (request: { url: string }) => Response {
  const log = deps.log ?? (() => {});
  return (request) => {
    const parsed = parsePluginWebviewUrl(request.url);
    if (!parsed) return refusal(404, "Not found");

    const root = deps.resolvePluginRoot(parsed.pluginId);
    // Disabled and never-installed are the same answer on purpose: which one it
    // is, is not something a page from another origin should be able to probe.
    if (!root) {
      log("plugin.webview_protocol_unknown_plugin", { pluginId: parsed.pluginId });
      return refusal(404, "Not found");
    }

    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return refusal(404, "Not found");
    }

    const relative = resolvePluginWebviewRequestPath(parsed.path);
    if (relative === null) {
      log("plugin.webview_protocol_refused", { pluginId: parsed.pluginId, path: parsed.path });
      return refusal(403, "Forbidden");
    }

    const candidate = path.resolve(realRoot, relative);
    if (!isInside(candidate, realRoot)) {
      log("plugin.webview_protocol_refused", { pluginId: parsed.pluginId, path: parsed.path });
      return refusal(403, "Forbidden");
    }

    let resolved: string;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      return refusal(404, "Not found");
    }
    // The second containment check is the one that catches a symlink inside the
    // plugin pointing out of it: the first saw only the name.
    if (!isInside(resolved, realRoot)) {
      log("plugin.webview_protocol_symlink_escape", { pluginId: parsed.pluginId, path: parsed.path });
      return refusal(403, "Forbidden");
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      return refusal(404, "Not found");
    }
    // A directory is a 404, never a listing: a listing of an install directory
    // is a map of the plugin, and of anything the user happened to leave in it.
    if (!stats.isFile()) return refusal(404, "Not found");
    if (stats.size > PLUGIN_WEBVIEW_FILE_MAX_BYTES) {
      log("plugin.webview_protocol_too_large", {
        pluginId: parsed.pluginId,
        path: parsed.path,
        bytes: stats.size,
      });
      return refusal(413, "Payload Too Large");
    }

    let body: Buffer;
    try {
      body = fs.readFileSync(resolved);
    } catch {
      return refusal(404, "Not found");
    }

    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        ...pluginWebviewHeaders(contentTypeFor(resolved)),
        "Content-Length": String(body.byteLength),
      },
    });
  };
}

/**
 * The registry-backed resolver, for a process that holds no plugin host.
 *
 * The host is a machine-scoped singleton that lives in the DAEMON (D2), and the
 * protocol handler runs in Electron's main process, which never builds one. So
 * this reads the same `state.json` the install service writes — the pattern
 * `listPluginAgentSkillRoots` already uses for callers that cannot hold the
 * service. A process that DOES have a host passes `host.rootFor` instead and
 * gets the same answer from memory.
 *
 * REGISTRY, never a directory listing: a folder nobody installed is not a
 * plugin, and serving one would make dropping a directory into `~/.ade/plugins`
 * enough to publish an origin.
 */
export function createInstalledPluginRootResolver(
  options: { pluginsRoot?: string; env?: NodeJS.ProcessEnv } = {},
): (pluginId: string) => string | null {
  return (pluginId) => {
    // Resolved per call, never captured: the channel defaults that decide
    // whether this machine's ADE directory is `.ade`, `.ade-beta` or
    // `.ade-alpha` are applied to `process.env` during launch, and a root read
    // at module load would be the Stable one on every channel.
    const pluginsRoot = options.pluginsRoot?.trim()
      || path.join(resolveMachineAdeLayout(options.env ?? process.env).adeDir, "plugins");
    const record = readPluginInstallRecords(pluginsRoot).get(pluginId);
    if (!record || !record.enabled) return null;
    return path.join(pluginsRoot, pluginId);
  };
}

/** Partitions this process has already registered a handler on. */
const registeredPartitions = new Set<string>();

/**
 * Register the scheme on ONE partition's session.
 *
 * `protocol.handle` on the global `protocol` import serves the default session
 * only, and a plugin guest deliberately runs in `pluginWebviewPartition(id)` —
 * so without this the guest's every request 404s at the network layer while the
 * default session happily serves the same URL to nobody. Idempotent because a
 * partition is shared by every guest of one plugin and each of them attaches.
 */
export function registerPluginWebviewProtocol(
  partition: string,
  session: PluginWebviewProtocolSession,
  deps: PluginWebviewProtocolDeps,
): void {
  if (registeredPartitions.has(partition)) return;
  try {
    session.protocol.handle(PLUGIN_WEBVIEW_PROTOCOL, createPluginWebviewProtocolHandler(deps));
    registeredPartitions.add(partition);
  } catch (error) {
    // Already handled by an earlier registration this process lost track of
    // (a partition object outlives a reload). Recording it stops a retry loop;
    // the existing handler is the same function with the same dependencies.
    registeredPartitions.add(partition);
    deps.log?.("plugin.webview_protocol_register_failed", {
      partition,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Test seam: production has no reason to forget a live registration. */
export function resetPluginWebviewProtocolRegistrationsForTests(): void {
  registeredPartitions.clear();
}
