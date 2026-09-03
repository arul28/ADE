// ---------------------------------------------------------------------------
// ADE deeplinks — URL builder + parser shared across main / renderer / CLI.
// ---------------------------------------------------------------------------
//
// Two surface forms, identical semantics:
//   ade://lane/<uuid>[?drawer=stack]
//   ade://session/<id>[?lane=<uuid>&event=<seq>&offset=<bytes>]
//   ade://file/<repo-relative-path>[?line=<n>&lane=<uuid>]
//   ade://commit/<sha>[?lane=<uuid>]
//   ade://artifact/<id>
//   ade://repo/<owner>/<repo>/branch/<branch>[?pr=<n>]
//   ade://pr/<owner>/<repo>/<number>[?tab=overview|files|checks]
//   ade://linear-issue/<ADE-123>[?branch=<branch>]
//   ade://issue/<provider>/<issue-key>[?branch=<branch>&plugin=<plugin-id>]
//   ade://plugin/<plugin-id>/<panel-id>[?ctx=<json-object>]
//   ade://welcome
//
//   https://ade-app.dev/open?type=<lane|session|file|commit|artifact|branch|pr|linear-issue|issue|plugin|welcome>&...
//   (param names: lane→id[+drawer]; session→id[+lane,event,offset]; file→path[+line,lane];
//    commit→sha[+lane]; artifact→id; branch→repo&branch[+pr]; pr→repo&number[+tab];
//    linear-issue→issue[+branch]; issue→provider&issue[+branch,plugin];
//    plugin→plugin&panel[+ctx])
//
// `issue` is the provider-neutral form of `linear-issue`: it names the tracker
// vocabulary (`linear`, `github`, `jira`, …) alongside the key, so a plugin can
// own a tracker ADE has never heard of. `linear-issue` is NOT deprecated by it
// and never will be — every link already minted into a PR body, a Linear
// comment or somebody's notes says `linear-issue`, and every peer on an older
// build only understands that word. The two parse to different targets and
// resolve identically; `linearIssueTargetToIssueTarget` is the one-way bridge
// resolvers use so neither has to be handled twice. Linear links keep being
// MINTED as `linear-issue` for exactly that reason: a byte-identical link is
// one an older ADE can still open.
//
// A plugin link addresses a panel of an installed plugin, and `ctx` is the same
// small object an action's `{navigate:{context}}` carries — the two are one
// value reaching a panel by two routes. It is capped and parsed leniently: a
// context that is too big or malformed is dropped and the panel still opens.
//
// Lane links may name a drawer to open with the lane (`?drawer=`), parsed with
// the same leniency `?tab=` gets. `welcome` names no entity at all: it is the
// project picker, which is the one surface a link may need to reach when there
// is no project open to address anything else against.
//
// PR links may name the detail sub-tab to land on (`?tab=`). The value is
// parsed leniently: an unknown tab is dropped, never failing the whole link,
// so a link minted by a newer ADE still opens on an older one.
//
// The HTTPS form lives on apps/web; it attempts the ade:// upgrade in the
// browser and falls back to an install/marketing card if no handler is
// registered. Both forms parse to the same AppNavigationTarget shape.
//
// Machine-local targets (lane / session / commit / artifact) additionally
// carry a portable envelope (?repo=<owner>/<repo>&branch=..&pr=..&linear=..
// &issueProvider=..&issueKey=..) so a receiver that cannot resolve the primary
// id can fall back to the branch, PR, or tracker issue — see DeeplinkEnvelope.

import { ISSUE_PROVIDER_LINEAR } from "./issueRef";
import { isValidPluginId, isValidPluginManifestIdentifier } from "./plugins/manifest";
import { PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES, pluginUtf8ByteLength } from "./plugins/sdk";
import type { AppNavigationTarget } from "./types/core";

export const ADE_DEEPLINK_SCHEME = "ade";
export const ADE_DEEPLINK_HTTPS_HOST = "ade-app.dev";
export const ADE_DEEPLINK_LEGACY_HTTPS_HOSTS = ["ade.app"] as const;
export const ADE_DEEPLINK_HTTPS_PATH = "/open";
export const ADE_DEEPLINK_HTTPS_BASE_URL = `https://${ADE_DEEPLINK_HTTPS_HOST}${ADE_DEEPLINK_HTTPS_PATH}`;

export type DeeplinkEnvelope = {
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  prNumber?: number;
  /**
   * The Linear identifier, in the one param an older peer understands.
   *
   * Kept as its own field rather than folded into {@link issue} because it is
   * what is already on the wire: a build that predates provider-neutral issues
   * reads `?linear=` and nothing else, so ADE keeps writing it for a Linear
   * issue forever, and keeps validating it with the strict Linear rule.
   */
  linearIssue?: string;
  /**
   * The same fallback for any tracker. Written as `?issueProvider=` +
   * `?issueKey=`, which an older peer ignores rather than chokes on.
   */
  issue?: { provider: string; key: string };
};

/**
 * Exact account ownership for destinations that are only meaningful on the
 * machine and project that published them (Attention sessions and PR work).
 */
export type DeeplinkOwnership = {
  accountMachineKey: string;
  projectId: string;
  /**
   * The owning project's absolute root, as carried by links minted before ADE
   * stopped stamping it (it leaked the publisher's username and directory
   * layout into every pasted link). Still parsed, never minted: it is what
   * rescues a legacy link whose `projectId` is the publisher's private uuid.
   */
  projectRoot?: string;
};

/**
 * A drawer a lane link may open alongside the lane.
 *
 * One value today, and a union rather than a bare string so a second one is a
 * compile-time decision in the router as well as here. `stack` is the stack
 * graph the lanes header reveals — the surface a launch flow sends the reader
 * to once the lane exists, which is why it is the first one addressable.
 */
export type DeeplinkLaneDrawer = "stack";

const LANE_DRAWERS: ReadonlySet<string> = new Set<DeeplinkLaneDrawer>(["stack"]);

/**
 * Lenient, exactly like {@link parsePrDetailTabParam}: a drawer this build does
 * not know is dropped and the lane still opens. A link minted by a newer ADE
 * must not fail to open a lane on an older one over a panel it cannot draw.
 */
export function parseLaneDrawerParam(raw: string | null | undefined): DeeplinkLaneDrawer | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return LANE_DRAWERS.has(normalized) ? (normalized as DeeplinkLaneDrawer) : undefined;
}

export type DeeplinkLaneTarget = {
  kind: "lane";
  laneId: string;
  /** A drawer to open with the lane. Omitted → the lanes page opens none. */
  drawer?: DeeplinkLaneDrawer;
  envelope?: DeeplinkEnvelope;
};

/**
 * The project picker.
 *
 * The one target with no id, and it needs one: a plugin page whose reader has
 * no project open can offer to pick one, and "navigate to the welcome screen"
 * was reachable from ADE's own code and from nowhere else. It carries no
 * envelope because there is nothing to fall back to — the picker IS the
 * fallback.
 */
export type DeeplinkWelcomeTarget = { kind: "welcome" };
export type DeeplinkSessionTarget = {
  kind: "session";
  sessionId: string;
  laneId?: string;
  event?: number;
  offset?: number;
  envelope?: DeeplinkEnvelope;
  ownership?: DeeplinkOwnership;
};
export type DeeplinkFileTarget = {
  kind: "file";
  path: string;
  line?: number;
  laneId?: string;
};
export type DeeplinkCommitTarget = {
  kind: "commit";
  sha: string;
  laneId?: string;
  envelope?: DeeplinkEnvelope;
};
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
/**
 * PR detail sub-tab a deeplink can land on. Structurally identical to the PRs
 * page's `PrDetailRouteTab` (`components/prs/prsRouteState.ts`) — kept here so
 * `shared/` stays free of renderer imports; the two are assignable both ways.
 */
export type DeeplinkPrDetailTab = "overview" | "files" | "checks";

const PR_DETAIL_TABS: ReadonlySet<string> = new Set<DeeplinkPrDetailTab>(["overview", "files", "checks"]);

/** Lenient: an unrecognized tab is dropped rather than failing the deeplink. */
export function parsePrDetailTabParam(raw: string | null | undefined): DeeplinkPrDetailTab | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  // `activity` is a PRs-page-only tab that predates the deeplink grammar; it
  // collapses to overview so an old copied URL still lands somewhere sane.
  if (normalized === "activity") return "overview";
  return PR_DETAIL_TABS.has(normalized) ? (normalized as DeeplinkPrDetailTab) : undefined;
}

export type DeeplinkPrTarget = {
  kind: "pr";
  repoOwner?: string;
  repoName?: string;
  prNumber: number;
  /** Detail sub-tab to open on. Omitted → the PRs page picks its own default. */
  detailTab?: DeeplinkPrDetailTab;
  ownership?: DeeplinkOwnership;
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

/**
 * An issue on any tracker.
 *
 * The generalization of {@link DeeplinkLinearIssueTarget}: `provider` is the
 * tracker vocabulary from `shared/issueRef.ts` (`linear`, `github`, `jira`, …)
 * and `issueKey` is that tracker's human key — `ADE-123`, `owner/repo#42`,
 * `PROJ-9`. ADE validates the key only loosely on purpose: it is another
 * system's identifier, and a parser that thought it knew the shape of every
 * tracker's key would reject links it merely does not recognize.
 *
 * `pluginId` pins the link to the plugin that minted it. It is a hint, not a
 * requirement — a link that carries none is resolved by looking up whoever owns
 * the provider on the receiving machine, which is what makes a link minted by
 * one person's Jira plugin openable by someone whose Jira plugin has a
 * different id.
 */
export type DeeplinkIssueTarget = {
  kind: "issue";
  provider: string;
  issueKey: string;
  branch?: string;
  pluginId?: string;
};

/**
 * A panel of an installed plugin.
 *
 * The only target kind whose destination may genuinely not exist on the
 * receiving machine — plugins are installed per machine, so a link one person
 * mints is routinely a link another person cannot open. Clients answer that the
 * same way they answer a link into an uninstalled compiled surface: they say so
 * plainly, rather than redirecting to the Marketplace.
 */
export type DeeplinkPluginTarget = {
  kind: "plugin";
  pluginId: string;
  panelId: string;
  /** The panel's render context. Dropped rather than fatal when malformed. */
  context?: Record<string, unknown>;
};

export type DeeplinkTarget =
  | DeeplinkLaneTarget
  | DeeplinkSessionTarget
  | DeeplinkFileTarget
  | DeeplinkCommitTarget
  | DeeplinkArtifactTarget
  | DeeplinkBranchTarget
  | DeeplinkPrTarget
  | DeeplinkLinearIssueTarget
  | DeeplinkIssueTarget
  | DeeplinkPluginTarget
  | DeeplinkWelcomeTarget;

/**
 * Read a `linear-issue` target as the neutral `issue` shape.
 *
 * The alias exists so that resolvers handle ONE kind. Every already-minted
 * `ade://linear-issue/ADE-123` keeps parsing to its own target — that is the
 * compatibility promise — and this is how it stops being a second code path
 * everywhere downstream of the parser.
 */
export function linearIssueTargetToIssueTarget(
  target: DeeplinkLinearIssueTarget,
): DeeplinkIssueTarget {
  return {
    kind: "issue",
    provider: ISSUE_PROVIDER_LINEAR,
    issueKey: target.issueIdentifier,
    ...(target.branch ? { branch: target.branch } : {}),
  };
}

/**
 * The panel a tracker plugin is assumed to draw one issue in.
 *
 * A convention, not a rule: it is the starting guess for a link that names a
 * plugin but no panel, and the renderer's resolver overrides it with whatever
 * panel the installed plugin actually registered.
 */
export const PLUGIN_ISSUE_PANEL_ID = "issue";

/**
 * The render context an issue link hands a plugin panel.
 *
 * One shape, built here, so the deeplink route and the renderer's resolver
 * cannot disagree about what a panel receives — the same reason `ctx` and an
 * action's `{navigate:{context}}` are one value.
 */
export function issueDeeplinkContext(target: DeeplinkIssueTarget): Record<string, unknown> {
  return {
    issue: {
      provider: target.provider,
      key: target.issueKey,
      ...(target.branch ? { branch: target.branch } : {}),
    },
  };
}

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

// A tracker vocabulary, as `shared/issueRef.ts` writes it: lowercase, and short
// enough to be a path segment nobody has to escape.
const ISSUE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Another system's key. Whitespace and control characters are refused because
// they cannot survive a URL round trip; everything else is that system's
// business — `owner/repo#42` and `PROJ-9` are both real keys.
const ISSUE_KEY_BAD_RE = /[\s\x00-\x1f\x7f]/;

/**
 * Tracker vocabulary rule, shared with the CLI so `ade link issue` refuses at
 * minting exactly what the parser would refuse at reading.
 */
export function isValidIssueProvider(value: string): boolean {
  return ISSUE_PROVIDER_RE.test(value.trim().toLowerCase());
}

/**
 * Issue key rule: non-empty, no whitespace, at most 128 characters.
 *
 * Deliberately looser than {@link isValidLinearIdentifier}, which stays exactly
 * as strict as it is — it guards the `?linear=` param an older peer reads, and
 * loosening it would put values there that such a peer cannot interpret.
 */
export function isValidIssueKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 && !ISSUE_KEY_BAD_RE.test(trimmed);
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

/**
 * Repo-relative file path rule shared by the parser AND by trusted-input
 * boundaries that bypass URL parsing (the `app/navigate` RPC, renderer
 * dispatch). Rejects traversal, absolute paths, drive letters, backslashes,
 * and control characters.
 */
export function isValidRepoRelativePath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  if (OPAQUE_ID_BAD_RE.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Commit sha rule shared with non-URL boundaries (7-40 hex chars). */
export function isValidCommitSha(value: string): boolean {
  return COMMIT_SHA_RE.test(value);
}

/**
 * Read a `?ctx=` parameter as the small JSON object a plugin panel renders with.
 *
 * Lenient in the `parsePrDetailTabParam` tradition: a context that is missing,
 * unparseable, not an object, or over {@link PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES}
 * yields `undefined` and the link still opens the panel. The context is a hint
 * about what to look at — losing it should never cost the reader the page.
 */
export function parseDeeplinkPluginContext(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  // Measured before parsing: the cap has to bound what we decode, not what we
  // decoded, or an oversized value is only refused after it has been expanded.
  // In BYTES, the same way `readPluginActionNavigation`, `ade link --ctx` and
  // iOS all measure it — a string of CJK is three times longer in UTF-8 than in
  // the units `String.length` counts, and the four readers of one link must not
  // disagree about whether it fits.
  if (pluginUtf8ByteLength(raw) > PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
  return decoded as Record<string, unknown>;
}

function appendPluginContextParam(params: URLSearchParams, context: Record<string, unknown> | undefined): void {
  if (!context) return;
  let json: string;
  try {
    json = JSON.stringify(context) ?? "";
  } catch {
    return;
  }
  if (!json || json === "{}" || pluginUtf8ByteLength(json) > PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) return;
  params.set("ctx", json);
}

function parseNonNegativeIntParam(raw: string | null): number | undefined | null {
  if (raw == null) return undefined;
  if (!/^\d{1,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function appendEnvelopeParams(params: URLSearchParams, envelope: DeeplinkEnvelope | undefined): void {
  if (!envelope) return;
  if (envelope.repoOwner && envelope.repoName) params.set("repo", `${envelope.repoOwner}/${envelope.repoName}`);
  if (envelope.branch) params.set("branch", envelope.branch);
  if (envelope.prNumber != null) params.set("pr", String(envelope.prNumber));
  // `?linear=` is written for every Linear issue, from whichever field carries
  // it. It is the only issue fallback a peer on an older build can read, so a
  // link that dropped it in favour of the neutral params would be a link that
  // silently lost its fallback on exactly the machines that needed one.
  if (envelope.linearIssue) {
    params.set("linear", envelope.linearIssue);
  } else if (
    envelope.issue?.provider === ISSUE_PROVIDER_LINEAR
    && isValidLinearIdentifier(envelope.issue.key)
  ) {
    params.set("linear", envelope.issue.key);
  }
  if (envelope.issue?.provider && envelope.issue.key) {
    params.set("issueProvider", envelope.issue.provider);
    params.set("issueKey", envelope.issue.key);
  }
}

function appendOwnershipParams(
  params: URLSearchParams,
  ownership: DeeplinkOwnership | undefined,
): void {
  if (!ownership) return;
  params.set("accountMachineKey", ownership.accountMachineKey);
  params.set("projectId", ownership.projectId);
  // `projectRoot` is intentionally not re-emitted: it is a parse-only
  // compatibility field, and minting it would put a local absolute path back
  // into every shareable link.
}

/** Longest project root a deeplink may carry out of the URL. */
const MAX_DEEPLINK_PROJECT_ROOT_LENGTH = 4_096;

function readOwnershipParams(
  searchParams: URLSearchParams,
  rawUrl: string,
):
  | { ok: true; ownership?: DeeplinkOwnership }
  | { ok: false; error: ParseError; rawUrl: string } {
  const accountMachineKey = searchParams.get("accountMachineKey")?.trim() ?? "";
  const projectId = searchParams.get("projectId")?.trim() ?? "";
  if (!accountMachineKey && !projectId) return { ok: true };
  if (!accountMachineKey || !projectId) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        reason: "accountMachineKey and projectId must be provided together",
      },
      rawUrl,
    };
  }
  if (
    accountMachineKey.length > 128
    || projectId.length > 512
    || !isValidOpaqueId(accountMachineKey)
    || !isValidOpaqueId(projectId)
  ) {
    return {
      ok: false,
      error: { kind: "malformed", reason: "invalid destination ownership" },
      rawUrl,
    };
  }
  // Legacy-only, and never required: a link that omits it (every link minted
  // today) still resolves through the canonical project id, so an
  // over-long value is dropped rather than failing the whole link.
  const projectRoot = searchParams.get("projectRoot")?.trim() ?? "";
  const carriesProjectRoot =
    projectRoot.length > 0 && projectRoot.length <= MAX_DEEPLINK_PROJECT_ROOT_LENGTH;
  return {
    ok: true,
    ownership: {
      accountMachineKey,
      projectId,
      ...(carriesProjectRoot ? { projectRoot } : {}),
    },
  };
}

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
  const issueProvider = searchParams.get("issueProvider")?.trim().toLowerCase() ?? "";
  const issueKey = searchParams.get("issueKey")?.trim() ?? "";
  if (issueProvider && issueKey && isValidIssueProvider(issueProvider) && isValidIssueKey(issueKey)) {
    envelope.issue = { provider: issueProvider, key: issueKey };
  } else if (envelope.linearIssue) {
    // A link minted before the neutral params existed carries only `?linear=`.
    // Both fields are filled from it so a reader that only knows the new shape
    // resolves the fallback too — the alias promise, applied to the envelope.
    envelope.issue = { provider: ISSUE_PROVIDER_LINEAR, key: envelope.linearIssue };
  }
  // The reverse direction: a hand-written link that carries only the neutral
  // params for Linear still gets the legacy field, so nothing downstream has to
  // ask which spelling it was handed.
  if (
    !envelope.linearIssue
    && envelope.issue?.provider === ISSUE_PROVIDER_LINEAR
    && isValidLinearIdentifier(envelope.issue.key)
  ) {
    envelope.linearIssue = envelope.issue.key;
  }
  return Object.keys(envelope).length > 0 ? envelope : undefined;
}

export function isAdeDeeplinkHttpsHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === ADE_DEEPLINK_HTTPS_HOST
    || ADE_DEEPLINK_LEGACY_HTTPS_HOSTS.some((legacyHost) => legacyHost === normalized);
}

function encodeBranchSegment(branch: string): string {
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

export type BuildOptions = {
  form?: "ade" | "https";
};

export function buildDeeplink(target: DeeplinkTarget, options: BuildOptions = {}): string {
  return (options.form ?? "https") === "ade" ? buildAdeUrl(target) : buildHttpsUrl(target);
}

export function buildAdePrUrl(pr: {
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  detailTab?: DeeplinkPrDetailTab;
}): string {
  return buildDeeplink({
    kind: "pr",
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
    prNumber: pr.githubPrNumber,
    ...(pr.detailTab ? { detailTab: pr.detailTab } : {}),
  });
}

function buildAdeUrl(target: DeeplinkTarget): string {
  switch (target.kind) {
    case "lane": {
      const params = new URLSearchParams();
      if (target.drawer) params.set("drawer", target.drawer);
      appendEnvelopeParams(params, target.envelope);
      const qs = params.toString();
      const base = `${ADE_DEEPLINK_SCHEME}://lane/${encodeURIComponent(target.laneId)}`;
      return qs ? `${base}?${qs}` : base;
    }
    case "welcome":
      return `${ADE_DEEPLINK_SCHEME}://welcome`;
    case "session": {
      const params = new URLSearchParams();
      if (target.laneId) params.set("lane", target.laneId);
      if (target.event != null) params.set("event", String(target.event));
      if (target.offset != null) params.set("offset", String(target.offset));
      appendEnvelopeParams(params, target.envelope);
      appendOwnershipParams(params, target.ownership);
      const qs = params.toString();
      const base = `${ADE_DEEPLINK_SCHEME}://session/${encodeURIComponent(target.sessionId)}`;
      return qs ? `${base}?${qs}` : base;
    }
    case "file": {
      const params = new URLSearchParams();
      if (target.line != null) params.set("line", String(target.line));
      if (target.laneId) params.set("lane", target.laneId);
      const qs = params.toString();
      const base = `${ADE_DEEPLINK_SCHEME}://file/${encodeBranchSegment(target.path)}`;
      return qs ? `${base}?${qs}` : base;
    }
    case "commit": {
      const params = new URLSearchParams();
      if (target.laneId) params.set("lane", target.laneId);
      appendEnvelopeParams(params, target.envelope);
      const qs = params.toString();
      const base = `${ADE_DEEPLINK_SCHEME}://commit/${encodeURIComponent(target.sha)}`;
      return qs ? `${base}?${qs}` : base;
    }
    case "artifact": {
      const params = new URLSearchParams();
      appendEnvelopeParams(params, target.envelope);
      const qs = params.toString();
      const base = `${ADE_DEEPLINK_SCHEME}://artifact/${encodeURIComponent(target.artifactId)}`;
      return qs ? `${base}?${qs}` : base;
    }
    case "branch": {
      const base = `${ADE_DEEPLINK_SCHEME}://repo/${encodeURIComponent(target.repoOwner)}/${encodeURIComponent(target.repoName)}/branch/${encodeBranchSegment(target.branch)}`;
      return target.prNumber ? `${base}?pr=${target.prNumber}` : base;
    }
    case "pr": {
      const params = new URLSearchParams();
      if (target.detailTab) params.set("tab", target.detailTab);
      appendOwnershipParams(params, target.ownership);
      const base = target.repoOwner && target.repoName
        ? `${ADE_DEEPLINK_SCHEME}://pr/${encodeURIComponent(target.repoOwner)}/${encodeURIComponent(target.repoName)}/${target.prNumber}`
        : `${ADE_DEEPLINK_SCHEME}://pr/${target.prNumber}`;
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    case "linear-issue": {
      const base = `${ADE_DEEPLINK_SCHEME}://linear-issue/${encodeURIComponent(target.issueIdentifier)}`;
      return target.branch ? `${base}?branch=${encodeURIComponent(target.branch)}` : base;
    }
    case "issue": {
      const params = new URLSearchParams();
      if (target.branch) params.set("branch", target.branch);
      if (target.pluginId) params.set("plugin", target.pluginId);
      const base = `${ADE_DEEPLINK_SCHEME}://issue/${encodeURIComponent(target.provider)}/${encodeURIComponent(target.issueKey)}`;
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    case "plugin": {
      const params = new URLSearchParams();
      appendPluginContextParam(params, target.context);
      const qs = params.toString();
      const base = `${ADE_DEEPLINK_SCHEME}://plugin/${encodeURIComponent(target.pluginId)}/${encodeURIComponent(target.panelId)}`;
      return qs ? `${base}?${qs}` : base;
    }
  }
}

function buildHttpsUrl(target: DeeplinkTarget): string {
  const params = new URLSearchParams();
  switch (target.kind) {
    case "lane":
      params.set("type", "lane");
      params.set("id", target.laneId);
      if (target.drawer) params.set("drawer", target.drawer);
      appendEnvelopeParams(params, target.envelope);
      break;
    case "welcome":
      params.set("type", "welcome");
      break;
    case "session":
      params.set("type", "session");
      params.set("id", target.sessionId);
      if (target.laneId) params.set("lane", target.laneId);
      if (target.event != null) params.set("event", String(target.event));
      if (target.offset != null) params.set("offset", String(target.offset));
      appendEnvelopeParams(params, target.envelope);
      appendOwnershipParams(params, target.ownership);
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
      if (target.repoOwner && target.repoName) {
        params.set("repo", `${target.repoOwner}/${target.repoName}`);
      }
      params.set("number", String(target.prNumber));
      if (target.detailTab) params.set("tab", target.detailTab);
      appendOwnershipParams(params, target.ownership);
      break;
    case "linear-issue":
      params.set("type", "linear-issue");
      params.set("issue", target.issueIdentifier);
      if (target.branch) params.set("branch", target.branch);
      break;
    case "issue":
      params.set("type", "issue");
      params.set("provider", target.provider);
      params.set("issue", target.issueKey);
      if (target.branch) params.set("branch", target.branch);
      if (target.pluginId) params.set("plugin", target.pluginId);
      break;
    case "plugin":
      params.set("type", "plugin");
      params.set("plugin", target.pluginId);
      params.set("panel", target.panelId);
      appendPluginContextParam(params, target.context);
      break;
  }
  return `${ADE_DEEPLINK_HTTPS_BASE_URL}?${params.toString()}`;
}

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
  if (url.protocol === `${ADE_DEEPLINK_SCHEME}:`) return parseAdeUrl(url, rawUrl);
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
  const host = url.host.toLowerCase();
  const pathSegments = url.pathname.split("/").filter(Boolean);

  if (host === "lane") {
    const laneId = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    if (!laneId || !isValidUuid(laneId)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
    }
    const envelope = readEnvelopeParams(url.searchParams);
    const drawer = parseLaneDrawerParam(url.searchParams.get("drawer"));
    return {
      ok: true,
      target: { kind: "lane", laneId, ...(drawer ? { drawer } : {}), ...(envelope ? { envelope } : {}) },
      rawUrl,
    };
  }

  if (host === "welcome") return { ok: true, target: { kind: "welcome" }, rawUrl };

  if (host === "session") {
    const sessionId = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    if (!isValidOpaqueId(sessionId)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid session id" }, rawUrl };
    }
    return buildSessionTarget(sessionId, url.searchParams, rawUrl);
  }

  if (host === "file") return buildFileTarget(decodeBranchPath(pathSegments.join("/")), url.searchParams, rawUrl);

  if (host === "commit") {
    const sha = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    return buildCommitTarget(sha, url.searchParams, rawUrl);
  }

  if (host === "artifact") {
    const artifactId = pathSegments[0] ? safeDecode(pathSegments[0]) : "";
    return buildArtifactTarget(artifactId, url.searchParams, rawUrl);
  }

  if (host === "repo") {
    if (pathSegments.length < 4 || pathSegments[2] !== "branch") {
      return { ok: false, error: { kind: "malformed", reason: "expected repo/<owner>/<repo>/branch/<branch>" }, rawUrl };
    }
    return buildBranchTarget(
      safeDecode(pathSegments[0]),
      safeDecode(pathSegments[1]),
      decodeBranchPath(pathSegments.slice(3).join("/")),
      url.searchParams.get("pr"),
      rawUrl,
    );
  }

  if (host === "pr") {
    if (pathSegments.length === 1) {
      return buildPrTarget(
        "",
        "",
        pathSegments[0],
        url.searchParams.get("tab"),
        rawUrl,
      );
    }
    if (pathSegments.length !== 3) {
      return { ok: false, error: { kind: "malformed", reason: "expected pr/<owner>/<repo>/<number>" }, rawUrl };
    }
    return buildPrTarget(
      safeDecode(pathSegments[0]),
      safeDecode(pathSegments[1]),
      pathSegments[2],
      url.searchParams.get("tab"),
      rawUrl,
    );
  }

  if (host === "linear-issue") {
    if (pathSegments.length < 1) {
      return { ok: false, error: { kind: "malformed", reason: "expected linear-issue/<id>" }, rawUrl };
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
      target: { kind: "linear-issue", issueIdentifier, ...(branchParam ? { branch: branchParam } : {}) },
      rawUrl,
    };
  }

  if (host === "issue") {
    if (pathSegments.length < 2) {
      return { ok: false, error: { kind: "malformed", reason: "expected issue/<provider>/<key>" }, rawUrl };
    }
    return buildIssueTarget(
      safeDecode(pathSegments[0]),
      // A key may legitimately contain a slash (`owner/repo#42`), so everything
      // after the provider is the key rather than only the next segment.
      pathSegments.slice(1).map(safeDecode).join("/"),
      url.searchParams.get("branch"),
      url.searchParams.get("plugin"),
      rawUrl,
    );
  }

  if (host === "plugin") {
    if (pathSegments.length !== 2) {
      return { ok: false, error: { kind: "malformed", reason: "expected plugin/<plugin-id>/<panel-id>" }, rawUrl };
    }
    return buildPluginTarget(
      safeDecode(pathSegments[0]),
      safeDecode(pathSegments[1]),
      url.searchParams.get("ctx"),
      rawUrl,
    );
  }

  return { ok: false, error: { kind: "unknown_type", type: host }, rawUrl };
}

function parseHttpsParams(url: URL, rawUrl: string): ParseResult {
  const type = (url.searchParams.get("type") ?? "").toLowerCase();
  if (type === "lane") {
    const laneId = url.searchParams.get("id") ?? "";
    if (!isValidUuid(laneId)) return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
    const envelope = readEnvelopeParams(url.searchParams);
    const drawer = parseLaneDrawerParam(url.searchParams.get("drawer"));
    return {
      ok: true,
      target: { kind: "lane", laneId, ...(drawer ? { drawer } : {}), ...(envelope ? { envelope } : {}) },
      rawUrl,
    };
  }
  if (type === "welcome") return { ok: true, target: { kind: "welcome" }, rawUrl };
  if (type === "session") {
    const sessionId = url.searchParams.get("id") ?? "";
    if (!isValidOpaqueId(sessionId)) {
      return { ok: false, error: { kind: "malformed", reason: "invalid session id" }, rawUrl };
    }
    return buildSessionTarget(sessionId, url.searchParams, rawUrl);
  }
  if (type === "file") return buildFileTarget(url.searchParams.get("path") ?? "", url.searchParams, rawUrl);
  if (type === "commit") return buildCommitTarget(url.searchParams.get("sha") ?? "", url.searchParams, rawUrl);
  if (type === "artifact") return buildArtifactTarget(url.searchParams.get("id") ?? "", url.searchParams, rawUrl);
  if (type === "branch" || type === "pr") {
    const repoCombined = url.searchParams.get("repo") ?? "";
    const slash = repoCombined.indexOf("/");
    if (
      type === "branch"
      && (slash <= 0 || slash === repoCombined.length - 1)
    ) {
      return { ok: false, error: { kind: "malformed", reason: "expected repo=owner/name" }, rawUrl };
    }
    const owner = slash > 0 ? repoCombined.slice(0, slash) : "";
    const repo = slash > 0 ? repoCombined.slice(slash + 1) : "";
    if (type === "branch") {
      return buildBranchTarget(owner, repo, url.searchParams.get("branch") ?? "", url.searchParams.get("pr"), rawUrl);
    }
    return buildPrTarget(
      owner,
      repo,
      url.searchParams.get("number") ?? "",
      url.searchParams.get("tab"),
      rawUrl,
    );
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
      target: { kind: "linear-issue", issueIdentifier, ...(branchParam ? { branch: branchParam } : {}) },
      rawUrl,
    };
  }
  if (type === "issue") {
    return buildIssueTarget(
      url.searchParams.get("provider") ?? "",
      url.searchParams.get("issue") ?? "",
      url.searchParams.get("branch"),
      url.searchParams.get("plugin"),
      rawUrl,
    );
  }
  if (type === "plugin") {
    return buildPluginTarget(
      url.searchParams.get("plugin") ?? "",
      url.searchParams.get("panel") ?? "",
      url.searchParams.get("ctx"),
      rawUrl,
    );
  }
  return { ok: false, error: { kind: "unknown_type", type }, rawUrl };
}

/**
 * Shared plugin-target assembly for the ade:// and https:// parse paths.
 *
 * Both ids are validated against the manifest's own rules rather than a local
 * regex: a link is one of the ways a plugin id reaches a filesystem path, and
 * two spellings of "valid id" is exactly how a boundary check drifts out of
 * agreement with the parser that named the directory.
 */
function buildPluginTarget(
  pluginId: string,
  panelId: string,
  ctxRaw: string | null,
  rawUrl: string,
): ParseResult {
  if (!isValidPluginId(pluginId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid plugin id" }, rawUrl };
  }
  if (!isValidPluginManifestIdentifier(panelId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid panel id" }, rawUrl };
  }
  const context = parseDeeplinkPluginContext(ctxRaw);
  return {
    ok: true,
    target: { kind: "plugin", pluginId, panelId, ...(context ? { context } : {}) },
    rawUrl,
  };
}

/**
 * Shared issue-target assembly for the ade:// and https:// parse paths.
 *
 * The provider is normalized to lowercase the way `shared/issueRef.ts`
 * normalizes it, so `ade://issue/Linear/ADE-1` and `ade://issue/linear/ADE-1`
 * are one link rather than two. The key is NOT normalized: it belongs to
 * another system, and `owner/Repo#42` is not the same string as
 * `owner/repo#42` on GitHub.
 *
 * A malformed `plugin` is fatal for the same reason a malformed plugin id is on
 * the `plugin` kind — it names a directory on the receiving machine, and a
 * boundary that repaired it would disagree with the parser that named it. A
 * malformed `branch` is fatal for the reason it already is on `linear-issue`.
 */
function buildIssueTarget(
  provider: string,
  issueKey: string,
  branchRaw: string | null,
  pluginRaw: string | null,
  rawUrl: string,
): ParseResult {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!isValidIssueProvider(normalizedProvider)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid issue provider" }, rawUrl };
  }
  const key = issueKey.trim();
  if (!isValidIssueKey(key)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid issue key" }, rawUrl };
  }
  if (branchRaw != null && !isValidBranch(branchRaw)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid branch" }, rawUrl };
  }
  if (pluginRaw != null && !isValidPluginId(pluginRaw)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid plugin id" }, rawUrl };
  }
  return {
    ok: true,
    target: {
      kind: "issue",
      provider: normalizedProvider,
      issueKey: key,
      ...(branchRaw ? { branch: branchRaw } : {}),
      ...(pluginRaw ? { pluginId: pluginRaw } : {}),
    },
    rawUrl,
  };
}

/** Shared branch-target assembly for the ade:// and https:// parse paths. */
function buildBranchTarget(
  owner: string,
  repo: string,
  branch: string,
  prRaw: string | null,
  rawUrl: string,
): ParseResult {
  if (!isValidGhOwner(owner)) return { ok: false, error: { kind: "malformed", reason: "invalid owner" }, rawUrl };
  if (!isValidGhRepo(repo)) return { ok: false, error: { kind: "malformed", reason: "invalid repo" }, rawUrl };
  if (!isValidBranch(branch)) return { ok: false, error: { kind: "malformed", reason: "invalid branch" }, rawUrl };
  const prNumber = prRaw ? Number(prRaw) : undefined;
  if (prRaw != null && (!Number.isInteger(prNumber) || prNumber == null || prNumber < 1)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid pr number" }, rawUrl };
  }
  return { ok: true, target: { kind: "branch", repoOwner: owner, repoName: repo, branch, prNumber }, rawUrl };
}

/** Shared pr-target assembly for the ade:// and https:// parse paths. */
function buildPrTarget(
  owner: string,
  repo: string,
  numberRaw: string,
  detailTabRaw: string | null,
  rawUrl: string,
): ParseResult {
  const hasRepoIdentity = Boolean(owner || repo);
  if (hasRepoIdentity && !isValidGhOwner(owner)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid owner" }, rawUrl };
  }
  if (hasRepoIdentity && !isValidGhRepo(repo)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid repo" }, rawUrl };
  }
  const number = Number(numberRaw);
  if (!Number.isInteger(number) || number < 1) {
    return { ok: false, error: { kind: "malformed", reason: "invalid pr number" }, rawUrl };
  }
  const detailTab = parsePrDetailTabParam(detailTabRaw);
  const ownershipResult = readOwnershipParams(new URL(rawUrl).searchParams, rawUrl);
  if (!ownershipResult.ok) return ownershipResult;
  if (!hasRepoIdentity && !ownershipResult.ownership) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        reason: "repo identity or exact destination ownership is required",
      },
      rawUrl,
    };
  }
  return {
    ok: true,
    target: {
      kind: "pr",
      ...(hasRepoIdentity ? { repoOwner: owner, repoName: repo } : {}),
      prNumber: number,
      ...(detailTab ? { detailTab } : {}),
      ...(ownershipResult.ownership ? { ownership: ownershipResult.ownership } : {}),
    },
    rawUrl,
  };
}

function buildSessionTarget(sessionId: string, searchParams: URLSearchParams, rawUrl: string): ParseResult {
  const laneId = searchParams.get("lane") ?? undefined;
  if (laneId != null && !isValidUuid(laneId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid lane id" }, rawUrl };
  }
  const event = parseNonNegativeIntParam(searchParams.get("event"));
  if (event === null) return { ok: false, error: { kind: "malformed", reason: "invalid event anchor" }, rawUrl };
  const offset = parseNonNegativeIntParam(searchParams.get("offset"));
  if (offset === null) return { ok: false, error: { kind: "malformed", reason: "invalid offset anchor" }, rawUrl };
  const envelope = readEnvelopeParams(searchParams);
  const ownershipResult = readOwnershipParams(searchParams, rawUrl);
  if (!ownershipResult.ok) return ownershipResult;
  return {
    ok: true,
    target: {
      kind: "session",
      sessionId,
      ...(laneId ? { laneId } : {}),
      ...(event != null ? { event } : {}),
      ...(offset != null ? { offset } : {}),
      ...(envelope ? { envelope } : {}),
      ...(ownershipResult.ownership ? { ownership: ownershipResult.ownership } : {}),
    },
    rawUrl,
  };
}

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
    target: { kind: "file", path, ...(line != null ? { line } : {}), ...(laneId ? { laneId } : {}) },
    rawUrl,
  };
}

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

function buildArtifactTarget(artifactId: string, searchParams: URLSearchParams, rawUrl: string): ParseResult {
  if (!isValidOpaqueId(artifactId)) {
    return { ok: false, error: { kind: "malformed", reason: "invalid artifact id" }, rawUrl };
  }
  const envelope = readEnvelopeParams(searchParams);
  return {
    ok: true,
    target: { kind: "artifact", artifactId, ...(envelope ? { envelope } : {}) },
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

export function describeTarget(target: DeeplinkTarget): string {
  switch (target.kind) {
    case "lane":
      return "lane link";
    case "session":
      return "work session";
    case "file":
      return target.line ? `${target.path}:${target.line}` : target.path;
    case "commit":
      return `commit ${target.sha}`;
    case "artifact":
      return `artifact ${target.artifactId}`;
    case "branch":
      return `${target.repoOwner}/${target.repoName}@${target.branch}`;
    case "pr":
      return target.repoOwner && target.repoName
        ? `${target.repoOwner}/${target.repoName}#${target.prNumber}`
        : `PR #${target.prNumber}`;
    case "linear-issue":
      return target.branch ? `${target.issueIdentifier} (${target.branch})` : target.issueIdentifier;
    case "issue":
      // Deliberately identical to the alias for a Linear issue: the two links
      // point at the same thing, and reading differently would suggest they do
      // not. The provider is not named because the key already carries the
      // tracker's own spelling.
      return target.branch ? `${target.issueKey} (${target.branch})` : target.issueKey;
    case "plugin":
      return `${target.pluginId} · ${target.panelId}`;
    case "welcome":
      return "project picker";
  }
}

/**
 * Map a parsed `DeeplinkTarget` to the renderer's `AppNavigationTarget`. Pure and
 * shared so both the main-process protocol handler and in-app renderer callers
 * (e.g. evidence artifact deeplinks) dispatch through the exact same navigation
 * shape — notably `session` → `work` and the `?? null` normalizations the
 * renderer's dispatcher expects.
 */
export function deeplinkToNavigationTarget(target: DeeplinkTarget): AppNavigationTarget {
  switch (target.kind) {
    case "lane":
      return {
        kind: "lane",
        laneId: target.laneId,
        drawer: target.drawer ?? null,
        envelope: target.envelope ?? null,
      };
    case "welcome":
      return { kind: "welcome" };
    case "session":
      return {
        kind: "work",
        sessionId: target.sessionId,
        laneId: target.laneId ?? null,
        envelope: target.envelope ?? null,
        event: target.event ?? null,
        offset: target.offset ?? null,
        ...(target.ownership ? { ownership: target.ownership } : {}),
      };
    case "file":
      return {
        kind: "file",
        path: target.path,
        line: target.line ?? null,
        laneId: target.laneId ?? null,
      };
    case "commit":
      return {
        kind: "commit",
        sha: target.sha,
        laneId: target.laneId ?? null,
        envelope: target.envelope ?? null,
      };
    case "artifact":
      return {
        kind: "artifact",
        artifactId: target.artifactId,
        envelope: target.envelope ?? null,
      };
    case "pr":
      return {
        kind: "pr",
        prNumber: target.prNumber,
        ...(target.repoOwner ? { repoOwner: target.repoOwner } : {}),
        ...(target.repoName ? { repoName: target.repoName } : {}),
        ...(target.detailTab ? { detailTab: target.detailTab } : {}),
        ...(target.ownership ? { ownership: target.ownership } : {}),
      };
    case "branch":
      return {
        kind: "branch",
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        branch: target.branch,
        prNumber: target.prNumber ?? null,
      };
    case "linear-issue":
      return {
        kind: "linear-issue",
        issueIdentifier: target.issueIdentifier,
        branch: target.branch ?? null,
      };
    case "issue":
      // Linear with nobody claiming it is the compiled Linear surface, and it
      // maps to the SAME navigation target the alias does — which is what keeps
      // `ade://issue/linear/ADE-123` working on a build whose dispatcher only
      // knows `linear-issue`.
      if (!target.pluginId && target.provider === ISSUE_PROVIDER_LINEAR) {
        return {
          kind: "linear-issue",
          issueIdentifier: target.issueKey,
          branch: target.branch ?? null,
        };
      }
      // Everything else is a plugin's issue. Which panel draws it is a question
      // only the receiving machine's registry can answer, so this names the
      // conventional one and the renderer's `resolveIssueDeeplinkRouting`
      // replaces it with the panel that plugin actually registered.
      return {
        kind: "plugin",
        pluginId: target.pluginId ?? target.provider,
        panelId: PLUGIN_ISSUE_PANEL_ID,
        context: issueDeeplinkContext(target),
      };
    case "plugin":
      return {
        kind: "plugin",
        pluginId: target.pluginId,
        panelId: target.panelId,
        context: target.context ?? null,
      };
  }
}
