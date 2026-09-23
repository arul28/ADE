/**
 * The URLs a proof preview streams from, and the reverse parse the main
 * process does before it serves one.
 *
 * Images ride the `ade-artifact:` scheme, which the renderer CSP allows:
 *
 *   ade-artifact://project/<path>                          this computer
 *
 * Videos come from main's loopback media server instead. Electron's
 * `protocol.handle` cannot answer the second Range read a `<video>` makes when
 * the index sits at the end of the file, so a long recording never loads
 * there. The server's base is `http://127.0.0.1:<port>/<token>`:
 *
 *   <base>/project/<path>                                  this computer
 *   <base>/remote/<targetId>/<projectId>/<path>            a paired computer
 *
 * `<path>` is always project-relative, one encoded segment at a time. It can
 * never hold `..` or `.`. That rule is only a first gate: the machine that
 * holds the bytes still resolves the path inside its own `.ade/artifacts` and
 * refuses anything that lands outside it.
 */

/** The most a single remote range read returns. Bounds each RPC answer. */
export const ARTIFACT_RANGE_READ_MAX_BYTES = 2 * 1024 * 1024;

const PROJECT_PREFIX = /^ade-artifact:\/\/project(?:\/|$)/i;

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

function decodeSegments(value: string): string[] | null {
  const segments: string[] = [];
  for (const raw of value.split("/")) {
    if (!raw) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

/** Null when any segment could walk out of the folder it names. */
function safeSegments(segments: string[]): string[] | null {
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || /[\\/\0]/.test(segment)) return null;
    kept.push(segment);
  }
  return kept.length ? kept : null;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * A stored artifact uri as a project-relative path, or null when it is not one.
 *
 * Accepts the stored `ade-artifact://project/<path>` form, a plain relative
 * path, or an absolute path inside `projectRoot`. An absolute path anywhere
 * else, a web URL, and any path with `..` in it answer null.
 */
export function projectRelativeArtifactPath(uri: string, projectRoot: string | null | undefined): string | null {
  const text = uri.trim();
  if (!text || /^https?:\/\//i.test(text)) return null;

  let candidate: string;
  if (PROJECT_PREFIX.test(text)) {
    const segments = decodeSegments(text.replace(PROJECT_PREFIX, ""));
    const safe = segments ? safeSegments(segments) : null;
    return safe ? safe.join("/") : null;
  }
  if (/^ade-artifact:\/\//i.test(text)) {
    const decoded = decodeSegments(text.replace(/^ade-artifact:\/\/[^/]*/i, ""));
    if (!decoded) return null;
    candidate = `/${decoded.join("/")}`;
  } else if (/^file:\/\//i.test(text)) {
    const decoded = decodeSegments(text.replace(/^file:\/\/[^/]*/i, ""));
    if (!decoded) return null;
    candidate = `/${decoded.join("/")}`;
  } else {
    candidate = text;
  }

  candidate = candidate.replace(/\\/g, "/");
  // `/C:/x` is how a Windows path comes out of a URL.
  if (/^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1);
  if (isAbsolutePath(candidate)) {
    const root = withoutTrailingSlash((projectRoot ?? "").trim().replace(/\\/g, "/"));
    if (!root) return null;
    const windows = /^[a-zA-Z]:\//.test(root);
    const inside = windows
      ? candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      : candidate.startsWith(`${root}/`);
    if (!inside) return null;
    candidate = candidate.slice(root.length + 1);
  }
  const safe = safeSegments(candidate.split("/"));
  return safe ? safe.join("/") : null;
}

function encodePath(relativePath: string): string {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

/** The streaming URL for a proof on this computer, or null when it has none. */
export function localArtifactStreamUrl(uri: string, projectRoot: string | null | undefined): string | null {
  const relative = projectRelativeArtifactPath(uri, projectRoot);
  return relative ? `ade-artifact://project/${encodePath(relative)}` : null;
}

/** Where a media server path points, after the token. */
export type ArtifactMediaTarget =
  | { kind: "project"; relativePath: string }
  | { kind: "remote"; targetId: string; projectId: string; relativePath: string };

function withMediaBase(base: string, tail: string): string {
  return `${withoutTrailingSlash(base.trim())}/${tail}`;
}

/** The media server URL for a video on this computer, or null when it has none. */
export function localArtifactMediaUrl(
  base: string,
  uri: string,
  projectRoot: string | null | undefined,
): string | null {
  const relative = projectRelativeArtifactPath(uri, projectRoot);
  return relative && base.trim() ? withMediaBase(base, `project/${encodePath(relative)}`) : null;
}

/** The media server URL for a video on a paired computer, or null when it has none. */
export function remoteArtifactMediaUrl(base: string, args: {
  uri: string;
  targetId: string;
  projectId: string;
  remoteProjectRoot?: string | null;
}): string | null {
  const targetId = args.targetId.trim();
  const projectId = args.projectId.trim();
  if (!targetId || !projectId || !base.trim()) return null;
  const relative = projectRelativeArtifactPath(args.uri, args.remoteProjectRoot);
  if (!relative) return null;
  return withMediaBase(
    base,
    `remote/${encodeURIComponent(targetId)}/${encodeURIComponent(projectId)}/${encodePath(relative)}`,
  );
}

/** Decodes a relative path strictly: any `.` or `..` is a refusal, not something to fold away. */
function strictRelativePath(parts: string[]): string | null {
  const decoded = decodeSegments(parts.join("/"));
  if (!decoded) return null;
  if (decoded.some((segment) => segment === "." || segment === "..")) return null;
  const safe = safeSegments(decoded);
  return safe ? safe.join("/") : null;
}

/**
 * The reverse of {@link localArtifactMediaUrl} and {@link remoteArtifactMediaUrl}
 * for the part of the path after the token. Parsed by hand, not with
 * `new URL`: URL parsing folds `..` away, which would turn a hostile path into
 * a different target instead of a refusal.
 */
export function parseArtifactMediaPath(pathAfterToken: string): ArtifactMediaTarget | null {
  const rest = (pathAfterToken.split(/[?#]/, 1)[0] ?? "").replace(/^\/+/, "");
  const parts = rest.split("/");
  const kind = parts.shift();
  if (kind === "project") {
    const relativePath = strictRelativePath(parts);
    return relativePath ? { kind: "project", relativePath } : null;
  }
  if (kind !== "remote" || parts.length < 3) return null;
  let targetId: string;
  let projectId: string;
  try {
    targetId = decodeURIComponent(parts[0] ?? "").trim();
    projectId = decodeURIComponent(parts[1] ?? "").trim();
  } catch {
    return null;
  }
  if (!targetId || !projectId) return null;
  const relativePath = strictRelativePath(parts.slice(2));
  return relativePath ? { kind: "remote", targetId, projectId, relativePath } : null;
}
