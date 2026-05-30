import type { AutomationTriggerType } from "../../../shared/types/config";
import type { AutomationTriggerLinearIssueContext } from "../../../shared/types/automations";
import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";

/**
 * One ingress dispatch derived from a Linear relay event. Mirrors the subset of
 * `automationService.dispatchIngressTrigger` args that the Linear path populates.
 * A single relay event can produce more than one of these (e.g. a label add that
 * also touches state emits both `linear.issue_labeled` and the state change).
 */
export type LinearAutomationDispatch = {
  source: "linear-relay";
  eventKey: string;
  triggerType: AutomationTriggerType;
  eventName?: string | null;
  summary?: string | null;
  author?: string | null;
  labels?: string[];
  rawPayload?: Record<string, unknown> | null;
  linear?: { issue: AutomationTriggerLinearIssueContext } | null;
  project?: string | null;
  team?: string | null;
  assignee?: string | null;
  stateTransition?: string | null;
  changedFields?: string[];
};

function readString(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(source: Record<string, unknown> | null | undefined, key: string): string[] | undefined {
  const value = source?.[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : null;
      if (name) return name;
    }
    return "";
  }).filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
}

function readNested(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Raw label ids on a Linear payload node (`data` or `updatedFrom`). */
function readLabelIds(source: Record<string, unknown> | null | undefined): string[] {
  const value = source?.labelIds;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Build a name lookup from a Linear payload's `labels` node (`[{ id, name }]`).
 * Lets us translate added label ids into the human-readable names rules match on.
 */
function buildLabelNameById(data: Record<string, unknown> | null): Map<string, string> {
  const map = new Map<string, string>();
  const raw = data?.labels;
  const nodes = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown> | null)?.nodes)
      ? ((raw as Record<string, unknown>).nodes as unknown[])
      : [];
  for (const entry of nodes) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    const name = typeof rec.name === "string" ? rec.name.trim() : null;
    if (id && name) map.set(id, name);
  }
  return map;
}

function mapLinearActionToTriggerType(
  action: string | null,
  data: Record<string, unknown> | null,
  prevData: Record<string, unknown> | null,
): { triggerType: AutomationTriggerType; stateTransition: string | null; previousState: string | undefined } {
  const currentState = readString(readNested(data, "state"), "name") ?? readString(data, "stateName");
  const previousState = readString(readNested(prevData, "state"), "name") ?? readString(prevData, "stateName");
  if (action === "create") {
    return { triggerType: "linear.issue_created", stateTransition: null, previousState: undefined };
  }
  const prevAssignee = readString(prevData, "assigneeId") ?? readString(readNested(prevData, "assignee"), "id");
  const curAssignee = readString(data, "assigneeId") ?? readString(readNested(data, "assignee"), "id");
  if (curAssignee && curAssignee !== prevAssignee) {
    return { triggerType: "linear.issue_assigned", stateTransition: null, previousState };
  }
  if (currentState && previousState && currentState !== previousState) {
    return {
      triggerType: "linear.issue_status_changed",
      stateTransition: `${previousState}->${currentState}`,
      previousState,
    };
  }
  return { triggerType: "linear.issue_updated", stateTransition: null, previousState };
}

/**
 * Translate a Linear relay event into the automation ingress dispatches it
 * implies. Returns an empty array for events without a resolvable issue.
 *
 * Label semantics (mirrors `githubPollingService` `github.issue_labeled`): when
 * a webhook reveals newly *added* labels (current `labelIds` minus
 * `updatedFrom.labelIds`), we emit a one-shot `linear.issue_labeled` whose
 * matchable `labels` are the added names only. To avoid a single label add
 * counting twice we suppress the generic `linear.issue_updated` fallthrough; an
 * assignment or status change that happened in the same payload still emits its
 * own event alongside the labeled one.
 */
export function buildLinearAutomationDispatches(event: LinearIngressEventRecord): LinearAutomationDispatch[] {
  if (!event.issueId) return [];
  const payload = event.payload ?? null;
  const data = readNested(payload, "data");
  const prevData = readNested(payload, "updatedFrom");
  const mapping = mapLinearActionToTriggerType(event.action ?? null, data, prevData);

  const teamName = readString(readNested(data, "team"), "name") ?? readString(data, "teamName");
  const projectName = readString(readNested(data, "project"), "name") ?? readString(data, "projectName");
  const assigneeName = readString(readNested(data, "assignee"), "name") ?? readString(data, "assigneeName");
  const stateName = readString(readNested(data, "state"), "name") ?? readString(data, "stateName");
  const labels = readStringArray(data, "labels") ?? readStringArray(readNested(data, "labels"), "nodes");
  const title = readString(data, "title") ?? undefined;

  const changedFields = prevData ? Object.keys(prevData) : undefined;

  const linearContext: AutomationTriggerLinearIssueContext = {
    id: event.issueId,
    title,
    team: teamName,
    project: projectName,
    assignee: assigneeName,
    state: stateName,
    previousState: mapping.previousState,
    labels,
  };

  // Resolve newly added labels by diffing label ids; only meaningful on updates
  // (a create carries no `updatedFrom`). Linear only includes `labelIds` in
  // `updatedFrom` when the label set was part of the change, so its absence
  // means the labels did not change in this event — never diff against an empty
  // prev set, or every edit would look like it added all labels.
  const addedLabelNames: string[] = (() => {
    if (event.action === "create" || !prevData) return [];
    if (!Array.isArray(prevData.labelIds)) return [];
    const prevIds = new Set(readLabelIds(prevData));
    const currentIds = readLabelIds(data);
    const addedIds = currentIds.filter((id) => !prevIds.has(id));
    if (!addedIds.length) return [];
    const nameById = buildLabelNameById(data);
    return addedIds
      .map((id) => nameById.get(id))
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  })();

  const dispatches: LinearAutomationDispatch[] = [];

  if (addedLabelNames.length) {
    dispatches.push({
      source: "linear-relay",
      eventKey: `${event.eventId}:labeled:${addedLabelNames.join(",")}`,
      triggerType: "linear.issue_labeled",
      eventName: event.action,
      summary: event.summary,
      // The matchable label set is the *added* names so rules fire once, on add.
      labels: addedLabelNames,
      rawPayload: { ...(payload ?? {}), addedLabels: addedLabelNames },
      linear: { issue: linearContext },
      project: projectName ?? null,
      team: teamName ?? null,
      assignee: assigneeName ?? null,
      stateTransition: null,
      changedFields,
    });
  }

  // Dedup: a pure label add (mapping fell through to issue_updated) must not also
  // fire issue_updated. A concurrent assignment/status change keeps its own event.
  const suppressBaseEvent = addedLabelNames.length > 0 && mapping.triggerType === "linear.issue_updated";
  if (!suppressBaseEvent) {
    dispatches.push({
      source: "linear-relay",
      eventKey: event.eventId,
      triggerType: mapping.triggerType,
      eventName: event.action,
      summary: event.summary,
      labels,
      rawPayload: payload,
      linear: { issue: linearContext },
      project: projectName ?? null,
      team: teamName ?? null,
      assignee: assigneeName ?? null,
      stateTransition: mapping.stateTransition,
      changedFields,
    });
  }

  return dispatches;
}
