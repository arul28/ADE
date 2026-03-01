import type { Logger } from "../logging/logger";
import type { createMissionService } from "./missionService";
import type { createLaneService } from "../lanes/laneService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type {
  MissionPreflightChecklistItem,
  MissionPreflightRequest,
  MissionPreflightResult,
  PhaseCard,
  PhaseProfile,
} from "../../../shared/types";
import { createBuiltInPhaseCards, validatePhaseSequence } from "./phaseEngine";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import type { MissionBudgetService } from "../orchestrator/missionBudgetService";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function toNonEmptyString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function normalizePhaseCards(phases: PhaseCard[]): PhaseCard[] {
  return [...phases]
    .sort((a, b) => a.position - b.position)
    .map((phase, index) => ({ ...phase, position: index }));
}

function summarizeDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "n/a";
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  return `${mins}m`;
}

function summarizeUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `$${value.toFixed(2)}`;
}

function toChecklistItem(args: {
  id: MissionPreflightChecklistItem["id"];
  severity: MissionPreflightChecklistItem["severity"];
  title: string;
  summary: string;
  details: string[];
  fixHint?: string;
}): MissionPreflightChecklistItem {
  return {
    id: args.id,
    severity: args.severity,
    title: args.title,
    summary: args.summary,
    details: args.details,
    ...(args.fixHint ? { fixHint: args.fixHint } : {}),
  };
}

function resolveSelectedPhases(args: {
  launch: MissionPreflightRequest["launch"];
  profiles: PhaseProfile[];
}): { profile: PhaseProfile | null; phases: PhaseCard[] } {
  const requestedProfileId = toNonEmptyString(args.launch.phaseProfileId);
  const selectedProfile = requestedProfileId
    ? args.profiles.find((profile) => profile.id === requestedProfileId) ?? null
    : args.profiles.find((profile) => profile.isDefault) ?? args.profiles[0] ?? null;
  const hasOverride = Array.isArray(args.launch.phaseOverride) && args.launch.phaseOverride.length > 0;
  const phases = normalizePhaseCards(
    hasOverride
      ? args.launch.phaseOverride ?? []
      : selectedProfile?.phases?.length
        ? selectedProfile.phases
        : createBuiltInPhaseCards(),
  );
  return { profile: selectedProfile, phases };
}

export function createMissionPreflightService(args: {
  logger: Logger;
  projectRoot: string;
  missionService: ReturnType<typeof createMissionService>;
  laneService: ReturnType<typeof createLaneService>;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  missionBudgetService: MissionBudgetService;
}) {
  const {
    logger,
    projectRoot,
    missionService,
    laneService,
    aiIntegrationService,
    projectConfigService,
    missionBudgetService,
  } = args;

  const runPreflight = async (request: MissionPreflightRequest): Promise<MissionPreflightResult> => {
    const launch = request.launch;
    const profiles = missionService.listPhaseProfiles({});
    const selected = resolveSelectedPhases({ launch, profiles });

    const checklist: MissionPreflightChecklistItem[] = [];

    const structuralIssues: string[] = [];
    for (const [index, phase] of selected.phases.entries()) {
      const prefix = `Phase ${index + 1} (${phase.name || phase.phaseKey || "unnamed"})`;
      if (!toNonEmptyString(phase.phaseKey)) structuralIssues.push(`${prefix}: missing phase key.`);
      if (!toNonEmptyString(phase.name)) structuralIssues.push(`${prefix}: missing phase name.`);
      if (!toNonEmptyString(phase.description)) structuralIssues.push(`${prefix}: missing description.`);
      if (!toNonEmptyString(phase.instructions)) structuralIssues.push(`${prefix}: missing instructions.`);
      if (!toNonEmptyString(phase.model.modelId)) structuralIssues.push(`${prefix}: missing model ID.`);
      if (!toNonEmptyString(phase.model.provider)) structuralIssues.push(`${prefix}: missing model provider.`);
    }
    checklist.push(
      structuralIssues.length === 0
        ? toChecklistItem({
            id: "phase_structural",
            severity: "pass",
            title: "Phase configuration — structural",
            summary: `All ${selected.phases.length} phase cards have required fields.`,
            details: [`Profile: ${selected.profile?.name ?? "Built-in default"}`],
          })
        : toChecklistItem({
            id: "phase_structural",
            severity: "fail",
            title: "Phase configuration — structural",
            summary: "One or more phase cards are missing required fields.",
            details: structuralIssues,
            fixHint: "Fill in each phase card's key, name, description, instructions, and model configuration.",
          }),
    );

    const orderingErrors = validatePhaseSequence(selected.phases);
    checklist.push(
      orderingErrors.length === 0
        ? toChecklistItem({
            id: "phase_ordering",
            severity: "pass",
            title: "Phase configuration — ordering",
            summary: "Ordering constraints are satisfiable.",
            details: ["No cycles or ordering violations detected."],
          })
        : toChecklistItem({
            id: "phase_ordering",
            severity: "fail",
            title: "Phase configuration — ordering",
            summary: "Ordering constraints are invalid.",
            details: orderingErrors,
            fixHint: "Reorder phases or update mustFollow/mustPrecede constraints to remove conflicts.",
          }),
    );

    let modelAvailabilityDetails: string[] = [];
    let modelFailures: string[] = [];
    let availabilityModels: Array<{ id: string; shortId: string; family: string; displayName: string }> = [];
    try {
      const availability = await aiIntegrationService.getAvailabilityAsync();
      availabilityModels = Array.isArray((availability as { availableModels?: unknown[] }).availableModels)
        ? ((availability as { availableModels?: unknown[] }).availableModels as Array<{ id: string; shortId: string; family: string; displayName: string }>)
        : [];

      const requestedModels: Array<{ label: string; modelId: string }> = [];
      for (const phase of selected.phases) {
        if (toNonEmptyString(phase.model.modelId)) {
          requestedModels.push({
            label: `${phase.name}`,
            modelId: phase.model.modelId,
          });
        }
      }
      const orchestratorModel = toNonEmptyString(launch.modelConfig?.orchestratorModel?.modelId)
        ?? toNonEmptyString(launch.orchestratorModel)
        ?? "anthropic/claude-sonnet-4-6";
      requestedModels.push({
        label: "Orchestrator",
        modelId: orchestratorModel,
      });

      for (const requestModel of requestedModels) {
        const resolved = getModelById(requestModel.modelId) ?? resolveModelAlias(requestModel.modelId);
        if (!resolved) {
          const requestedRaw = requestModel.modelId.trim().toLowerCase();
          const availableDirect = availabilityModels.some((candidate) => {
            const candidateId = typeof candidate.id === "string" ? candidate.id.trim().toLowerCase() : "";
            const candidateShortId = typeof candidate.shortId === "string" ? candidate.shortId.trim().toLowerCase() : "";
            return candidateId === requestedRaw || candidateShortId === requestedRaw;
          });
          if (availableDirect) {
            modelAvailabilityDetails.push(`${requestModel.label}: ${requestModel.modelId} — available`);
            continue;
          }
          modelFailures.push(`${requestModel.label}: unknown model "${requestModel.modelId}".`);
          continue;
        }
        const available = availabilityModels.some((candidate) =>
          candidate.id === resolved.id
          || candidate.shortId === resolved.shortId
          || candidate.family === resolved.family,
        );
        if (!available) {
          modelFailures.push(`${requestModel.label}: ${resolved.displayName} is not detected/authenticated.`);
        } else {
          modelAvailabilityDetails.push(`${requestModel.label}: ${resolved.displayName} — available`);
        }
      }
    } catch (error) {
      modelFailures.push(`Model detection failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    checklist.push(
      modelFailures.length === 0
        ? toChecklistItem({
            id: "models",
            severity: "pass",
            title: "Models detected & authenticated",
            summary: "All selected phase and orchestrator models are available.",
            details: modelAvailabilityDetails.length > 0 ? modelAvailabilityDetails : ["Model detection succeeded."],
          })
        : toChecklistItem({
            id: "models",
            severity: "fail",
            title: "Models detected & authenticated",
            summary: "One or more selected models are unavailable.",
            details: modelFailures,
            fixHint: "Authenticate the required provider CLIs/API keys or switch the phase/orchestrator model.",
          }),
    );

    const requiredProviders = new Set<string>();
    for (const phase of selected.phases) {
      const explicitProvider = toNonEmptyString(phase.model.provider);
      if (explicitProvider) requiredProviders.add(explicitProvider.toLowerCase());
      const descriptor = getModelById(phase.model.modelId) ?? resolveModelAlias(phase.model.modelId);
      if (descriptor?.family === "anthropic") requiredProviders.add("claude");
      if (descriptor?.family === "openai") requiredProviders.add("codex");
    }
    const orchestratorProvider = toNonEmptyString(launch.modelConfig?.orchestratorModel?.provider);
    if (orchestratorProvider) requiredProviders.add(orchestratorProvider.toLowerCase());
    const orchestratorDescriptor = toNonEmptyString(launch.modelConfig?.orchestratorModel?.modelId)
      ? getModelById(launch.modelConfig!.orchestratorModel.modelId)
        ?? resolveModelAlias(launch.modelConfig!.orchestratorModel.modelId)
      : null;
    if (orchestratorDescriptor?.family === "anthropic") requiredProviders.add("claude");
    if (orchestratorDescriptor?.family === "openai") requiredProviders.add("codex");

    const config = projectConfigService.get();
    const aiConfig = config.effective.ai;
    const claudePerm = aiConfig?.permissions?.claude;
    const codexPerm = aiConfig?.permissions?.codex;
    const claudeFullAuto = claudePerm?.permissionMode === "bypassPermissions" || claudePerm?.dangerouslySkipPermissions === true;
    const codexFullAuto =
      codexPerm?.approvalMode === "full-auto"
      || codexPerm?.approvalMode === "never"
      || codexPerm?.sandboxPermissions === "danger-full-access";
    const permissionFailures: string[] = [];
    const permissionDetails: string[] = [];
    if (requiredProviders.has("claude")) {
      if (!claudeFullAuto) permissionFailures.push("Claude is not configured for full-auto (requires permissionMode=bypassPermissions).");
      permissionDetails.push(`Claude: ${claudeFullAuto ? "full-auto" : "not full-auto"}`);
    }
    if (requiredProviders.has("codex")) {
      if (!codexFullAuto) permissionFailures.push("Codex is not configured for full-auto (requires approvalMode=full-auto/never or sandboxPermissions=danger-full-access).");
      permissionDetails.push(`Codex: ${codexFullAuto ? "full-auto" : "not full-auto"}`);
    }
    checklist.push(
      permissionFailures.length === 0
        ? toChecklistItem({
            id: "permissions",
            severity: "pass",
            title: "Permissions",
            summary: "Required providers are configured for unattended full-auto execution.",
            details: permissionDetails.length > 0 ? permissionDetails : ["No provider-specific permission requirements detected."],
          })
        : toChecklistItem({
            id: "permissions",
            severity: "fail",
            title: "Permissions",
            summary: "Unattended execution requires full-auto permission settings.",
            details: permissionFailures,
            fixHint: "Update ai.permissions in local.yaml to full-auto for all providers used by this mission.",
          }),
    );

    let worktreeItem: MissionPreflightChecklistItem;
    try {
      const lanes = await laneService.list({});
      const availableLanes = lanes.filter((lane) => lane.archivedAt == null);
      const expectedWorkers =
        launch.executionPolicy?.teamRuntime?.enabled
          ? Math.max(1, (launch.executionPolicy.teamRuntime.teammateCount ?? 2) + 1)
          : 3;
      if (availableLanes.length === 0) {
        worktreeItem = toChecklistItem({
          id: "worktrees",
          severity: "fail",
          title: "Git worktrees available",
          summary: "No lanes/worktrees are available for worker assignment.",
          details: ["Create at least one lane before launching an autonomous mission."],
          fixHint: "Create or import a lane from the Lanes tab and rerun pre-flight.",
        });
      } else if (availableLanes.length <= expectedWorkers) {
        worktreeItem = toChecklistItem({
          id: "worktrees",
          severity: "warning",
          title: "Git worktrees available",
          summary: "Worktree capacity is tight for the expected worker fan-out.",
          details: [
            `${availableLanes.length} lanes available.`,
            `Expected worker parallelism: ~${expectedWorkers}.`,
          ],
        });
      } else {
        worktreeItem = toChecklistItem({
          id: "worktrees",
          severity: "pass",
          title: "Git worktrees available",
          summary: "Worktree capacity is sufficient for expected worker concurrency.",
          details: [
            `${availableLanes.length} lanes available.`,
            `Expected worker parallelism: ~${expectedWorkers}.`,
          ],
        });
      }
    } catch (error) {
      worktreeItem = toChecklistItem({
        id: "worktrees",
        severity: "fail",
        title: "Git worktrees available",
        summary: "Unable to determine lane/worktree capacity.",
        details: [error instanceof Error ? error.message : String(error)],
        fixHint: "Resolve lane service issues and rerun pre-flight.",
      });
    }
    checklist.push(worktreeItem);

    const customPhases = selected.phases.filter((phase) => phase.isCustom || phase.phaseKey.startsWith("custom_"));
    if (customPhases.length === 0) {
      checklist.push(
        toChecklistItem({
          id: "phase_semantic",
          severity: "pass",
          title: "Phase configuration — semantic",
          summary: "No custom phase semantic risks detected.",
          details: ["No custom phases configured."],
        }),
      );
    } else {
      const semanticWarnings: string[] = [];
      const shortInstructions = customPhases.filter((phase) => (phase.instructions?.trim().length ?? 0) < 20);
      for (const phase of shortInstructions) {
        semanticWarnings.push(`${phase.name}: instructions look too short for autonomous execution.`);
      }

      try {
        const evaluationPrompt = [
          "You are validating custom mission phase instructions for an autonomous coding orchestrator.",
          "For each phase, determine if instructions are concrete, actionable, and safe for autonomous execution.",
          "Return JSON with keys: clear (boolean), feedback (string[]).",
          "",
          ...customPhases.map((phase, index) => `${index + 1}. ${phase.name}\nInstructions: ${phase.instructions}`),
        ].join("\n");

        const semanticEval = await aiIntegrationService.executeTask({
          feature: "orchestrator",
          taskType: "planning",
          prompt: evaluationPrompt,
          cwd: projectRoot,
          model: "haiku",
          timeoutMs: 20_000,
          permissionMode: "read-only",
          jsonSchema: {
            type: "object",
            properties: {
              clear: { type: "boolean" },
              feedback: { type: "array", items: { type: "string" } },
            },
            required: ["clear", "feedback"],
            additionalProperties: false,
          },
        });

        const structured = isRecord(semanticEval.structuredOutput) ? semanticEval.structuredOutput : null;
        const clear = structured?.clear === true;
        const feedback = Array.isArray(structured?.feedback)
          ? structured.feedback.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
          : [];
        if (!clear) {
          semanticWarnings.push(...(feedback.length > 0 ? feedback : ["AI semantic check flagged unclear custom phase instructions."]));
        }
      } catch (error) {
        semanticWarnings.push(`Semantic AI check unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }

      checklist.push(
        semanticWarnings.length === 0
          ? toChecklistItem({
              id: "phase_semantic",
              severity: "pass",
              title: "Phase configuration — semantic",
              summary: "Custom phase instructions are actionable.",
              details: [`${customPhases.length} custom phase(s) evaluated.`],
            })
          : toChecklistItem({
              id: "phase_semantic",
              severity: "warning",
              title: "Phase configuration — semantic",
              summary: "Custom phase instructions may be ambiguous.",
              details: semanticWarnings,
              fixHint: "Make custom phase instructions specific about expected outputs, constraints, and done criteria.",
            }),
      );
    }

    const budget = await missionBudgetService.estimateLaunchBudget({
      launch,
      selectedPhases: selected.phases,
    });
    const budgetDetails = [
      `Estimated: ${summarizeUsd(budget.estimate.estimatedCostUsd)} / ${summarizeDuration(budget.estimate.estimatedTimeMs)}`,
      `Mode: ${budget.estimate.mode}`,
      ...budget.estimate.perPhase.map(
        (phase) => `${phase.phaseName}: ${summarizeUsd(phase.estimatedCostUsd)} / ${summarizeDuration(phase.estimatedTimeMs)}`,
      ),
      ...(budget.estimate.note ? [budget.estimate.note] : []),
    ];
    checklist.push(
      budget.hardLimitExceeded
        ? toChecklistItem({
            id: "budget",
            severity: "fail",
            title: "Budget",
            summary: "Estimated launch cost exceeds available API-key budget envelope.",
            details: budgetDetails,
            fixHint: "Reduce phase budgets/model cost or increase the configured smart budget threshold.",
          })
        : budget.estimate.mode === "subscription"
          ? toChecklistItem({
              id: "budget",
              severity: "warning",
              title: "Budget",
              summary: "Subscription mode budget is best-effort estimated from local CLI telemetry.",
              details: budgetDetails,
            })
          : toChecklistItem({
              id: "budget",
              severity: "pass",
              title: "Budget",
              summary: "Estimated launch cost fits within configured API-key budget envelope.",
              details: budgetDetails,
            }),
    );

    const hardFailures = checklist.filter((item) => item.severity === "fail").length;
    const warnings = checklist.filter((item) => item.severity === "warning").length;

    return {
      canLaunch: hardFailures === 0,
      checkedAt: nowIso(),
      profileName: selected.profile?.name ?? null,
      selectedPhaseCount: selected.phases.length,
      hardFailures,
      warnings,
      checklist,
      budgetEstimate: budget.estimate,
    };
  };

  return {
    runPreflight,
  };
}

export type MissionPreflightService = ReturnType<typeof createMissionPreflightService>;
