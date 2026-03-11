import type { AgentIdentity, AutomationRule } from "../../../shared/types";
import type { createWorkerAgentService } from "../cto/workerAgentService";

type AutomationRoutingServiceArgs = {
  workerAgentService: ReturnType<typeof createWorkerAgentService>;
};

export type AutomationRouteDecision = {
  status: "matched" | "no-match";
  worker: AgentIdentity | null;
  confidence: number;
  reason: string;
};

function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scoreWorker(worker: AgentIdentity, rule: AutomationRule): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const hints = rule.executor.routingHints;
  const workerCapabilities = new Set(worker.capabilities.map((entry) => entry.trim().toLowerCase()));

  if (worker.status === "paused") return { score: -1, reasons: ["worker is paused"] };

  if (hints?.preferredWorkerIds?.includes(worker.id)) {
    score += 0.45;
    reasons.push("preferred worker");
  }

  if (hints?.requiredCapabilities?.length) {
    const matched = hints.requiredCapabilities.filter((entry) => workerCapabilities.has(entry.trim().toLowerCase()));
    if (!matched.length) {
      return { score: 0, reasons: ["missing required capabilities"] };
    }
    score += Math.min(0.35, matched.length * 0.12);
    reasons.push(`capabilities:${matched.join(",")}`);
  }

  const promptTokens = normalizedTokens(`${rule.name} ${rule.description ?? ""} ${rule.prompt ?? ""}`);
  const roleTokens = new Set(normalizedTokens(`${worker.role} ${worker.name} ${worker.title ?? ""}`));
  const lexicalOverlap = promptTokens.filter((token) => roleTokens.has(token)).length;
  if (lexicalOverlap > 0) {
    score += Math.min(0.2, lexicalOverlap * 0.05);
    reasons.push("prompt-role overlap");
  }

  if (rule.reviewProfile === "security" && workerCapabilities.has("security")) {
    score += 0.18;
    reasons.push("security profile");
  }
  if (rule.toolPalette.includes("tests") && workerCapabilities.has("testing")) {
    score += 0.14;
    reasons.push("testing capability");
  }
  if (rule.toolPalette.includes("browser") && workerCapabilities.has("browser")) {
    score += 0.12;
    reasons.push("browser capability");
  }

  return { score, reasons };
}

export function createAutomationRoutingService(args: AutomationRoutingServiceArgs) {
  return {
    route(rule: AutomationRule): AutomationRouteDecision {
      const workers = args.workerAgentService.listAgents({ includeDeleted: false });
      if (!workers.length) {
        return { status: "no-match", worker: null, confidence: 0, reason: "No active workers are configured." };
      }
      const ranked = workers
        .map((worker) => ({ worker, ...scoreWorker(worker, rule) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best || best.score < 0.3) {
        return {
          status: "no-match",
          worker: null,
          confidence: best ? Math.max(0, Math.min(1, best.score)) : 0,
          reason: best ? `Top match too weak (${best.score.toFixed(2)}).` : "No workers matched routing hints.",
        };
      }
      return {
        status: "matched",
        worker: best.worker,
        confidence: Math.max(0, Math.min(1, best.score)),
        reason: best.reasons.join("; ") || "Matched by automation routing heuristics.",
      };
    },
  };
}

export type AutomationRoutingService = ReturnType<typeof createAutomationRoutingService>;
