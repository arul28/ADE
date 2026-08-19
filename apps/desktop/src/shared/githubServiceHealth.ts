/**
 * GitHub's own status page, used to tell "your credential is broken" apart from
 * "GitHub is broken".
 *
 * ADE's GitHub failure classification can only see the response it got. A 503
 * from api.github.com is indistinguishable from a misconfigured token at that
 * layer, so ADE used to render GitHub outages as "GitHub authentication check
 * failed" — blaming the user for an incident they can't fix, and pushing them
 * toward a reconnect that risks destroying a working credential.
 *
 * githubstatus.com is a Statuspage instance hosted OUTSIDE GitHub's own
 * infrastructure, so it stays reachable while GitHub is down. We use it purely
 * as corroboration for a failure we already observed — never as a poll.
 *
 * STRICTNESS: attribution requires a specific component ADE actually depends on
 * to be non-operational. A global "major" indicator driven entirely by
 * Codespaces or Copilot must NOT make ADE claim GitHub is broken for us, and a
 * healthy status page must never be used to assert the opposite ("GitHub is
 * fine, so it's your fault") — the status page lags real incidents by 10-20
 * minutes, so absence of a reported incident proves nothing.
 */

/** Statuspage component health, in increasing order of severity. */
export type GitHubServiceComponentStatus =
  | "operational"
  | "under_maintenance"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage";

/** Statuspage rollup indicator for the whole page. */
export type GitHubServiceIndicator = "none" | "minor" | "major" | "critical";

/**
 * The GitHub capabilities ADE depends on. Deliberately a subset of the status
 * page's components: Pages, Packages, Codespaces, and Copilot are excluded
 * because ADE's GitHub integration does not use them, and an outage confined to
 * those must not be attributed to ADE's failing request.
 */
export type GitHubServiceSurface =
  | "api"
  | "pulls"
  | "issues"
  | "actions"
  | "webhooks"
  | "git";

/**
 * Statuspage component IDs are stable identifiers, so they are the primary key.
 * Names are matched as a fallback in case GitHub ever re-creates a component.
 */
const COMPONENT_SURFACES: ReadonlyArray<{
  id: string;
  name: string;
  surface: GitHubServiceSurface;
}> = [
  { id: "brv1bkgrwx7q", name: "api requests", surface: "api" },
  { id: "hhtssxt0f5v2", name: "pull requests", surface: "pulls" },
  { id: "kr09ddfgbfsf", name: "issues", surface: "issues" },
  { id: "br0l2tvcx85d", name: "actions", surface: "actions" },
  { id: "4230lsnqdsld", name: "webhooks", surface: "webhooks" },
  { id: "8l4ygp009s5s", name: "git operations", surface: "git" },
];

const COMPONENT_STATUSES: ReadonlySet<string> = new Set<GitHubServiceComponentStatus>([
  "operational",
  "under_maintenance",
  "degraded_performance",
  "partial_outage",
  "major_outage",
]);

const INDICATORS: ReadonlySet<string> = new Set<GitHubServiceIndicator>([
  "none",
  "minor",
  "major",
  "critical",
]);

export const GITHUB_STATUS_PAGE_URL = "https://www.githubstatus.com";
export const GITHUB_STATUS_SUMMARY_URL = "https://www.githubstatus.com/api/v2/summary.json";

export type GitHubServiceComponent = {
  surface: GitHubServiceSurface;
  /** GitHub's own display name, e.g. "Pull Requests". */
  name: string;
  status: Exclude<GitHubServiceComponentStatus, "operational">;
};

/**
 * A corroborated GitHub incident affecting at least one surface ADE uses.
 * Only ever constructed when {@link deriveGitHubServiceHealth} finds a
 * non-operational ADE-relevant component — its existence IS the assertion that
 * GitHub is genuinely having issues.
 */
export type GitHubServiceHealth = {
  indicator: GitHubServiceIndicator;
  /** Non-operational ADE-relevant components, worst first. */
  affected: GitHubServiceComponent[];
  /** Link to the live incident, when the status page named one. */
  incidentUrl: string | null;
};

const STATUS_SEVERITY: Record<GitHubServiceComponentStatus, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function surfaceFor(id: string | null, name: string | null): GitHubServiceSurface | null {
  const normalizedName = name?.toLowerCase() ?? null;
  const match = COMPONENT_SURFACES.find((entry) => (
    (id != null && entry.id === id)
    || (normalizedName != null && entry.name === normalizedName)
  ));
  return match?.surface ?? null;
}

/**
 * Parse a Statuspage `summary.json` payload into ADE's view of GitHub health.
 *
 * Returns null when the payload is unusable OR when nothing ADE depends on is
 * degraded. Callers treat null as "say nothing", which is the whole point: a
 * silent status page must never produce UI.
 */
export function deriveGitHubServiceHealth(
  payload: unknown,
): GitHubServiceHealth | null {
  const root = asRecord(payload);
  if (!root) return null;

  const components = Array.isArray(root.components) ? root.components : [];
  const affected: GitHubServiceComponent[] = [];
  for (const raw of components) {
    const component = asRecord(raw);
    if (!component) continue;
    const status = asTrimmedString(component.status)?.toLowerCase() ?? null;
    if (status == null || !COMPONENT_STATUSES.has(status)) continue;
    if (status === "operational") continue;
    const name = asTrimmedString(component.name);
    const surface = surfaceFor(asTrimmedString(component.id), name);
    if (surface == null) continue;
    affected.push({
      surface,
      name: name ?? surface,
      status: status as GitHubServiceComponent["status"],
    });
  }
  // Strict: no ADE-relevant component is degraded, so ADE has nothing honest to
  // say about GitHub, regardless of the page-wide indicator.
  if (affected.length === 0) return null;
  affected.sort((left, right) => STATUS_SEVERITY[right.status] - STATUS_SEVERITY[left.status]);

  const statusBlock = asRecord(root.status);
  const rawIndicator = asTrimmedString(statusBlock?.indicator)?.toLowerCase() ?? null;
  const indicator: GitHubServiceIndicator = rawIndicator != null && INDICATORS.has(rawIndicator)
    ? (rawIndicator as GitHubServiceIndicator)
    : "major";

  const incidents = Array.isArray(root.incidents) ? root.incidents : [];
  const incident = incidents
    .map(asRecord)
    .find((entry) => entry != null && asTrimmedString(entry.resolved_at) == null) ?? null;

  return {
    indicator,
    affected,
    incidentUrl: incident ? asHttpsUrl(incident.shortlink) : null,
  };
}

/**
 * The incident link is third-party data that ends up in `openExternalUrl`.
 * Desktop routes that through an allowlist, but the web client falls back to a
 * bare `window.open`, so the scheme is validated here at the trust boundary
 * rather than relied upon at each sink.
 */
function asHttpsUrl(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (raw == null) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** Human list of the affected components, e.g. "API Requests and Pull Requests". */
export function githubServiceAffectedLabel(health: GitHubServiceHealth): string {
  const names = health.affected.slice(0, 3).map((entry) => entry.name);
  if (names.length === 0) return "some services";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/**
 * GitHub's own 5xx bodies. During an incident api.github.com serves these
 * instead of JSON, and by the time the text reaches a UI surface the HTTP
 * status is usually gone, so the wording has to be matchable on its own.
 *
 * Deliberately narrow — only phrases GitHub uses for its OWN failures.
 * Generic wording ("server error") and GitHub's 404 page text were tried and
 * removed: both also appear on responses that are genuinely the user's problem
 * (a proxy error page, a 404 for a repo the credential cannot see), where
 * "nothing to fix here" would be a lie. A flat literal alternation, so it is
 * linear-time on any input.
 */
const GITHUB_SERVICE_UNAVAILABLE_MESSAGE =
  /no server is currently available to service your request|service unavailable|bad gateway|gateway time-?out|unicorn!/i;

/**
 * True when GitHub itself failed, as opposed to rejecting the credential.
 *
 * Distinct from a transient local network fault: that one is the user's to
 * retry, while this one must never be presented as an authentication problem.
 */
export function isGithubServiceUnavailable(args: {
  status?: number;
  message: string | null | undefined;
}): boolean {
  if (args.status != null && args.status >= 500 && args.status <= 599) return true;
  return GITHUB_SERVICE_UNAVAILABLE_MESSAGE.test(args.message ?? "");
}
