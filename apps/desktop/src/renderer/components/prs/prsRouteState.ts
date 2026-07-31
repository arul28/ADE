export type PrWorkflowTab = "integration" | "rebase";
export type PrActiveTab = "github" | "normal" | PrWorkflowTab;
export type PrDetailRouteTab = "overview" | "files" | "checks";

export const PRS_LAST_ROUTE_STORAGE_KEY = "ade:prs:lastRoute";

function scopedPrsRouteStorageKey(projectRoot?: string | null): string {
  const root = projectRoot?.trim();
  return root ? `${PRS_LAST_ROUTE_STORAGE_KEY}:${root}` : PRS_LAST_ROUTE_STORAGE_KEY;
}

export type ParsedPrsRouteState = {
  tab: "github" | "normal" | "workflows" | PrWorkflowTab | null;
  workflowTab: PrWorkflowTab | null;
  laneId: string | null;
  prId: string | null;
  prNumber: number | null;
  eventId: string | null;
  threadId: string | null;
  commitSha: string | null;
  detailTab: PrDetailRouteTab | null;
};

function parseSearch(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

const WORKFLOW_TABS: ReadonlySet<string> = new Set<PrWorkflowTab>(["integration", "rebase"]);
const VALID_TABS: ReadonlySet<string> = new Set(["github", "normal", "workflows", ...WORKFLOW_TABS]);
const DETAIL_TABS: ReadonlySet<string> = new Set<PrDetailRouteTab>(["overview", "files", "checks"]);

function parseTab(value: string | null): ParsedPrsRouteState["tab"] {
  if (value && VALID_TABS.has(value)) return value as ParsedPrsRouteState["tab"];
  return null;
}

function parseWorkflowTab(value: string | null): PrWorkflowTab | null {
  if (value && WORKFLOW_TABS.has(value)) return value as PrWorkflowTab;
  return null;
}

function parseDetailTab(value: string | null): PrDetailRouteTab | null {
  if (value === "activity") return "overview";
  if (value && DETAIL_TABS.has(value)) return value as PrDetailRouteTab;
  return null;
}

function parseHashParams(hash: string): URLSearchParams {
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return new URLSearchParams();
  return parseSearch(hash.slice(queryIndex + 1));
}

function parseOptionalId(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalNumber(value: string | null): number | null {
  const trimmed = parseOptionalId(value);
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parsePrsRouteState(args: { search?: string | null; hash?: string | null }): ParsedPrsRouteState {
  const searchParams = parseSearch(args.search ?? "");
  const hashParams = parseHashParams(args.hash ?? "");
  const hashHasRouteSignal =
    parseTab(hashParams.get("tab")) !== null || parseWorkflowTab(hashParams.get("workflow")) !== null;
  const routeParams = hashHasRouteSignal ? hashParams : searchParams;

  const pick = (key: string): string | null => parseOptionalId(routeParams.get(key));

  // In BrowserRouter mock mode the inner hash is the current in-app location,
  // while the outer search may be stale from a previous view. Once the hash
  // carries any PR route signal, treat it as authoritative for the whole route.
  const workflowTab = parseWorkflowTab(routeParams.get("workflow"));

  return {
    tab: parseTab(routeParams.get("tab")),
    workflowTab,
    laneId: pick("laneId"),
    prId: pick("prId"),
    prNumber: parseOptionalNumber(routeParams.get("pr")),
    eventId: pick("eventId"),
    threadId: pick("threadId"),
    commitSha: pick("commitSha"),
    detailTab: parseDetailTab(routeParams.get("detailTab")),
  };
}

export function sanitizeStoredPrsRoute(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "/prs" || trimmed.startsWith("/prs?")) return trimmed;
  return null;
}

export function readStoredPrsRoute(projectRoot?: string | null): string | null {
  if (typeof window === "undefined") return null;
  const root = projectRoot?.trim();
  try {
    if (root) {
      return sanitizeStoredPrsRoute(window.localStorage.getItem(scopedPrsRouteStorageKey(root)));
    }
    return sanitizeStoredPrsRoute(window.localStorage.getItem(PRS_LAST_ROUTE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredPrsRoute(value: string, projectRoot?: string | null): void {
  if (typeof window === "undefined") return;
  const route = sanitizeStoredPrsRoute(value);
  if (!route) return;
  try {
    window.localStorage.setItem(scopedPrsRouteStorageKey(projectRoot), route);
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}

export type ResolvedPrsRoute = {
  isWorkflowRoute: boolean;
  effectiveWorkflow: PrWorkflowTab | null;
  activeTab: "normal" | PrWorkflowTab;
};

/**
 * Collapse a parsed route into a single activeTab decision.
 *
 * Routing bounce-back guard: the presence of a `workflow=` param, or a
 * workflow-alias `tab=` value (integration/rebase), is treated as
 * authoritative evidence of a workflow route. This prevents a stale
 * `?tab=normal` in the outer search (BrowserRouter mock mode) from shadowing
 * a hash-based workflow URL.
 */
export function resolvePrsActiveTab(route: ParsedPrsRouteState): ResolvedPrsRoute {
  const workflowAlias: PrWorkflowTab | null =
    route.tab === "integration" || route.tab === "rebase"
      ? route.tab
      : null;
  const effectiveWorkflow = route.workflowTab ?? workflowAlias;
  const isWorkflowRoute = Boolean(effectiveWorkflow) || route.tab === "workflows";
  if (isWorkflowRoute) {
    return {
      isWorkflowRoute: true,
      effectiveWorkflow,
      activeTab: effectiveWorkflow ?? "integration",
    };
  }
  return {
    isWorkflowRoute: false,
    effectiveWorkflow: null,
    activeTab: "normal",
  };
}

export function buildPrsRouteSearch(args: {
  activeTab: PrActiveTab;
  selectedPrId: string | null;
  selectedPrNumber?: number | null;
  selectedLaneId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  selectedRebaseItemId: string | null;
  eventId?: string | null;
  threadId?: string | null;
  commitSha?: string | null;
  detailTab?: PrDetailRouteTab | null;
}): string {
  const params = new URLSearchParams();

  if (args.activeTab === "normal" || args.activeTab === "github") {
    params.set("tab", args.activeTab);
    if (args.selectedPrId) params.set("prId", args.selectedPrId);
    if (args.selectedPrNumber != null) params.set("pr", String(args.selectedPrNumber));
    if (args.selectedLaneId) params.set("laneId", args.selectedLaneId);
    if (args.repoOwner) params.set("repoOwner", args.repoOwner);
    if (args.repoName) params.set("repoName", args.repoName);
    if (args.eventId) params.set("eventId", args.eventId);
    if (args.threadId) params.set("threadId", args.threadId);
    if (args.commitSha) params.set("commitSha", args.commitSha);
    if ((args.selectedPrId || args.selectedPrNumber != null) && args.detailTab) {
      params.set("detailTab", args.detailTab);
    }
  } else {
    params.set("tab", "workflows");
    params.set("workflow", args.activeTab);
    if (args.activeTab === "rebase" && args.selectedRebaseItemId) {
      params.set("laneId", args.selectedRebaseItemId);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}
