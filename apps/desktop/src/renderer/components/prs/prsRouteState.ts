export type PrWorkflowTab = "queue" | "integration" | "rebase";
export type PrActiveTab = "github" | "normal" | PrWorkflowTab;

export type ParsedPrsRouteState = {
  tab: "github" | "normal" | "workflows" | PrWorkflowTab | null;
  workflowTab: PrWorkflowTab | null;
  laneId: string | null;
  prId: string | null;
  queueGroupId: string | null;
  eventId: string | null;
  threadId: string | null;
  commitSha: string | null;
};

function parseSearch(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

const WORKFLOW_TABS: ReadonlySet<string> = new Set<PrWorkflowTab>(["queue", "integration", "rebase"]);
const VALID_TABS: ReadonlySet<string> = new Set(["github", "normal", "workflows", ...WORKFLOW_TABS]);

function parseTab(value: string | null): ParsedPrsRouteState["tab"] {
  if (value && VALID_TABS.has(value)) return value as ParsedPrsRouteState["tab"];
  return null;
}

function parseWorkflowTab(value: string | null): PrWorkflowTab | null {
  if (value && WORKFLOW_TABS.has(value)) return value as PrWorkflowTab;
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
    queueGroupId: pick("queueGroupId"),
    eventId: pick("eventId"),
    threadId: pick("threadId"),
    commitSha: pick("commitSha"),
  };
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
 * workflow-alias `tab=` value (queue/integration/rebase), is treated as
 * authoritative evidence of a workflow route. This prevents a stale
 * `?tab=normal` in the outer search (BrowserRouter mock mode) from shadowing
 * a hash-based workflow URL.
 */
export function resolvePrsActiveTab(route: ParsedPrsRouteState): ResolvedPrsRoute {
  const workflowAlias: PrWorkflowTab | null =
    route.tab === "queue" || route.tab === "integration" || route.tab === "rebase"
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
  selectedQueueGroupId: string | null;
  selectedRebaseItemId: string | null;
  eventId?: string | null;
  threadId?: string | null;
  commitSha?: string | null;
}): string {
  const params = new URLSearchParams();

  if (args.activeTab === "normal" || args.activeTab === "github") {
    params.set("tab", args.activeTab);
    if (args.selectedPrId) params.set("prId", args.selectedPrId);
    if (args.eventId) params.set("eventId", args.eventId);
    if (args.threadId) params.set("threadId", args.threadId);
    if (args.commitSha) params.set("commitSha", args.commitSha);
  } else {
    params.set("tab", "workflows");
    params.set("workflow", args.activeTab);
    if (args.activeTab === "queue" && args.selectedQueueGroupId) {
      params.set("queueGroupId", args.selectedQueueGroupId);
    }
    if (args.activeTab === "rebase" && args.selectedRebaseItemId) {
      params.set("laneId", args.selectedRebaseItemId);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}
