// ---------------------------------------------------------------------------
// ADE deeplinks — URL builder + parser shared across main / renderer / CLI.
// ---------------------------------------------------------------------------
//
// Two surface forms, identical semantics:
//   ade://lane/<uuid>
//   ade://session/<id>[?lane=<uuid>&event=<seq>&offset=<bytes>]
//   ade://file/<repo-relative-path>[?line=<n>&lane=<uuid>]
//   ade://commit/<sha>[?lane=<uuid>]
//   ade://artifact/<id>
//   ade://repo/<owner>/<repo>/branch/<branch>
//   ade://pr/<owner>/<repo>/<number>
//
//   https://ade-app.dev/open?type=lane&id=<uuid>
//   https://ade-app.dev/open?type=session&id=<id>[&lane=<uuid>&event=<seq>&offset=<bytes>]
//   https://ade-app.dev/open?type=file&path=<repo-relative-path>[&line=<n>&lane=<uuid>]
//   https://ade-app.dev/open?type=commit&sha=<sha>[&lane=<uuid>]
//   https://ade-app.dev/open?type=artifact&id=<id>
//   https://ade-app.dev/open?type=branch&repo=<owner/repo>&branch=<branch>
//   https://ade-app.dev/open?type=pr&repo=<owner/repo>&number=<n>
//
// Machine-local targets (lane / session / commit / artifact) additionally
// carry a portable envelope (?repo=<owner>/<repo>&branch=..&pr=..&linear=..)
// so a receiver that cannot resolve the primary id can fall back to the
// branch, PR, or Linear issue — see DeeplinkEnvelope.
//
// The HTTPS form lives on apps/web; it attempts the ade:// upgrade in the
// browser and falls back to an install/marketing card if no handler is
// registered. Both forms parse to the same AppNavigationTarget shape.

export const ADE_DEEPLINK_SCHEME = "ade";
export const ADE_DEEPLINK_HTTPS_HOST = "ade-app.dev";
export const ADE_DEEPLINK_LEGACY_HTTPS_HOSTS = ["ade.app"] as const;
export const ADE_DEEPLINK_HTTPS_PATH = "/open";
export const ADE_DEEPLINK_HTTPS_BASE_URL = `https://${ADE_DEEPLINK_HTTPS_HOST}${ADE_DEEPLINK_HTTPS_PATH}`;

/**
 * Portable link envelope: repo coordinates plus a fallback chain carried as
 * query params on machine-local targets (lane / session / commit / artifact).
 * A receiver that cannot resolve the primary id locally uses the envelope to
 * offer real alternatives — switch to the owning project, open the branch,
 * open the PR, open the Linear issue. Builders populate what they know at
 * mint time; the parser preserves the envelope without requiring it.
 */
export type DeeplinkEnvelope = {
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  prNumber?: number;
  linearIssue?: string;
};

export type DeeplinkLaneTarget = { kind: "lane"; laneId: string; envelope?: DeeplinkEnvelope };
export type DeeplinkSessionTarget = {
  kind: "session";
  sessionId: string;
  laneId?: string;
  /** Chat anchor: event sequence number of the message to scroll to. */
  event?: number;
  /** Terminal anchor: byte offset into the session scrollback. */
  offset?: number;
  envelope?: DeeplinkEnvelope;
};
/**
 * Workspace file target. `path` is repo-relative (forward slashes); when
 * `laneId` is present the file resolves inside that lane's worktree, else the
 * project root.
 */
export type DeeplinkFileTarget = {
  kind: "file";
  path: string;
  line?: number;
  laneId?: string;
};
/**
 * Commit target: opens the owning lane's git history locally. The envelope
 * carries the repo so a foreign receiver can fall back to the GitHub commit
 * URL.
 */
export type DeeplinkCommitTarget = {
  kind: "commit";
  sha: string;
  laneId?: string;
  envelope?: DeeplinkEnvelope;
};
/** Proof artifact target: opens the proof drawer locally. Machine-local id. */
export type DeeplinkArtifactTarget = {
  kind: "artifact";
  artifactId: string;
  envelope?: DeeplinkEnvelope;
};
export type DeeplinkBranchTarget = {
  kind: "branch";
  repoOwner: string;
  repoName: string;
  branch: string;
  prNumber?: number;
};
export type DeeplinkPrTarget = {
  kind: "pr";
  repoOwner: string;
  repoName: string;
  prNumber: number;
};
/**
 * Linear hand-off form: Linear's "Open in coding tool" passes us the issue
 * identifier and (optionally) the Linear-generated branch name. The receiving
 * ADE install resolves the actual lane/repo locally via lane.linearIssue
 * lookup; the repo is not in the URL because Linear doesn't surface it.
 */
export type DeeplinkLinearIssueTarget = {
  kind: "linear-issue";
  issueIdentifier: string;
  branch?: string;
};

export type DeeplinkTarget =
  | DeeplinkLaneTarget
  | DeeplinkSessionTarget
  | DeeplinkFileTarget
  | DeeplinkCommitTarget
  | DeeplinkArtifactTarget
  | DeeplinkBranchTarget
  | DeeplinkPrTarget
  | DeeplinkLinearIssueTarget;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// GitHub: owner 1-39 chars [A-Za-z0-9-]; repo can include _.-, no path separators.
const GH_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GH_REPO_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;
// Linear identifiers: team key (letters + optional digits, 1-10 chars) + dash + issue number.
// Example: ADE-123, LIN-512, FOO2-99.
const LINEAR_ID_RE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/;
// Branch refs are permissive but ADE rejects traversal + control chars.
const BRANCH_BAD_RE = /(^|\/)\.\.($|\/)|[\x00-\x1f\x7f]/;
const OPAQUE_ID_BAD_RE = /[\x00-\x1f\x7f]/;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isValidGhOwner(value: string): boolean {
  return GH_OWNER_RE.test(value);
}

function isValidGhRepo(value: string): boolean {
  return GH_REPO_RE.test(value) && value !== "." && value !== "..";
}

function isValidLinearIdentifier(value: string): boolean {
  return LINEAR_ID_RE.test(value);
}

function isValidBranch(value: string): boolean {
  if (!value || value.length > 255) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".lock")) return false;
  if (BRANCH_BAD_RE.test(value)) return false;
  return true;
}

function isValidOpaqueId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return false;
  if (OPAQUE_ID_BAD_RE.test(trimmed)) return false;
  return true;
}

// Repo-relative file paths: forward slashes only, no traversal, no control
// chars, no absolute/drive-letter forms.
function isValidRepoRelativePath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  if (OPAQUE_ID_BAD_RE.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Parse a query-param integer; returns undefined when absent, null when malformed. */
function parseNonNegativeIntParam(raw: string | null): number | undefined | null {
  if (raw == null) return undefined;
  if (!/^\d{1,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function appendEnvelopeParams(params: URLSearchParams, envelope: DeeplinkEnvelope | undefined): void {
  if (!envelope) return;
  if (envelope.repoOwner && envelope.repoName) {
    params.set("repo", `${envelope.repoOwner}/${envelope.repoName}`);
  }
  if (envelope.branch) params.set("branch", envelope.branch);
  if (envelope.prNumber != null) params.set("pr", String(envelope.prNumber));
  if (envelope.linearIssue) params.set("linear", envelope.linearIssue);
}

/**
 * Read envelope params leniently: the envelope is auxiliary fallback data, so
 * a malformed component is dropped rather than failing the whole link.
 * Returns undefined when nothing valid is present.
 */
function readEnvelopeParams(searchParams: URLSearchParams): DeeplinkEnvelope | undefined {
  const envelope: DeeplinkEnvelope = {};
  const repo = searchParams.get("repo");
  if (repo) {
    const slash = repo.indexOf("/");
    if (slash > 0 && slash < repo.length - 1) {
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      if (isValidGhOwner(owner) && isValidGhRepo(name)) {
        envelope.repoOwner = owner;
        envelope.repoName = name;
      }
    }
  }
  const branch = searchParams.get("branch");
  if (branch && isValidBranch(branch)) envelope.branch = branch;
  const pr = parseNonNegativeIntParam(searchParams.get("pr"));
  if (typeof pr === "number" && pr >= 1) envelope.prNumber = pr;
  const linear = searchParams.get("linear");
  if (linear && isValidLinearIdentifier(linear)) envelope.linearIssue = linear;
  return Object.keys(envelope).length > 0 ? envelope : undefined;
}

export function isAdeDeeplinkHttpsHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === ADE_DEEPLINK_HTTPS_HOST
    || ADE_DEEPLINK_LEGACY_HTTPS_HOSTS.some((legacyHost) => legacyHost === normalized);
}

function encodeBranchSegment(branch: string): string {
  // Branches can contain `/`; we keep them as-is so the URL stays readable,
  // and rely on encodeURIComponent for any other reserved characters.
  return branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeBranchPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export type BuildOptions = {
  /** "ade" = custom scheme, "https" = web mirror. Defaults to "https". */
  form?: "ade" | "https";
};

export function buildDeeplink(target: DeeplinkTarget, options: BuildOptions = {}): string {
  const form = options.form ?? "https";
  if (form === "ade") return buildAdeUrl(target);
  return buildHttpsUrl(target);
}

export function buildAdePrUrl(pr: {
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
}): string {
  return buildDeeplink({
    kind: "pr",
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
    prNumber: pr.githubPrNumber,
  });
}

function buildAdeUrl(target: DeeplinkTarget): string {
  switch (target.kind) {
    case "lane": {
      const base = `${ADE_DEEPLINK_SCHEME}://lane/${encodeURIComponent(target.laneId)}`;
      const params = new URLSearchParams();
      appendEnvelopeParams(params, target.envelope);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    case "session": {
      const base = `${ADE_DEEPLINK_SCHEME}://session/${encodeURIComponent(target.sessionId)}`;
      const params = new URLSearchParams();
      if (target.laneId) params.set("lane", target.laneId);
      if (target.event != null) params.set("event", String(target.event));
      if (target.offset != null) params.set("offset", String(target.offset));
      appendEnvelopeParams(params, target.envelope);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    case "file": {
      const base = `${ADE_DEEPLINK_SCHEME}://file/${encodeBranchSegment(target.path)}`;
      const params = new URLSearchParams();
      if (target.line != null) params.set("line", String(target.line));
      if (target.laneId) params.set("lane", target.laneId);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    case "commit": {
      const base = `${ADE_DEEPLINK_SCHEME}://commit/${encodeURIComponent(target.sha)}`;
      const params = new URLSearchParams();
      if (target.laneId) params.set("lane", target.laneId);
      appendEnvelopeParams(params, target.envelope);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    case "artifact": {
      const base = `${ADE_DEEPLINK_SCHEME}://artifact/${encodeURIComponent(target.artifactId)}`;
      const params = new URLSearchParams();
      appendEnvelopeParams(params, target.envelope);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    case "branch": {
      const base = `${ADE_DEEPLINK_SCHEME}://repo/${encodeURIComponent(target.repoOwner)}/${encodeURIComponent(target.repoName)}/branch/${encodeBranchSegment(target.branch)}`;
      return target.prNumber ? `${base}?pr=${target.prNumber}` : base;
    }
    case "pr":
      return `${ADE_DEEPLINK_SCHEME}://pr/${encodeURIComponent(target.repoOwner)}/${encodeURIComponent(target.repoName)}/${target.prNumber}`;
    case "linear-issue": {
      const base = `${ADE_DEEPLINK_SCHEME}://linear-issue/${encodeURIComponent(target.issueIdentifier)}`;
      return target.branch ? `${base}?branch=${encodeURIComponent(target.branch)}` : base;
    }
  }
}

function buildHttpsUrl(target: DeeplinkTarget): string {
  const params = new URLSearchParams();
  switch (target.kind) {
    case "lane":
      params.set("type", "lane");
      params.set("id", target.laneId);
      appendEnvelopeParams(params, target.envelope);
      break;
    case "session":
      params.set("type", "session");
      params.set("id", target.sessionId);
      if (target.laneId) params.set("lane", target.laneId);
      if (target.event != null) params.set("event", String(target.event));
      if (target.offset != null) params.set("offset", String(target.offset));
      appendEnvelopeParams(params, target.envelope);
      break;
    case "file":
      params.set("type", "file");
      params.set("path", target.path);
      if (target.line != null) params.set("line", String(target.line));
      if (target.laneId) params.set("lane", target.laneId);
      break;
    case "commit":
      params.set("type", "commit");
      params.set("sha", target.sha);
      if (target.laneId) params.set("lane", target.laneId);
      appendEnvelopeParams(params, target.envelope);
      break;
    case "artifact":
      params.set("type", "artifact");
      params.set("id", target.artifactId);
      appendEnvelopeParams(params, target.envelope);
      break;
    case "branch":
      params.set("type", "branch");
      params.set("repo", `${target.repoOwner}/${target.repoName}`);
      params.set("branch", target.branch);
      if (target.prNumber) params.set("pr", String(target.prNumber));
      break;
    case "pr":
      params.set("type", "pr");
      params.set("repo", `${target.repoOwner}/${target.repoName}`);
      params.set("number", String(target.prNumber));
      break;
    case "linear-issue":
      params.set("type", "linear-issue");
      params.set("issue", target.issueIdentifier);
      if (target.branch) params.set("branch", target.branch);
      break;
  }
  return `${ADE_DEEPLINK_HTTPS_BASE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type ParseError =
  | { kind: "empty" }
  | { kind: "unsupported_scheme"; scheme: string }
  | { kind: "unsupported_host"; host: string }
  | { kind: "unknown_type"; type: string }
  | { kind: "malformed"; reason: string };

export type ParseResult =
  | { ok: true; target: DeeplinkTarget; rawUrl: string }
  | { ok: false; error: ParseError; rawUrl: string };

export function parseDeeplink(rawUrl: string): ParseResult {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, error: { kind: "empty" }, rawUrl: rawUrl ?? "" };
  }
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: { kind: "malformed", reason: "not a URL" }, rawUrl };
  }
  if (url.protocol === `${ADE_DEEPLINK_SCHEME}:`) {
    return parseAdeUrl(url, rawUrl);
  }
  if (url.protocol === "https:") {
    if (!isAdeDeeplinkHttpsHost(url.hostname)) {
      return { ok: false, error: { kind: "unsupported_host", host: url.hostname }, rawUrl };
    }
    if (url.pathname !== ADE_DEEPLINK_HTTPS_PATH) {
      return { ok: false, error: { kind: "malformed", reason: "expected /open path" }, rawUrl };
    }
    return parseHttpsParams(url, rawUrl);
  }
  return {
    ok: false,
    error: { kind: "unsupported_scheme", scheme: url.protocol.replace(/:$/, "") },
    rawUrl,
  };
}

function parseAdeUrl(url: URL, rawUrl: string): ParseResult {
  // URL.host is the first path-like segment for non-special schemes.
  // For ade://lane/<id>, host = "lane" and pathname = "/<id>".
  const host = url.host.toLowerCase();
  const pathSegments = url.pathname.split("/").filter(Boolean);

  if (host === "lane") {
    const laneId = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    if (!laneId || !isValidUuid(laneId)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
    }
    const envelope = readEnvelopeParams(url.searchParams);
    return { ok: true, target: { kind: "lane", laneId, ...(envelope ? { envelope } : {}) }, rawUrl };
  }

  if (host === "session") {
    const sessionId = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    if (!isValidOpaqueId(sessionId)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid session id" }, rawUrl };
    }
    return buildSessionTarget(sessionId, url.searchParams, rawUrl);
  }

  if (host === "file") {
    const path = decodeBranchPath(pathSegments.join("/"));
    return buildFileTarget(path, url.searchParams, rawUrl);
  }

  if (host === "commit") {
    const sha = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    return buildCommitTarget(sha, url.searchParams, rawUrl);
  }

  if (host === "artifact") {
    const artifactId = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    return buildArtifactTarget(artifactId, url.searchParams, rawUrl);
  }

  if (host === "repo") {
    // Path: <owner>/<repo>/branch/<branch...>
    if (pathSegments.length < 4 || pathSegments[2] !== "branch") {
      return {
        ok: false,
        error: { kind: "malformed", reason: "expected repo/<owner>/<repo>/branch/<branch>" },
        rawUrl,
      };
    }
    const owner = safeDecode(pathSegments[0]);
    const repo = safeDecode(pathSegments[1]);
    const branch = decodeBranchPath(pathSegments.slice(3).join("/"));
    if (!isValidGhOwner(owner)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid owner" }, rawUrl };
    }
    if (!isValidGhRepo(repo)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid repo" }, rawUrl };
    }
    if (!isValidBranch(branch)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid branch" }, rawUrl };
    }
    const prRaw = url.searchParams.get("pr");
    const prNumber = prRaw ? Number(prRaw) : undefined;
    if (prRaw != null && (!Number.isInteger(prNumber) || prNumber == null || prNumber < 1)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid pr number" }, rawUrl };
    }
    return {
      ok: true,
      target: { kind: "branch", repoOwner: owner, repoName: repo, branch, prNumber },
      rawUrl,
    };
  }

  if (host === "pr") {
    // Path: <owner>/<repo>/<number>
    if (pathSegments.length !== 3) {
      return {
        ok: false,
        error: { kind: "malformed", reason: "expected pr/<owner>/<repo>/<number>" },
        rawUrl,
      };
    }
    const owner = safeDecode(pathSegments[0]);
    const repo = safeDecode(pathSegments[1]);
    const number = Number(pathSegments[2]);
    if (!isValidGhOwner(owner)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid owner" }, rawUrl };
    }
    if (!isValidGhRepo(repo)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid repo" }, rawUrl };
    }
    if (!Number.isInteger(number) || number < 1) {
      return { ok: false, error: { kind: "malformed", reason: "invalid pr number" }, rawUrl };
    }
    return {
      ok: true,
      target: { kind: "pr", repoOwner: owner, repoName: repo, prNumber: number },
      rawUrl,
    };
  }

  if (host === "linear-issue") {
    // Path: <linear-id>
    if (pathSegments.length < 1) {
      return {
        ok: false,
        error: { kind: "malformed", reason: "expected linear-issue/<id>" },
        rawUrl,
      };
    }
    const issueIdentifier = safeDecode(pathSegments[0]);
    if (!isValidLinearIdentifier(issueIdentifier)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid linear identifier" }, rawUrl };
    }
    const branchParam = url.searchParams.get("branch") ?? undefined;
    if (branchParam != null && !isValidBranch(branchParam)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid branch" }, rawUrl };
    }
    return {
      ok: true,
      target: {
        kind: "linear-issue",
        issueIdentifier,
        ...(branchParam ? { branch: branchParam } : {}),
      },
      rawUrl,
    };
  }

  return { ok: false, error: { kind: "unknown_type", type: host }, rawUrl };
}

function parseHttpsParams(url: URL, rawUrl: string): ParseResult {
  const type = (url.searchParams.get("type") ?? "").toLowerCase();
  if (type === "lane") {
    const laneId = url.searchParams.get("id") ?? "";
    if (!isValidUuid(laneId)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
    }
    const envelope = readEnvelopeParams(url.searchParams);
    return { ok: true, target: { kind: "lane", laneId, ...(envelope ? { envelope } : {}) }, rawUrl };
  }
  if (type === "session") {
    const sessionId = url.searchParams.get("id") ?? "";
    if (!isValidOpaqueId(sessionId)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid session id" }, rawUrl };
    }
    return buildSessionTarget(sessionId, url.searchParams, rawUrl);
  }
  if (type === "file") {
    const path = url.searchParams.get("path") ?? "";
    return buildFileTarget(path, url.searchParams, rawUrl);
  }
  if (type === "commit") {
    const sha = url.searchParams.get("sha") ?? "";
    return buildCommitTarget(sha, url.searchParams, rawUrl);
  }
  if (type === "artifact") {
    const artifactId = url.searchParams.get("id") ?? "";
    return buildArtifactTarget(artifactId, url.searchParams, rawUrl);
  }
  if (type === "branch" || type === "pr") {
    const repoCombined = url.searchParams.get("repo") ?? "";
    const slash = repoCombined.indexOf("/");
    if (slash <= 0 || slash === repoCombined.length - 1) {
      return { ok: false, error: { kind: "malformed", reason: "expected repo=owner/name" }, rawUrl };
    }
    const owner = repoCombined.slice(0, slash);
    const repo = repoCombined.slice(slash + 1);
    if (!isValidGhOwner(owner)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid owner" }, rawUrl };
    }
    if (!isValidGhRepo(repo)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid repo" }, rawUrl };
    }
    if (type === "branch") {
      const branch = url.searchParams.get("branch") ?? "";
      if (!isValidBranch(branch)) {
        return { ok: false, error: { kind: "malformed", reason: "invalid branch" }, rawUrl };
      }
      const prRaw = url.searchParams.get("pr");
      const prNumber = prRaw ? Number(prRaw) : undefined;
      if (prRaw != null && (!Number.isInteger(prNumber) || prNumber == null || prNumber < 1)) {
        return { ok: false, error: { kind: "malformed", reason: "invalid pr number" }, rawUrl };
      }
      return {
        ok: true,
        target: { kind: "branch", repoOwner: owner, repoName: repo, branch, prNumber },
        rawUrl,
      };
    }
    const number = Number(url.searchParams.get("number") ?? "");
    if (!Number.isInteger(number) || number < 1) {
      return { ok: false, error: { kind: "malformed", reason: "invalid pr number" }, rawUrl };
    }
    return {
      ok: true,
      target: { kind: "pr", repoOwner: owner, repoName: repo, prNumber: number },
      rawUrl,
    };
  }
  if (type === "linear-issue") {
    const issueIdentifier = url.searchParams.get("issue") ?? "";
    if (!isValidLinearIdentifier(issueIdentifier)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid linear identifier" }, rawUrl };
    }
    const branchParam = url.searchParams.get("branch") ?? undefined;
    if (branchParam != null && !isValidBranch(branchParam)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid branch" }, rawUrl };
    }
    return {
      ok: true,
      target: {
        kind: "linear-issue",
        issueIdentifier,
        ...(branchParam ? { branch: branchParam } : {}),
      },
      rawUrl,
    };
  }
  return { ok: false, error: { kind: "unknown_type", type }, rawUrl };
}

/** Shared session-target assembly for the ade:// and https:// parse paths. */
function buildSessionTarget(sessionId: string, searchParams: URLSearchParams, rawUrl: string): ParseResult {
  const laneId = searchParams.get("lane") ?? undefined;
  if (laneId != null && !isValidUuid(laneId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
  }
  const event = parseNonNegativeIntParam(searchParams.get("event"));
  if (event === null) {
    return { ok: false, error: { kind: "malformed", reason: "invalid event anchor" }, rawUrl };
  }
  const offset = parseNonNegativeIntParam(searchParams.get("offset"));
  if (offset === null) {
    return { ok: false, error: { kind: "malformed", reason: "invalid offset anchor" }, rawUrl };
  }
  const envelope = readEnvelopeParams(searchParams);
  return {
    ok: true,
    target: {
      kind: "session",
      sessionId,
      ...(laneId ? { laneId } : {}),
      ...(event != null ? { event } : {}),
      ...(offset != null ? { offset } : {}),
      ...(envelope ? { envelope } : {}),
    },
    rawUrl,
  };
}

/** Shared commit-target assembly for the ade:// and https:// parse paths. */
function buildCommitTarget(sha: string, searchParams: URLSearchParams, rawUrl: string): ParseResult {
  if (!COMMIT_SHA_RE.test(sha)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid commit sha" }, rawUrl };
  }
  const laneId = searchParams.get("lane") ?? undefined;
  if (laneId != null && !isValidUuid(laneId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
  }
  const envelope = readEnvelopeParams(searchParams);
  return {
    ok: true,
    target: {
      kind: "commit",
      sha: sha.toLowerCase(),
      ...(laneId ? { laneId } : {}),
      ...(envelope ? { envelope } : {}),
    },
    rawUrl,
  };
}

/** Shared artifact-target assembly for the ade:// and https:// parse paths. */
function buildArtifactTarget(artifactId: string, searchParams: URLSearchParams, rawUrl: string): ParseResult {
  if (!isValidOpaqueId(artifactId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid artifact id" }, rawUrl };
  }
  const envelope = readEnvelopeParams(searchParams);
  return {
    ok: true,
    target: {
      kind: "artifact",
      artifactId,
      ...(envelope ? { envelope } : {}),
    },
    rawUrl,
  };
}

/** Shared file-target assembly for the ade:// and https:// parse paths. */
function buildFileTarget(path: string, searchParams: URLSearchParams, rawUrl: string): ParseResult {
  if (!isValidRepoRelativePath(path)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid file path" }, rawUrl };
  }
  const laneId = searchParams.get("lane") ?? undefined;
  if (laneId != null && !isValidUuid(laneId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
  }
  const line = parseNonNegativeIntParam(searchParams.get("line"));
  if (line === null || line === 0) {
    return { ok: false, error: { kind: "malformed", reason: "invalid line number" }, rawUrl };
  }
  return {
    ok: true,
    target: {
      kind: "file",
      path,
      ...(line != null ? { line } : {}),
      ...(laneId ? { laneId } : {}),
    },
    rawUrl,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** True if `rawUrl` looks like one of our deeplink forms — used for clipboard sniffing. */
export function looksLikeAdeDeeplink(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) return false;
  if (trimmed.startsWith(`${ADE_DEEPLINK_SCHEME}://`)) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:"
      && isAdeDeeplinkHttpsHost(parsed.hostname)
      && parsed.pathname === ADE_DEEPLINK_HTTPS_PATH;
  } catch {
    return false;
  }
}

/** Convenience: human-readable summary of a target, used for toasts. */
export function describeTarget(target: DeeplinkTarget): string {
  switch (target.kind) {
    case "lane":
      return "lane link";
    case "session":
      return "work session";
    case "file":
      return target.line != null ? `${target.path}:${target.line}` : target.path;
    case "commit":
      return `commit ${target.sha.slice(0, 12)}`;
    case "artifact":
      return "proof artifact";
    case "branch":
      return `${target.repoOwner}/${target.repoName}@${target.branch}`;
    case "pr":
      return `${target.repoOwner}/${target.repoName}#${target.prNumber}`;
    case "linear-issue":
      return target.branch ? `${target.issueIdentifier} (${target.branch})` : target.issueIdentifier;
  }
}
