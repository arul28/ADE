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
import { normalizeMissionPermissions } from "../orchestrator/permissionMapping";
import type { MissionPermissionConfig } from "../../../shared/types/missions";
import { isRecord, nowIso } from "../shared/utils";

function toNonEmptyString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function normalizePhaseCards(phases: PhaseCard[]): PhaseCard[] {
  return [...phases]
    .sort((a, b) => a.position - b.position)
    .map((phase, index) => {
      const phaseKey = String(phase.phaseKey ?? "").trim().toLowerCase();
      const requiresApproval = phaseKey === "planning" ? true : (phase.requiresApproval === true);
      return { ...phase, requiresApproval, position: index };
    });
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
    let orchestratorModelId: string | null = null;
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
      orchestratorModelId = toNonEmptyString(launch.modelConfig?.orchestratorModel?.modelId);
      if (orchestratorModelId) {
        requestedModels.push({
          label: "Orchestrator",
          modelId: orchestratorModelId,
        });
      } else {
        modelFailures.push("Orchestrator: missing modelConfig.orchestratorModel.modelId.");
      }

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

    const capabilityIssues: string[] = [];
    const capabilityWarnings: string[] = [];
    for (const phase of selected.phases) {
      const evidenceRequirements = phase.validationGate.evidenceRequirements ?? [];
      if (!phase.validationGate.required || evidenceRequirements.length === 0) continue;
      const descriptor = getModelById(phase.model.modelId) ?? resolveModelAlias(phase.model.modelId);
      const requiresBrowserEvidence = evidenceRequirements.some((requirement) =>
        requirement === "screenshot"
        || requirement === "browser_verification"
        || requirement === "browser_trace"
        || requirement === "video_recording"
      );
      if (requiresBrowserEvidence && descriptor) {
        const likelyBrowserCapable = descriptor.capabilities.tools && descriptor.capabilities.vision;
        if (!likelyBrowserCapable) {
          const message = `${phase.name}: requires browser/screenshot evidence, but ${descriptor.displayName} does not advertise both tools and vision support.`;
          if ((phase.validationGate.capabilityFallback ?? "block") === "block") capabilityIssues.push(message);
          else capabilityWarnings.push(message);
        }
      }
      if (requiresBrowserEvidence && !descriptor) {
        const message = `${phase.name}: requires browser/screenshot evidence, but model ${phase.model.modelId} could not be resolved for capability checks.`;
        if ((phase.validationGate.capabilityFallback ?? "block") === "block") capabilityIssues.push(message);
        else capabilityWarnings.push(message);
      }
    }

    const selectedPrStrategy = launch.executionPolicy?.prStrategy;
    const activeLanes = await laneService.list({ includeArchived: false }).catch(() => []);
    const needsCliConflictResolver =
      (
        selectedPrStrategy?.kind === "integration"
        && (selectedPrStrategy.prDepth ?? "resolve-conflicts") !== "propose-only"
      )
      || (
        selectedPrStrategy?.kind === "queue"
        && (selectedPrStrategy.autoLand === true || selectedPrStrategy.rehearseQueue === true)
        && selectedPrStrategy.autoResolveConflicts === true
      );
    if (selectedPrStrategy?.kind === "queue" && selectedPrStrategy.autoLand === true && selectedPrStrategy.rehearseQueue === true) {
      capabilityIssues.push("Queue finalization cannot auto-land and dry-run the queue at the same time. Pick either auto-land or rehearse-only.");
    }
    if (selectedPrStrategy?.kind === "queue" && selectedPrStrategy.rehearseQueue === true) {
      const targetBranch = toNonEmptyString(selectedPrStrategy.targetBranch) ?? "main";
      const stripRefPrefix = (ref: string) => ref.trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
      const targetExists = activeLanes.some((lane) => {
        const branchRef = stripRefPrefix(String((lane as { branchRef?: string }).branchRef ?? ""));
        const baseRef = stripRefPrefix(String((lane as { baseRef?: string }).baseRef ?? ""));
        return lane.id === targetBranch || branchRef === targetBranch || baseRef === targetBranch;
      });
      if (!targetExists) {
        capabilityIssues.push(`Queue rehearsal requires a local lane for target branch "${targetBranch}", but ADE could not find one.`);
      }
    }
    if (needsCliConflictResolver) {
      const hasCliResolverModel = [
        ...selected.phases.map((phase) => phase.model.modelId),
        orchestratorModelId ?? "",
        selectedPrStrategy?.kind === "queue" ? selectedPrStrategy.conflictResolverModel ?? "" : "",
      ]
        .map((modelId) => getModelById(modelId) ?? resolveModelAlias(modelId))
        .some((d) => d?.isCliWrapped && (d.family === "anthropic" || d.family === "openai"));
      if (!hasCliResolverModel) {
        capabilityIssues.push(
          selectedPrStrategy?.kind === "queue"
            ? selectedPrStrategy.rehearseQueue
              ? "Queue rehearsal is configured to resolve conflicts automatically, but no compatible Claude/Codex CLI resolver model is configured on the mission."
              : "Queue auto-land is configured to resolve conflicts automatically, but no compatible Claude/Codex CLI resolver model is configured on the mission."
            : "Integration finalization is configured to resolve conflicts automatically, but no compatible Claude/Codex CLI resolver model is configured on the mission."
        );
      }
    }

    checklist.push(
      capabilityIssues.length === 0 && capabilityWarnings.length === 0
        ? toChecklistItem({
            id: "capabilities",
            severity: "pass",
            title: "Capability contracts",
            summary: "Configured evidence and finalization contracts have matching runtime capabilities.",
            details: ["No blocking capability gaps detected in the selected phase or finalization contract."],
          })
        : toChecklistItem({
            id: "capabilities",
            severity: capabilityIssues.length > 0 ? "fail" : "warning",
            title: "Capability contracts",
            summary: capabilityIssues.length > 0
              ? "One or more required capabilities are missing for the selected mission contract."
              : "Some optional capability-backed evidence may require fallback or operator review.",
            details: [...capabilityIssues, ...capabilityWarnings],
            fixHint: "Switch to models that support the required evidence/finalization flow, or relax the phase/finalization contract before launch.",
          }),
    );

    const requestedDescriptors = new Map<string, ReturnType<typeof getModelById>>();
    for (const phase of selected.phases) {
      const descriptor = getModelById(phase.model.modelId) ?? resolveModelAlias(phase.model.modelId);
      if (descriptor) requestedDescriptors.set(descriptor.id, descriptor);
    }
    const orchestratorDescriptor = toNonEmptyString(launch.modelConfig?.orchestratorModel?.modelId)
      ? getModelById(launch.modelConfig!.orchestratorModel.modelId)
        ?? resolveModelAlias(launch.modelConfig!.orchestratorModel.modelId)
      : null;
    if (orchestratorDescriptor) requestedDescriptors.set(orchestratorDescriptor.id, orchestratorDescriptor);

    // Determine which model families are in use
    const familiesInUse = new Set<"anthropic" | "openai" | "api">();
    for (const descriptor of requestedDescriptors.values()) {
      if (!descriptor) continue;
      if (descriptor.isCliWrapped && descriptor.family === "anthropic") familiesInUse.add("anthropic");
      else if (descriptor.isCliWrapped && descriptor.family === "openai") familiesInUse.add("openai");
      else if (!descriptor.isCliWrapped) familiesInUse.add("api");
    }

    // Build per-provider permission config from project + mission overrides
    const config = projectConfigService.get();
    const aiConfig = config.effective.ai;
    const projectPermissions = aiConfig?.permissions;
    const projectPermConfig: MissionPermissionConfig = {};
    if (projectPermissions?.cli) {
      projectPermConfig.cli = {
        ...(typeof projectPermissions.cli.mode === "string" ? { mode: projectPermissions.cli.mode as MissionPermissionConfig["cli"] extends { mode?: infer M } ? M : never } : {}),
      };
    }
    if (projectPermissions?.inProcess) {
      const m = projectPermissions.inProcess.mode;
      if (m === "plan" || m === "edit" || m === "full-auto") projectPermConfig.inProcess = { mode: m };
    }
    let providers = normalizeMissionPermissions(projectPermConfig);
    if (launch.permissionConfig) {
      const missionProviders = normalizeMissionPermissions(launch.permissionConfig);
      providers = { ...providers, ...missionProviders };
    }

    const permissionWarnings: string[] = [];
    const permissionDetails: string[] = [];

    if (familiesInUse.has("anthropic")) {
      const mode = providers.claude ?? "full-auto";
      permissionDetails.push(`Claude workers: ${mode}`);
      if (mode !== "full-auto") {
        permissionWarnings.push(`Claude workers: ${mode} mode — shell commands require approval.`);
      }
    }
    if (familiesInUse.has("openai")) {
      const mode = providers.codex ?? "full-auto";
      permissionDetails.push(`Codex workers: ${mode}`);
      if (mode !== "full-auto") {
        permissionWarnings.push(`Codex workers: ${mode} mode — all commands require approval.`);
      }
    }
    if (familiesInUse.has("api")) {
      const mode = providers.unified ?? "full-auto";
      permissionDetails.push(`API workers: ${mode}`);
      if (mode !== "full-auto") {
        permissionWarnings.push(`API workers: ${mode} mode — modifications require approval.`);
      }
    }

    checklist.push(
      permissionWarnings.length === 0
        ? toChecklistItem({
            id: "permissions",
            severity: "pass",
            title: "Permissions",
            summary: "All worker families configured for unattended full-auto execution.",
            details: permissionDetails.length > 0 ? permissionDetails : ["No provider-specific permission requirements detected."],
          })
        : toChecklistItem({
            id: "permissions",
            severity: "warning",
            title: "Permissions",
            summary: "Some workers may pause for approval during execution.",
            details: [...permissionDetails, "", ...permissionWarnings],
            fixHint: "Non-full-auto modes are valid but workers will pause for user approval. Set full-auto if you want fully unattended execution.",
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
      } else if (availableLanes.length < expectedWorkers) {
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
    const forecast = budget.estimate.forecast ?? null;
    const budgetDetails = budget.estimate.mode === "subscription"
      ? [
          `Mode: ${budget.estimate.mode}`,
          `Estimated time: ${summarizeDuration(budget.estimate.estimatedTimeMs)}`,
          ...(budget.estimate.actualSpendUsd != null
            ? [`Observed spend so far: ${summarizeUsd(budget.estimate.actualSpendUsd)}`]
            : []),
          ...(budget.estimate.note ? [budget.estimate.note] : []),
        ]
      : [
          `Estimated: ${summarizeUsd(budget.estimate.estimatedCostUsd)} / ${summarizeDuration(budget.estimate.estimatedTimeMs)}`,
          `Mode: ${budget.estimate.mode}`,
          ...(budget.estimate.actualSpendUsd != null
            ? [`Actual spend so far (window): ${summarizeUsd(budget.estimate.actualSpendUsd)}`]
            : []),
          ...(budget.estimate.burnRateUsdPerHour != null
            ? [`Live burn rate: ${summarizeUsd(budget.estimate.burnRateUsdPerHour)}/hour`]
            : []),
          ...(forecast
            ? [
                `Forecast cost (low/median/high): ${summarizeUsd(forecast.lowCostUsd)} / ${summarizeUsd(forecast.medianCostUsd)} / ${summarizeUsd(forecast.highCostUsd)}`,
                `Forecast time (low/median/high): ${summarizeDuration(forecast.lowDurationMs)} / ${summarizeDuration(forecast.medianDurationMs)} / ${summarizeDuration(forecast.highDurationMs)}`,
                `Forecast confidence: ${forecast.confidence != null ? `${Math.round(forecast.confidence * 100)}%` : "n/a"} (n=${forecast.sampleSize}, basis: ${forecast.basis})`,
              ]
            : []),
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
              summary: "Subscription mode budget uses observed local CLI telemetry (predictive cost forecast is disabled).",
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
    const teamRuntimeConfig = launch.teamRuntime ?? launch.executionPolicy?.teamRuntime ?? null;
    const selectedLaneId = toNonEmptyString(launch.laneId);
    const selectedLaneLabel = selectedLaneId
      ? activeLanes.find((lane) => lane.id === selectedLaneId)?.name ?? null
      : null;
    const approvalSummary: MissionPreflightResult["approvalSummary"] = {
      missionGoal:
        toNonEmptyString(launch.title)
        ?? launch.prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
        ?? "Mission",
      laneId: selectedLaneId,
      laneLabel: selectedLaneLabel,
      recommendedExecution: {
        orchestratorModelId,
        strategy: teamRuntimeConfig?.enabled
          ? `Team runtime with ${Math.max(1, teamRuntimeConfig.teammateCount ?? 2)} teammate${Math.max(1, teamRuntimeConfig.teammateCount ?? 2) === 1 ? "" : "s"}`
          : selected.phases.length > 1
            ? `Phased execution across ${selected.phases.length} stages`
            : "Single-run mission execution",
        teamRuntimeEnabled: teamRuntimeConfig?.enabled === true,
        teammateCount: teamRuntimeConfig?.enabled === true ? Math.max(1, teamRuntimeConfig.teammateCount ?? 2) : 0,
      },
      phaseLabels: selected.phases.map((phase) => phase.name),
      validationApproach: selected.phases.map((phase) => {
        const gate = phase.validationGate;
        const tier = gate.tier === "dedicated" ? "dedicated review" : gate.tier === "self" ? "self-check" : "no formal gate";
        return `${phase.name}: ${gate.required ? "required" : "optional"} ${tier}`;
      }),
      conflictAssumptions: [
        selectedLaneId
          ? `Primary mission lane: ${selectedLaneLabel ?? selectedLaneId}.`
          : "Mission will attach to the default active lane if no explicit lane is selected.",
        worktreeItem.severity === "warning"
          ? "Parallel fan-out may be reduced because available worktrees are below the ideal concurrency target."
          : "ADE can provision or reuse enough active lanes for the expected worker fan-out.",
        selectedPrStrategy?.kind === "queue"
          ? "Queue finalization will respect the configured rehearse/auto-land settings and surface conflicts if automation is blocked."
          : selectedPrStrategy?.kind === "integration"
            ? "Integration finalization will open or land PRs using the configured PR depth and conflict policy."
            : "Mission will complete without a special PR/queue finalization contract.",
      ],
      knownBlockers: checklist
        .filter((item) => item.severity === "fail")
        .flatMap((item) => [item.summary, ...item.details])
        .slice(0, 8),
    };

    return {
      canLaunch: hardFailures === 0,
      checkedAt: nowIso(),
      profileName: selected.profile?.name ?? null,
      selectedPhaseCount: selected.phases.length,
      hardFailures,
      warnings,
      checklist,
      budgetEstimate: budget.estimate,
      approvalSummary,
    };
  };

  return {
    runPreflight,
  };
}

export type MissionPreflightService = ReturnType<typeof createMissionPreflightService>;
