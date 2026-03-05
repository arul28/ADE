import type {
  LinearAutoDispatchAction,
  LinearPriorityLabel,
  LinearRouteDecision,
  LinearSyncConfig,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { WorkerAgentService } from "./workerAgentService";
import type { FlowPolicyService } from "./flowPolicyService";
import { isRecord, safeJsonParse } from "../shared/utils";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function asPriority(value: unknown): LinearPriorityLabel | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "urgent" || normalized === "high" || normalized === "normal" || normalized === "low" || normalized === "none") {
    return normalized;
  }
  return null;
}

function resolveDefaultTemplate(issue: Pick<NormalizedLinearIssue, "labels" | "title">): string {
  const labels = new Set((issue.labels ?? []).map((label) => normalizeLabel(label)));
  const title = issue.title.toLowerCase();
  if (labels.has("bug") || title.includes("bug") || title.includes("fix")) return "bug-fix";
  if (labels.has("refactor") || title.includes("refactor")) return "refactor";
  if (labels.has("feature") || title.includes("feature")) return "feature";
  return "default";
}

function resolveProjectPolicy(policy: LinearSyncConfig, projectSlug: string) {
  return (policy.projects ?? []).find((entry) => entry.slug.toLowerCase() === projectSlug.toLowerCase()) ?? null;
}

function matchRule(
  issue: NormalizedLinearIssue,
  match: {
    labels?: string[];
    priority?: LinearPriorityLabel[];
    projectSlugs?: string[];
    owner?: string[];
  } | null | undefined
): { matched: boolean; signals: string[] } {
  if (!match) return { matched: true, signals: [] };
  const signals: string[] = [];

  if (Array.isArray(match.labels) && match.labels.length > 0) {
    const wanted = new Set(match.labels.map((value) => normalizeLabel(String(value))));
    const found = issue.labels.some((label) => wanted.has(normalizeLabel(label)));
    if (!found) return { matched: false, signals: [] };
    signals.push(`label:${Array.from(wanted).join(",")}`);
  }

  if (Array.isArray(match.priority) && match.priority.length > 0) {
    const priorities = new Set(match.priority.map((value) => asPriority(value)).filter((value): value is LinearPriorityLabel => value != null));
    if (!priorities.has(issue.priorityLabel)) return { matched: false, signals: [] };
    signals.push(`priority:${issue.priorityLabel}`);
  }

  if (Array.isArray(match.projectSlugs) && match.projectSlugs.length > 0) {
    const slugs = new Set(match.projectSlugs.map((value) => String(value).trim().toLowerCase()));
    if (!slugs.has(issue.projectSlug.toLowerCase())) return { matched: false, signals: [] };
    signals.push(`project:${issue.projectSlug}`);
  }

  if (Array.isArray(match.owner) && match.owner.length > 0) {
    const owners = new Set(match.owner.map((value) => String(value).trim()));
    const ownerId = issue.ownerId ?? "";
    const assigneeId = issue.assigneeId ?? "";
    const assigneeName = issue.assigneeName ?? "";
    const matchedOwner = owners.has(ownerId) || owners.has(assigneeId) || owners.has(assigneeName);
    if (!matchedOwner) return { matched: false, signals: [] };
    signals.push(`owner:${ownerId || assigneeId || assigneeName}`);
  }

  return { matched: true, signals };
}

export function createLinearRoutingService(args: {
  projectRoot: string;
  workerAgentService: WorkerAgentService;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService>;
  flowPolicyService: FlowPolicyService;
}) {
  const listWorkers = () => args.workerAgentService.listAgents({ includeDeleted: false });

  const findWorkerBySlug = (workerSlug: string | null | undefined) => {
    if (!workerSlug) return null;
    const key = workerSlug.trim().toLowerCase();
    if (!key.length) return null;
    return listWorkers().find((entry) => entry.slug.toLowerCase() === key) ?? null;
  };

  const aiRouteFallback = async (input: {
    issue: NormalizedLinearIssue;
    baselineDecision: LinearRouteDecision;
    policy: LinearSyncConfig;
  }): Promise<Partial<LinearRouteDecision>> => {
    const workers = listWorkers().map((worker) => ({
      id: worker.id,
      slug: worker.slug,
      name: worker.name,
      role: worker.role,
      capabilities: worker.capabilities,
    }));

    const aiPrompt = [
      "You are routing a Linear issue to an ADE worker.",
      "Pick the best worker, action, and template.",
      "Output JSON only.",
      "",
      `Issue identifier: ${input.issue.identifier}`,
      `Issue title: ${input.issue.title}`,
      `Issue description: ${input.issue.description.slice(0, 2000)}`,
      `Issue labels: ${input.issue.labels.join(", ") || "none"}`,
      `Issue project: ${input.issue.projectSlug}`,
      `Issue priority: ${input.issue.priorityLabel}`,
      `Issue state: ${input.issue.stateName} (${input.issue.stateType})`,
      "",
      "Baseline decision:",
      JSON.stringify(input.baselineDecision),
      "",
      "Available workers:",
      JSON.stringify(workers),
      "",
      "Return JSON schema:",
      JSON.stringify({
        workerSlug: "string|null",
        action: "auto|escalate|queue-night-shift",
        templateId: "string",
        confidence: "number 0..1",
        reason: "string",
        matchedSignals: ["string"],
      }),
    ].join("\n");

    const result = await args.aiIntegrationService.executeTask({
      feature: "orchestrator",
      taskType: "planning",
      prompt: aiPrompt,
      cwd: args.projectRoot,
      permissionMode: "read-only",
      oneShot: true,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workerSlug", "action", "templateId", "confidence", "reason", "matchedSignals"],
        properties: {
          workerSlug: { type: ["string", "null"] },
          action: { type: "string", enum: ["auto", "escalate", "queue-night-shift"] },
          templateId: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          matchedSignals: { type: "array", items: { type: "string" } },
        },
      },
      timeoutMs: 30_000,
    });

    const payload = isRecord(result.structuredOutput)
      ? result.structuredOutput
      : safeJsonParse<Record<string, unknown> | null>(result.text, null);

    if (!payload || !isRecord(payload)) {
      throw new Error("AI routing response was not valid JSON.");
    }

    const actionRaw = asString(payload.action);
    const action: LinearAutoDispatchAction =
      actionRaw === "auto" || actionRaw === "escalate" || actionRaw === "queue-night-shift"
        ? actionRaw
        : input.baselineDecision.action;

    const confidenceRaw = Number(payload.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : input.baselineDecision.confidence;

    const matchedSignals = Array.isArray(payload.matchedSignals)
      ? payload.matchedSignals.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0)
      : [];

    return {
      action,
      workerSlug: asString(payload.workerSlug),
      templateId: asString(payload.templateId) ?? input.baselineDecision.templateId,
      confidence,
      reason: asString(payload.reason) ?? "AI routing fallback.",
      matchedSignals,
    };
  };

  const routeIssue = async (input: {
    issue: NormalizedLinearIssue;
    policy?: LinearSyncConfig;
  }): Promise<LinearRouteDecision> => {
    const policy = args.flowPolicyService.normalizePolicy(input.policy ?? args.flowPolicyService.getPolicy());
    const issue = input.issue;

    const projectPolicy = resolveProjectPolicy(policy, issue.projectSlug);

    let action: LinearAutoDispatchAction = policy.autoDispatch?.default ?? "escalate";
    let templateId = resolveDefaultTemplate(issue);
    let matchedRuleId: string | null = null;
    const matchedSignals: string[] = [];

    for (const rule of policy.autoDispatch?.rules ?? []) {
      const match = matchRule(issue, rule.match ?? undefined);
      if (!match.matched) continue;
      action = rule.action;
      templateId = rule.template?.trim() || templateId;
      matchedRuleId = rule.id ?? null;
      matchedSignals.push(...match.signals);
      break;
    }

    let reason = matchedRuleId
      ? `Matched auto-dispatch rule ${matchedRuleId}.`
      : `No explicit rule matched; using default action ${action}.`;

    let workerSlug: string | null = null;

    const labelRouteMap = policy.routing?.byLabel ?? {};
    const labelMatch = issue.labels
      .map((label) => labelRouteMap[normalizeLabel(label)])
      .find((entry) => typeof entry === "string" && entry.trim().length > 0);
    if (labelMatch) {
      workerSlug = labelMatch;
      matchedSignals.push(`labelRoute:${workerSlug}`);
      reason = `Label-based routing matched worker ${workerSlug}.`;
    }

    if (!workerSlug && projectPolicy?.defaultWorker) {
      workerSlug = projectPolicy.defaultWorker;
      matchedSignals.push(`projectDefault:${workerSlug}`);
      reason = `Project default worker ${workerSlug} selected.`;
    }

    let decision: LinearRouteDecision = {
      action,
      workerSlug,
      workerId: null,
      workerName: null,
      templateId,
      reason,
      confidence: matchedRuleId ? 0.95 : workerSlug ? 0.82 : 0.55,
      matchedRuleId,
      matchedSignals: Array.from(new Set(matchedSignals)),
    };

    const classificationMode = policy.classification?.mode ?? "hybrid";
    const confidenceThreshold = policy.classification?.confidenceThreshold ?? 0.7;
    const shouldCallAi =
      classificationMode === "ai" ||
      (classificationMode === "hybrid" && (decision.confidence < confidenceThreshold || !decision.workerSlug));

    if (shouldCallAi) {
      try {
        const aiPatch = await aiRouteFallback({ issue, baselineDecision: decision, policy });
        decision = {
          ...decision,
          ...aiPatch,
          reason: aiPatch.reason ? `${aiPatch.reason} (AI)` : decision.reason,
          matchedSignals: Array.from(new Set([...(decision.matchedSignals ?? []), ...(aiPatch.matchedSignals ?? [])])),
        };
      } catch {
        decision = {
          ...decision,
          reason: `${decision.reason} AI fallback unavailable; using heuristic route.`,
        };
      }
    }

    const worker = findWorkerBySlug(decision.workerSlug);
    decision.workerId = worker?.id ?? null;
    decision.workerName = worker?.name ?? null;

    if (!worker && decision.action === "auto") {
      decision.action = "escalate";
      decision.reason = `${decision.reason} Worker could not be resolved; escalating.`;
      decision.confidence = Math.min(decision.confidence, 0.4);
    }

    if (!decision.workerSlug) {
      decision.reason = `${decision.reason} No worker matched.`;
      decision.confidence = Math.min(decision.confidence, 0.4);
    }

    return decision;
  };

  return {
    routeIssue,
    simulateRoute: routeIssue,
  };
}

export type LinearRoutingService = ReturnType<typeof createLinearRoutingService>;
