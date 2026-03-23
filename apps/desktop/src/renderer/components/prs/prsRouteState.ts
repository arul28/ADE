export type PrWorkflowTab = "queue" | "integration" | "rebase";
export type PrActiveTab = "github" | "normal" | PrWorkflowTab;

export type ParsedPrsRouteState = {
  tab: "github" | "normal" | "workflows" | PrWorkflowTab | null;
  workflowTab: PrWorkflowTab | null;
  laneId: string | null;
  prId: string | null;
  queueGroupId: string | null;
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

  return {
    tab: parseTab(searchParams.get("tab") ?? hashParams.get("tab")),
    workflowTab: parseWorkflowTab(searchParams.get("workflow") ?? hashParams.get("workflow")),
    laneId: parseOptionalId(searchParams.get("laneId")) ?? parseOptionalId(hashParams.get("laneId")),
    prId: parseOptionalId(searchParams.get("prId")) ?? parseOptionalId(hashParams.get("prId")),
    queueGroupId: parseOptionalId(searchParams.get("queueGroupId")) ?? parseOptionalId(hashParams.get("queueGroupId")),
  };
}

export function buildPrsRouteSearch(args: {
  activeTab: PrActiveTab;
  selectedPrId: string | null;
  selectedQueueGroupId: string | null;
  selectedRebaseItemId: string | null;
}): string {
  const params = new URLSearchParams();

  if (args.activeTab === "normal" || args.activeTab === "github") {
    params.set("tab", args.activeTab);
    if (args.selectedPrId) params.set("prId", args.selectedPrId);
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
