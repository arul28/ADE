/**
 * The URLs a proof preview streams from, and the reverse parse the main
 * process does before it serves one.
 *
 * Both forms ride the `ade-artifact:` scheme, which the renderer CSP already
 * allows for images and media and which answers Range requests:
 *
 *   ade-artifact://project/<path>                         this computer
 *   ade-artifact://remote/<targetId>/<projectId>/<path>   a paired computer
 *
 * `<path>` is always project-relative, one encoded segment at a time. It can
 * never hold `..` or `.`. That rule is only a first gate: the machine that
 * holds the bytes still resolves the path inside its own `.ade/artifacts` and
 * refuses anything that lands outside it.
 */

/** The most a single remote range read returns. Bounds each RPC answer. */
export const ARTIFACT_RANGE_READ_MAX_BYTES = 2 * 1024 * 1024;

const PROJECT_PREFIX = /^ade-artifact:\/\/project(?:\/|$)/i;
const REMOTE_PREFIX = "ade-artifact://remote/";

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

/** The streaming URL for a proof on a paired computer, or null when it has none. */
export function remoteArtifactStreamUrl(args: {
  uri: string;
  targetId: string;
  projectId: string;
  remoteProjectRoot?: string | null;
}): string | null {
  const targetId = args.targetId.trim();
  const projectId = args.projectId.trim();
  if (!targetId || !projectId) return null;
  const relative = projectRelativeArtifactPath(args.uri, args.remoteProjectRoot);
  if (!relative) return null;
  return `${REMOTE_PREFIX}${encodeURIComponent(targetId)}/${encodeURIComponent(projectId)}/${encodePath(relative)}`;
}

export type RemoteArtifactStreamTarget = {
  targetId: string;
  projectId: string;
  /** Project-relative, `/`-separated, with no `.` or `..` segment. */
  relativePath: string;
};

/**
 * The reverse of {@link remoteArtifactStreamUrl}. Parsed by hand, not with
 * `new URL`: URL parsing folds `..` away, which would turn a hostile path into
 * a different target id instead of a refusal.
 */
export function parseRemoteArtifactStreamUrl(url: string): RemoteArtifactStreamTarget | null {
  if (url.slice(0, REMOTE_PREFIX.length).toLowerCase() !== REMOTE_PREFIX) return null;
  const rest = url.slice(REMOTE_PREFIX.length).split(/[?#]/, 1)[0] ?? "";
  const parts = rest.split("/");
  if (parts.length < 3) return null;
  let targetId: string;
  let projectId: string;
  try {
    targetId = decodeURIComponent(parts[0] ?? "").trim();
    projectId = decodeURIComponent(parts[1] ?? "").trim();
  } catch {
    return null;
  }
  if (!targetId || !projectId) return null;
  const decoded = decodeSegments(parts.slice(2).join("/"));
  if (!decoded) return null;
  // Any `.` or `..` is a refusal here, not something to fold away.
  if (decoded.some((segment) => segment === "." || segment === "..")) return null;
  const safe = safeSegments(decoded);
  if (!safe) return null;
  return { targetId, projectId, relativePath: safe.join("/") };
}
