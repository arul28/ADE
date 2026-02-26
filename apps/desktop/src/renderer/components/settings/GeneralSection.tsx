import React, { useEffect, useState } from "react";
import type { AppInfo, ProjectConfigSnapshot, AiTaskRoutingKey, AiTaskProvider } from "../../../shared/types";
import { useAppStore, ThemeId, THEME_IDS } from "../../state/appStore";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";

const THEME_META: Record<ThemeId, { label: string; description: string; colors: { bg: string; fg: string; accent: string; card: string; border: string } }> = {
  dark: {
    label: "Dark",
    description: "After-hours office. Cyan glows against dark surfaces.",
    colors: { bg: "#0f0f11", fg: "#e4e4e7", accent: "#06d6a0", card: "#18181b", border: "#27272a" }
  },
  light: {
    label: "Light",
    description: "Morning office. Sunlit, clean, crisp accent.",
    colors: { bg: "#f5f5f6", fg: "#0f0f11", accent: "#049068", card: "#ffffff", border: "#d4d4d8" }
  }
};

function ThemeSwatch({ themeId, selected, onClick }: { themeId: ThemeId; selected: boolean; onClick: () => void }) {
  const { label, description, colors } = THEME_META[themeId];
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg p-3 transition-all border",
        selected
          ? "border-accent bg-accent/5 ring-1 ring-accent/30"
          : "border-border/30 hover:border-border/50 hover:bg-muted/60"
      )}
      title={label}
    >
      <div
        className="h-14 w-20 shrink-0 rounded-md border overflow-hidden"
        style={{ backgroundColor: colors.bg, borderColor: colors.border }}
      >
        <div className="h-2.5 w-full" style={{ backgroundColor: colors.card }} />
        <div className="mx-auto mt-1.5 h-1.5 w-12 rounded-full" style={{ backgroundColor: colors.accent }} />
        <div className="mx-1.5 mt-1.5 space-y-1">
          <div className="h-0.5 w-10 rounded-full" style={{ backgroundColor: colors.fg, opacity: 0.5 }} />
          <div className="h-0.5 w-7 rounded-full" style={{ backgroundColor: colors.fg, opacity: 0.3 }} />
        </div>
      </div>
      <div className="text-left">
        <div className="text-sm font-medium text-fg">{label}</div>
        <div className="text-xs text-muted-fg mt-0.5">{description}</div>
      </div>
      {selected && (
        <div className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-fg text-[10px] font-bold">
          ✓
        </div>
      )}
    </button>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBool(primary: unknown, fallback: unknown, defaultValue: boolean): boolean {
  if (typeof primary === "boolean") return primary;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

function readNumber(primary: unknown, fallback: unknown, defaultValue: number): number {
  const first = Number(primary);
  if (Number.isFinite(first)) return first;
  const second = Number(fallback);
  if (Number.isFinite(second)) return second;
  return defaultValue;
}

function readString(primary: unknown, fallback: unknown, defaultValue: string): string {
  if (typeof primary === "string" && primary.length > 0) return primary;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return defaultValue;
}

type DepthTier = "light" | "standard" | "deep";
type PlannerProvider = "auto" | "claude" | "codex";

const TASK_ROUTING_KEYS: AiTaskRoutingKey[] = [
  "planning",
  "implementation",
  "review",
  "narrative",
  "mission_planning"
];

const TASK_ROUTING_LABELS: Record<string, string> = {
  planning: "Planning",
  implementation: "Implementation",
  review: "Review",
  narrative: "Narrative",
  mission_planning: "Mission Planning"
};

type TaskRoutingDraft = Record<string, { provider: AiTaskProvider; model: string }>;

export function GeneralSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<ProjectConfigSnapshot | null>(null);

  // Mission defaults
  const [defaultDepthTier, setDefaultDepthTier] = useState<DepthTier>("standard");
  const [defaultPlannerProvider, setDefaultPlannerProvider] = useState<PlannerProvider>("auto");

  // Task routing
  const [taskRoutingDraft, setTaskRoutingDraft] = useState<TaskRoutingDraft>(() => {
    const initial: TaskRoutingDraft = {};
    for (const key of TASK_ROUTING_KEYS) {
      initial[key] = { provider: "auto", model: "" };
    }
    return initial;
  });

  // Orchestrator settings
  const [orchestratorDraft, setOrchestratorDraft] = useState({
    requirePlanReview: false,
    maxParallelWorkers: "4",
    maxRetriesPerStep: "2",
    contextPressureThreshold: "0.8",
    progressiveLoading: true,
    defaultMergePolicy: "sequential" as "sequential" | "batch-at-end" | "per-step",
    defaultConflictHandoff: "ask-user" as "auto-resolve" | "ask-user" | "orchestrator-decides",
    maxTotalTokenBudget: "0",
    maxPerStepTokenBudget: "0",
    autoResolveInterventions: false,
    interventionConfidenceThreshold: "0.7"
  });
  const [orchestratorBusy, setOrchestratorBusy] = useState(false);
  const [orchestratorError, setOrchestratorError] = useState<string | null>(null);
  const [orchestratorNotice, setOrchestratorNotice] = useState<string | null>(null);

  // Worker permission settings
  const [workerPermDraft, setWorkerPermDraft] = useState({
    claudePermissionMode: "acceptEdits" as string,
    claudeDangerouslySkip: false,
    codexSandboxPermissions: "workspace-write" as string,
    codexApprovalMode: "full-auto" as string,
    codexConfigPath: ""
  });

  const providerMode = useAppStore((s) => s.providerMode);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getInfo()
      .then((v) => {
        if (!cancelled) setInfo(v);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshOrchestratorDraft = React.useCallback(async () => {
    const snapshot = await window.ade.projectConfig.get();
    const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
    const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
    const effectiveAi = isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};
    const effectiveOrchestrator = isRecord(effectiveAi.orchestrator) ? effectiveAi.orchestrator : {};
    setConfigSnapshot(snapshot);

    // Mission defaults from config
    setDefaultDepthTier(
      readString(localOrchestrator.defaultDepthTier, effectiveOrchestrator.defaultDepthTier, "standard") as DepthTier
    );
    setDefaultPlannerProvider(
      readString(localOrchestrator.defaultPlannerProvider, effectiveOrchestrator.defaultPlannerProvider, "auto") as PlannerProvider
    );

    // Task routing
    const localRouting = isRecord(localAi.taskRouting) ? localAi.taskRouting : (isRecord(localAi.task_routing) ? localAi.task_routing : {});
    const effectiveRouting = isRecord(effectiveAi.taskRouting) ? effectiveAi.taskRouting : (isRecord(effectiveAi.task_routing) ? effectiveAi.task_routing : {});
    const nextRouting: TaskRoutingDraft = {};
    for (const key of TASK_ROUTING_KEYS) {
      const local = isRecord(localRouting[key]) ? localRouting[key] : {};
      const effective = isRecord(effectiveRouting[key]) ? effectiveRouting[key] : {};
      nextRouting[key] = {
        provider: readString(local.provider, effective.provider, "auto") as AiTaskProvider,
        model: readString(local.model, effective.model, "")
      };
    }
    setTaskRoutingDraft(nextRouting);

    setOrchestratorDraft({
      requirePlanReview: readBool(localOrchestrator.requirePlanReview, effectiveOrchestrator.requirePlanReview, false),
      maxParallelWorkers: String(
        Math.max(1, Math.floor(readNumber(localOrchestrator.maxParallelWorkers, effectiveOrchestrator.maxParallelWorkers, 4)))
      ),
      maxRetriesPerStep: String(
        Math.max(0, Math.floor(readNumber(localOrchestrator.maxRetriesPerStep, effectiveOrchestrator.maxRetriesPerStep, 2)))
      ),
      contextPressureThreshold: String(
        Math.max(0.1, Math.min(0.99, readNumber(localOrchestrator.contextPressureThreshold, effectiveOrchestrator.contextPressureThreshold, 0.8)))
      ),
      progressiveLoading: readBool(localOrchestrator.progressiveLoading, effectiveOrchestrator.progressiveLoading, true),
      defaultMergePolicy: readString(localOrchestrator.defaultMergePolicy, effectiveOrchestrator.defaultMergePolicy, "sequential") as "sequential" | "batch-at-end" | "per-step",
      defaultConflictHandoff: readString(localOrchestrator.defaultConflictHandoff, effectiveOrchestrator.defaultConflictHandoff, "ask-user") as "auto-resolve" | "ask-user" | "orchestrator-decides",
      maxTotalTokenBudget: String(Math.max(0, readNumber(localOrchestrator.maxTotalTokenBudget, effectiveOrchestrator.maxTotalTokenBudget, 0))),
      maxPerStepTokenBudget: String(Math.max(0, readNumber(localOrchestrator.maxPerStepTokenBudget, effectiveOrchestrator.maxPerStepTokenBudget, 0))),
      autoResolveInterventions: readBool(localOrchestrator.autoResolveInterventions, effectiveOrchestrator.autoResolveInterventions, false),
      interventionConfidenceThreshold: String(
        Math.max(0, Math.min(1, readNumber(localOrchestrator.interventionConfidenceThreshold, effectiveOrchestrator.interventionConfidenceThreshold, 0.7)))
      )
    });

    // Worker permissions
    const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
    const effectivePermissions = isRecord(effectiveAi.permissions) ? effectiveAi.permissions : {};
    const localClaude = isRecord(localPermissions.claude) ? localPermissions.claude : {};
    const effectiveClaude = isRecord(effectivePermissions.claude) ? effectivePermissions.claude : {};
    const localCodex = isRecord(localPermissions.codex) ? localPermissions.codex : {};
    const effectiveCodex = isRecord(effectivePermissions.codex) ? effectivePermissions.codex : {};
    setWorkerPermDraft({
      claudePermissionMode: readString(localClaude.permissionMode, effectiveClaude.permissionMode, "acceptEdits"),
      claudeDangerouslySkip: readBool(localClaude.dangerouslySkipPermissions, effectiveClaude.dangerouslySkipPermissions, false),
      codexSandboxPermissions: readString(localCodex.sandboxPermissions, effectiveCodex.sandboxPermissions, "workspace-write"),
      codexApprovalMode: readString(localCodex.approvalMode, effectiveCodex.approvalMode, "full-auto"),
      codexConfigPath: readString(localCodex.configPath, effectiveCodex.configPath, "")
    });
  }, []);

  useEffect(() => {
    void refreshOrchestratorDraft().catch((error) => {
      setOrchestratorError(error instanceof Error ? error.message : String(error));
    });
  }, [refreshOrchestratorDraft]);

  const saveAllSettings = async () => {
    setOrchestratorError(null);
    setOrchestratorNotice(null);
    const maxParallelWorkers = Number(orchestratorDraft.maxParallelWorkers);
    const maxRetriesPerStep = Number(orchestratorDraft.maxRetriesPerStep);
    const contextPressureThreshold = Number(orchestratorDraft.contextPressureThreshold);
    const interventionConfidenceThreshold = Number(orchestratorDraft.interventionConfidenceThreshold);
    if (!Number.isFinite(maxParallelWorkers) || maxParallelWorkers < 1 || maxParallelWorkers > 10) {
      setOrchestratorError("Max parallel workers must be between 1 and 10.");
      return;
    }
    if (!Number.isFinite(maxRetriesPerStep) || maxRetriesPerStep < 0 || maxRetriesPerStep > 8) {
      setOrchestratorError("Max retries per step must be between 0 and 8.");
      return;
    }
    if (!Number.isFinite(contextPressureThreshold) || contextPressureThreshold < 0.1 || contextPressureThreshold > 0.99) {
      setOrchestratorError("Context pressure threshold must be between 0.1 and 0.99.");
      return;
    }
    if (!Number.isFinite(interventionConfidenceThreshold) || interventionConfidenceThreshold < 0 || interventionConfidenceThreshold > 1) {
      setOrchestratorError("Intervention confidence threshold must be between 0.0 and 1.0.");
      return;
    }

    setOrchestratorBusy(true);
    try {
      const snapshot = configSnapshot ?? (await window.ade.projectConfig.get());
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
      const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
      const maxTotalTokenBudget = Number(orchestratorDraft.maxTotalTokenBudget);
      const maxPerStepTokenBudget = Number(orchestratorDraft.maxPerStepTokenBudget);

      // Build task routing
      const nextTaskRouting: Record<string, { provider?: string; model?: string }> = {};
      for (const key of TASK_ROUTING_KEYS) {
        const entry = taskRoutingDraft[key];
        if (entry.provider !== "auto" || entry.model.length > 0) {
          nextTaskRouting[key] = {};
          if (entry.provider !== "auto") nextTaskRouting[key].provider = entry.provider;
          if (entry.model.length > 0) nextTaskRouting[key].model = entry.model;
        }
      }

      const nextOrchestrator = {
        ...localOrchestrator,
        requirePlanReview: orchestratorDraft.requirePlanReview,
        maxParallelWorkers: Math.floor(maxParallelWorkers),
        maxRetriesPerStep: Math.floor(maxRetriesPerStep),
        contextPressureThreshold,
        progressiveLoading: orchestratorDraft.progressiveLoading,
        defaultMergePolicy: orchestratorDraft.defaultMergePolicy,
        defaultConflictHandoff: orchestratorDraft.defaultConflictHandoff,
        maxTotalTokenBudget: Number.isFinite(maxTotalTokenBudget) && maxTotalTokenBudget >= 0 ? maxTotalTokenBudget : 0,
        maxPerStepTokenBudget: Number.isFinite(maxPerStepTokenBudget) && maxPerStepTokenBudget >= 0 ? maxPerStepTokenBudget : 0,
        autoResolveInterventions: orchestratorDraft.autoResolveInterventions,
        interventionConfidenceThreshold,
        defaultDepthTier,
        defaultPlannerProvider
      };
      // Build worker permissions
      const nextPermissions: Record<string, Record<string, unknown>> = {};
      const claudePerms: Record<string, unknown> = {};
      if (workerPermDraft.claudePermissionMode && workerPermDraft.claudePermissionMode !== "acceptEdits") {
        claudePerms.permissionMode = workerPermDraft.claudePermissionMode;
      }
      if (workerPermDraft.claudeDangerouslySkip) {
        claudePerms.dangerouslySkipPermissions = true;
      }
      if (Object.keys(claudePerms).length) nextPermissions.claude = claudePerms;

      const codexPerms: Record<string, unknown> = {};
      if (workerPermDraft.codexSandboxPermissions && workerPermDraft.codexSandboxPermissions !== "workspace-write") {
        codexPerms.sandboxPermissions = workerPermDraft.codexSandboxPermissions;
      }
      if (workerPermDraft.codexApprovalMode && workerPermDraft.codexApprovalMode !== "full-auto") {
        codexPerms.approvalMode = workerPermDraft.codexApprovalMode;
      }
      if (workerPermDraft.codexConfigPath.trim().length > 0) {
        codexPerms.configPath = workerPermDraft.codexConfigPath.trim();
      }
      if (Object.keys(codexPerms).length) nextPermissions.codex = codexPerms;

      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          ai: {
            ...(snapshot.local.ai ?? {}),
            ...localAi,
            orchestrator: nextOrchestrator,
            taskRouting: Object.keys(nextTaskRouting).length > 0 ? nextTaskRouting : undefined,
            permissions: Object.keys(nextPermissions).length > 0 ? nextPermissions : undefined
          }
        }
      });
      await refreshOrchestratorDraft();
      setOrchestratorNotice("Settings saved to .ade/local.yaml.");
    } catch (error) {
      setOrchestratorError(error instanceof Error ? error.message : String(error));
    } finally {
      setOrchestratorBusy(false);
    }
  };

  if (loadError) {
    return <EmptyState title="General" description={`Failed to load: ${loadError}`} />;
  }

  if (!info) {
    return <EmptyState title="General" description="Loading..." />;
  }

  const inputClass = "mt-1 h-8 w-full rounded border border-border/15 bg-surface-recessed px-2 text-sm text-fg placeholder:text-muted-fg/50";
  const selectClass = inputClass;

  return (
    <div className="space-y-6">
      {orchestratorNotice ? (
        <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{orchestratorNotice}</div>
      ) : null}
      {orchestratorError ? (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{orchestratorError}</div>
      ) : null}
      <div>
        <div className="text-sm font-semibold text-fg">Theme</div>
        <div className="mt-2 flex gap-3">
          {THEME_IDS.map((id) => (
            <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4">
          <div className="text-xs text-muted-fg">App</div>
          <div className="mt-1 text-sm font-medium">v{info.appVersion}</div>
          <div className="mt-1 text-xs text-muted-fg">{info.isPackaged ? "packaged" : "dev"}</div>
        </div>

        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4">
          <div className="text-xs text-muted-fg">Runtime</div>
          <div className="mt-1 text-sm">
            {info.platform} / {info.arch}
          </div>
          <div className="mt-1 text-xs text-muted-fg">
            node {info.versions.node} · electron {info.versions.electron}
          </div>
        </div>

        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
          <div className="text-xs text-muted-fg">Provider Mode</div>
          <div className="mt-2 text-sm">{providerMode}</div>
          <div className="mt-2 text-xs text-muted-fg">
            For API key and CLI provider configuration, see the <span className="text-accent">Providers</span> section in the sidebar.
          </div>
        </div>

        {/* Mission Defaults */}
        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
          <div className="text-xs text-muted-fg">Mission Defaults</div>
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Default depth tier</div>
              <select
                className={selectClass}
                value={defaultDepthTier}
                onChange={(e) => setDefaultDepthTier(e.target.value as DepthTier)}
              >
                <option value="light">Light</option>
                <option value="standard">Standard</option>
                <option value="deep">Deep</option>
              </select>
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Default planner provider</div>
              <select
                className={selectClass}
                value={defaultPlannerProvider}
                onChange={(e) => setDefaultPlannerProvider(e.target.value as PlannerProvider)}
              >
                <option value="auto">Auto</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm pt-4">
              <input
                type="checkbox"
                checked={orchestratorDraft.requirePlanReview}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    requirePlanReview: e.target.checked
                  }))
                }
              />
              Require plan review
            </label>
          </div>
        </div>

        {/* Model Preferences (Task Routing) */}
        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
          <div className="text-xs text-muted-fg">Model Preferences</div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-fg">
                  <th className="pb-2 text-left font-medium">Task Type</th>
                  <th className="pb-2 text-left font-medium">Provider</th>
                  <th className="pb-2 text-left font-medium">Model (optional)</th>
                </tr>
              </thead>
              <tbody>
                {TASK_ROUTING_KEYS.map((key) => (
                  <tr key={key} className="border-t border-border/10">
                    <td className="py-2 pr-3 text-sm">{TASK_ROUTING_LABELS[key] ?? key}</td>
                    <td className="py-2 pr-3">
                      <select
                        className="h-7 w-full rounded border border-border/15 bg-surface-recessed px-1.5 text-sm text-fg"
                        value={taskRoutingDraft[key]?.provider ?? "auto"}
                        onChange={(e) =>
                          setTaskRoutingDraft((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], provider: e.target.value as AiTaskProvider }
                          }))
                        }
                      >
                        <option value="auto">Auto</option>
                        <option value="claude">Claude</option>
                        <option value="codex">Codex</option>
                      </select>
                    </td>
                    <td className="py-2">
                      <input
                        type="text"
                        className="h-7 w-full rounded border border-border/15 bg-surface-recessed px-1.5 text-sm text-fg placeholder:text-muted-fg/50"
                        placeholder="e.g. claude-sonnet-4-6"
                        value={taskRoutingDraft[key]?.model ?? ""}
                        onChange={(e) =>
                          setTaskRoutingDraft((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], model: e.target.value }
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Orchestrator Settings */}
        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
          <div className="text-xs text-muted-fg">Orchestrator Settings</div>
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Max parallel workers</div>
              <input
                type="number"
                min={1}
                max={10}
                className={inputClass}
                value={orchestratorDraft.maxParallelWorkers}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxParallelWorkers: e.target.value
                  }))
                }
              />
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Max total token budget (0 = unlimited)</div>
              <input
                type="number"
                min={0}
                step={10000}
                className={inputClass}
                value={orchestratorDraft.maxTotalTokenBudget}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxTotalTokenBudget: e.target.value
                  }))
                }
              />
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Max retries per step</div>
              <input
                type="number"
                min={0}
                max={8}
                className={inputClass}
                value={orchestratorDraft.maxRetriesPerStep}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxRetriesPerStep: e.target.value
                  }))
                }
              />
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Max per-step token budget (0 = unlimited)</div>
              <input
                type="number"
                min={0}
                step={10000}
                className={inputClass}
                value={orchestratorDraft.maxPerStepTokenBudget}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxPerStepTokenBudget: e.target.value
                  }))
                }
              />
            </label>
            <label className="text-sm md:col-span-2">
              <div className="text-xs text-muted-fg">Context pressure threshold</div>
              <input
                type="number"
                min={0.1}
                max={0.99}
                step={0.01}
                className={cn(inputClass, "md:w-56")}
                value={orchestratorDraft.contextPressureThreshold}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    contextPressureThreshold: e.target.value
                  }))
                }
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orchestratorDraft.progressiveLoading}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    progressiveLoading: e.target.checked
                  }))
                }
              />
              Progressive context loading
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orchestratorDraft.autoResolveInterventions}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    autoResolveInterventions: e.target.checked
                  }))
                }
              />
              Auto-resolve interventions
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Intervention confidence threshold (0.0 - 1.0)</div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                className="mt-1 w-full"
                value={orchestratorDraft.interventionConfidenceThreshold}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    interventionConfidenceThreshold: e.target.value
                  }))
                }
              />
              <div className="mt-0.5 text-xs text-muted-fg">{orchestratorDraft.interventionConfidenceThreshold}</div>
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Default merge policy</div>
              <select
                className={selectClass}
                value={orchestratorDraft.defaultMergePolicy}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    defaultMergePolicy: e.target.value as "sequential" | "batch-at-end" | "per-step"
                  }))
                }
              >
                <option value="sequential">Sequential</option>
                <option value="batch-at-end">Batch at end</option>
                <option value="per-step">Per step</option>
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              <div className="text-xs text-muted-fg">Default conflict handoff</div>
              <select
                className={cn(selectClass, "md:w-56")}
                value={orchestratorDraft.defaultConflictHandoff}
                onChange={(e) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    defaultConflictHandoff: e.target.value as "auto-resolve" | "ask-user" | "orchestrator-decides"
                  }))
                }
              >
                <option value="auto-resolve">Auto-resolve</option>
                <option value="ask-user">Ask user</option>
                <option value="orchestrator-decides">Orchestrator decides</option>
              </select>
            </label>
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={() => void saveAllSettings()} disabled={orchestratorBusy}>
              {orchestratorBusy ? "Saving..." : "Save all settings"}
            </Button>
          </div>
        </div>

        {/* Worker Permissions */}
        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
          <div className="text-xs text-muted-fg">Worker Permissions</div>
          <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Claude worker permissions */}
            <div className="space-y-2">
              <div className="text-xs font-semibold">Claude Worker</div>
              <label className="text-sm">
                <div className="text-xs text-muted-fg">Permission mode</div>
                <select
                  className={selectClass}
                  value={workerPermDraft.claudePermissionMode}
                  disabled={workerPermDraft.claudeDangerouslySkip}
                  onChange={(e) =>
                    setWorkerPermDraft((prev) => ({ ...prev, claudePermissionMode: e.target.value }))
                  }
                >
                  <option value="plan">Plan (read-only)</option>
                  <option value="acceptEdits">Accept edits</option>
                  <option value="bypassPermissions">Bypass permissions</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={workerPermDraft.claudeDangerouslySkip}
                  onChange={(e) =>
                    setWorkerPermDraft((prev) => ({ ...prev, claudeDangerouslySkip: e.target.checked }))
                  }
                />
                Dangerously skip permissions
              </label>
              {workerPermDraft.claudeDangerouslySkip ? (
                <div className="rounded-lg bg-amber-500/10 px-2 py-1 text-xs text-amber-400">
                  Warning: This disables all permission checks for Claude workers. Use with caution.
                </div>
              ) : null}
              <div className="text-xs text-muted-fg">
                Claude workers will also read CLAUDE.md and .claude/settings.json from your project root.
              </div>
            </div>

            {/* Codex worker permissions */}
            <div className="space-y-2">
              <div className="text-xs font-semibold">Codex Worker</div>
              <label className="text-sm">
                <div className="text-xs text-muted-fg">Sandbox mode</div>
                <select
                  className={selectClass}
                  value={workerPermDraft.codexSandboxPermissions}
                  onChange={(e) =>
                    setWorkerPermDraft((prev) => ({ ...prev, codexSandboxPermissions: e.target.value }))
                  }
                >
                  <option value="read-only">Read-only</option>
                  <option value="workspace-write">Workspace write</option>
                  <option value="danger-full-access">Full access (dangerous)</option>
                </select>
              </label>
              <label className="text-sm">
                <div className="text-xs text-muted-fg">Approval mode</div>
                <select
                  className={selectClass}
                  value={workerPermDraft.codexApprovalMode}
                  onChange={(e) =>
                    setWorkerPermDraft((prev) => ({ ...prev, codexApprovalMode: e.target.value }))
                  }
                >
                  <option value="suggest">Suggest</option>
                  <option value="auto-edit">Auto-edit</option>
                  <option value="full-auto">Full auto</option>
                </select>
              </label>
              <label className="text-sm">
                <div className="text-xs text-muted-fg">Config TOML path</div>
                <input
                  type="text"
                  className={inputClass}
                  placeholder="Leave blank to use default Codex configuration"
                  value={workerPermDraft.codexConfigPath}
                  onChange={(e) =>
                    setWorkerPermDraft((prev) => ({ ...prev, codexConfigPath: e.target.value }))
                  }
                />
              </label>
              <div className="text-xs text-muted-fg">
                Leave blank to use default Codex configuration.
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
          <div className="text-xs text-muted-fg">Env</div>
          <div className="mt-2 grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
            <div>
              <div className="text-xs text-muted-fg">NODE_ENV</div>
              <div>{info.env.nodeEnv ?? "(unset)"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-fg">VITE_DEV_SERVER_URL</div>
              <div className="truncate">{info.env.viteDevServerUrl ?? "(unset)"}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
