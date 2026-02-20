import React, { useEffect, useState } from "react";
import type { AppInfo, ProjectConfigSnapshot } from "../../../shared/types";
import { useAppStore, ThemeId, THEME_IDS } from "../../state/appStore";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";

const THEME_META: Record<
  ThemeId,
  { label: string; colors: { bg: string; fg: string; card: string; muted: string; border: string; accent: string; accentSecondary: string } }
> = {
  "e-paper": {
    label: "E-Paper",
    colors: {
      bg: "#fdfbf7",
      fg: "#201a14",
      card: "#fdfbf7",
      muted: "#efe8dd",
      border: "#d3cfc6",
      accent: "#c22323",
      accentSecondary: "#ddd1be"
    }
  },
  bloomberg: {
    label: "Bloomberg",
    colors: {
      bg: "#0a0a0a",
      fg: "#ffc87a",
      card: "#16110a",
      muted: "#1f180f",
      border: "#403121",
      accent: "#ff7a00",
      accentSecondary: "#4f3c1f"
    }
  },
  github: {
    label: "GitHub",
    colors: {
      bg: "#0d1117",
      fg: "#c9d1d9",
      card: "#111b2c",
      muted: "#1d2a3a",
      border: "#2f3b49",
      accent: "#58a6ff",
      accentSecondary: "#1f6feb"
    }
  },
  rainbow: {
    label: "Rainbow",
    colors: {
      bg: "#1b1f23",
      fg: "#e6edf3",
      card: "#222737",
      muted: "#2a3342",
      border: "#525e72",
      accent: "#fb7185",
      accentSecondary: "#c084fc"
    }
  },
  sky: {
    label: "Sky",
    colors: {
      bg: "#f0f6ff",
      fg: "#1e3a8a",
      card: "#f7faff",
      muted: "#dbeafe",
      border: "#b7d5ff",
      accent: "#2563eb",
      accentSecondary: "#14b8a6"
    }
  },
  pats: {
    label: "Pats",
    colors: {
      bg: "#001a36",
      fg: "#edf4ff",
      card: "#001a34",
      muted: "#163f66",
      border: "#c60c30",
      accent: "#c60c30",
      accentSecondary: "#0d426b"
    }
  }
};

function ThemeSwatch({ themeId, selected, onClick }: { themeId: ThemeId; selected: boolean; onClick: () => void }) {
  const { label, colors } = THEME_META[themeId];
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center gap-1.5 rounded-lg p-2 transition-all",
        "hover:bg-muted/40",
        selected && "ring-2 ring-accent ring-offset-1"
      )}
      style={{ "--tw-ring-offset-color": "var(--color-bg)" } as React.CSSProperties}
      title={label}
    >
      <div
        className="h-12 w-12 rounded-md border overflow-hidden"
        style={{ backgroundColor: colors.bg, borderColor: colors.border }}
      >
        <div className="h-2 w-full" style={{ backgroundColor: colors.card }} />
        <div className="mx-auto mt-1 h-1.5 w-8 rounded-full" style={{ backgroundColor: colors.accent }} />
        <div className="mx-auto mt-1 h-1.5 w-8 rounded-full" style={{ backgroundColor: colors.accentSecondary }} />
        <div className="mx-1 mt-1 space-y-0.5">
          <div className="h-0.5 w-6 rounded-full" style={{ backgroundColor: colors.fg, opacity: 0.6 }} />
          <div className="h-0.5 w-4 rounded-full" style={{ backgroundColor: colors.muted, opacity: 0.75 }} />
          <div className="h-0.5 w-5 rounded-full" style={{ backgroundColor: colors.muted, opacity: 0.55 }} />
        </div>
      </div>
      <span className="text-[10px] font-medium leading-none">{label}</span>
      {selected && (
        <div className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-fg text-[8px] font-bold">
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

export function GeneralSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<ProjectConfigSnapshot | null>(null);
  const [orchestratorDraft, setOrchestratorDraft] = useState({
    requirePlanReview: false,
    maxParallelWorkers: "4",
    maxRetriesPerStep: "2",
    contextPressureThreshold: "0.8",
    progressiveLoading: true,
    defaultMergePolicy: "sequential" as "sequential" | "batch-at-end" | "per-step",
    defaultConflictHandoff: "ask-user" as "auto-resolve" | "ask-user" | "orchestrator-decides",
    maxTotalBudgetUsd: "0",
    maxPerStepBudgetUsd: "0"
  });
  const [orchestratorBusy, setOrchestratorBusy] = useState(false);
  const [orchestratorError, setOrchestratorError] = useState<string | null>(null);
  const [orchestratorNotice, setOrchestratorNotice] = useState<string | null>(null);
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
    const readString = (primary: unknown, fallback: unknown, defaultValue: string): string => {
      if (typeof primary === "string" && primary.length > 0) return primary;
      if (typeof fallback === "string" && fallback.length > 0) return fallback;
      return defaultValue;
    };
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
      maxTotalBudgetUsd: String(Math.max(0, readNumber(localOrchestrator.maxTotalBudgetUsd, effectiveOrchestrator.maxTotalBudgetUsd, 0))),
      maxPerStepBudgetUsd: String(Math.max(0, readNumber(localOrchestrator.maxPerStepBudgetUsd, effectiveOrchestrator.maxPerStepBudgetUsd, 0)))
    });
  }, []);

  useEffect(() => {
    void refreshOrchestratorDraft().catch((error) => {
      setOrchestratorError(error instanceof Error ? error.message : String(error));
    });
  }, [refreshOrchestratorDraft]);

  const saveOrchestratorSettings = async () => {
    setOrchestratorError(null);
    setOrchestratorNotice(null);
    const maxParallelWorkers = Number(orchestratorDraft.maxParallelWorkers);
    const maxRetriesPerStep = Number(orchestratorDraft.maxRetriesPerStep);
    const contextPressureThreshold = Number(orchestratorDraft.contextPressureThreshold);
    if (!Number.isFinite(maxParallelWorkers) || maxParallelWorkers < 1 || maxParallelWorkers > 16) {
      setOrchestratorError("Max parallel workers must be between 1 and 16.");
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

    setOrchestratorBusy(true);
    try {
      const snapshot = configSnapshot ?? (await window.ade.projectConfig.get());
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
      const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
      const maxTotalBudgetUsd = Number(orchestratorDraft.maxTotalBudgetUsd);
      const maxPerStepBudgetUsd = Number(orchestratorDraft.maxPerStepBudgetUsd);
      const nextOrchestrator = {
        ...localOrchestrator,
        requirePlanReview: orchestratorDraft.requirePlanReview,
        maxParallelWorkers: Math.floor(maxParallelWorkers),
        maxRetriesPerStep: Math.floor(maxRetriesPerStep),
        contextPressureThreshold,
        progressiveLoading: orchestratorDraft.progressiveLoading,
        defaultMergePolicy: orchestratorDraft.defaultMergePolicy,
        defaultConflictHandoff: orchestratorDraft.defaultConflictHandoff,
        maxTotalBudgetUsd: Number.isFinite(maxTotalBudgetUsd) && maxTotalBudgetUsd >= 0 ? maxTotalBudgetUsd : 0,
        maxPerStepBudgetUsd: Number.isFinite(maxPerStepBudgetUsd) && maxPerStepBudgetUsd >= 0 ? maxPerStepBudgetUsd : 0
      };
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          ai: {
            ...(snapshot.local.ai ?? {}),
            ...localAi,
            orchestrator: nextOrchestrator
          }
        }
      });
      await refreshOrchestratorDraft();
      setOrchestratorNotice("Orchestrator settings saved to .ade/local.yaml.");
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

  return (
    <div className="space-y-6">
      {orchestratorNotice ? (
        <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{orchestratorNotice}</div>
      ) : null}
      {orchestratorError ? (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{orchestratorError}</div>
      ) : null}
      <div>
        <div className="text-sm font-semibold">Theme</div>
        <div className="mt-2 flex flex-wrap gap-1">
          {THEME_IDS.map((id) => (
            <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card/70 p-3">
          <div className="text-xs text-muted-fg">App</div>
          <div className="mt-1 text-sm font-medium">v{info.appVersion}</div>
          <div className="mt-1 text-xs text-muted-fg">{info.isPackaged ? "packaged" : "dev"}</div>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-3">
          <div className="text-xs text-muted-fg">Runtime</div>
          <div className="mt-1 text-sm">
            {info.platform} / {info.arch}
          </div>
          <div className="mt-1 text-xs text-muted-fg">
            node {info.versions.node} · electron {info.versions.electron}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
          <div className="text-xs text-muted-fg">Provider Mode</div>
          <div className="mt-2 text-sm">{providerMode}</div>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
          <div className="text-xs text-muted-fg">AI Orchestrator</div>
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orchestratorDraft.requirePlanReview}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    requirePlanReview: event.target.checked
                  }))
                }
              />
              Require plan review before execution
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orchestratorDraft.progressiveLoading}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    progressiveLoading: event.target.checked
                  }))
                }
              />
              Progressive context loading
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Max parallel workers</div>
              <input
                type="number"
                min={1}
                max={16}
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
                value={orchestratorDraft.maxParallelWorkers}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxParallelWorkers: event.target.value
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
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
                value={orchestratorDraft.maxRetriesPerStep}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxRetriesPerStep: event.target.value
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
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm md:w-56"
                value={orchestratorDraft.contextPressureThreshold}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    contextPressureThreshold: event.target.value
                  }))
                }
              />
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Default merge policy</div>
              <select
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
                value={orchestratorDraft.defaultMergePolicy}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    defaultMergePolicy: event.target.value as "sequential" | "batch-at-end" | "per-step"
                  }))
                }
              >
                <option value="sequential">Sequential</option>
                <option value="batch-at-end">Batch at end</option>
                <option value="per-step">Per step</option>
              </select>
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Default conflict handoff</div>
              <select
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
                value={orchestratorDraft.defaultConflictHandoff}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    defaultConflictHandoff: event.target.value as "auto-resolve" | "ask-user" | "orchestrator-decides"
                  }))
                }
              >
                <option value="auto-resolve">Auto-resolve</option>
                <option value="ask-user">Ask user</option>
                <option value="orchestrator-decides">Orchestrator decides</option>
              </select>
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Max total budget (USD, 0 = unlimited)</div>
              <input
                type="number"
                min={0}
                step={0.5}
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
                value={orchestratorDraft.maxTotalBudgetUsd}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxTotalBudgetUsd: event.target.value
                  }))
                }
              />
            </label>
            <label className="text-sm">
              <div className="text-xs text-muted-fg">Max per-step budget (USD, 0 = unlimited)</div>
              <input
                type="number"
                min={0}
                step={0.5}
                className="mt-1 h-8 w-full rounded border border-border bg-bg px-2 text-sm"
                value={orchestratorDraft.maxPerStepBudgetUsd}
                onChange={(event) =>
                  setOrchestratorDraft((prev) => ({
                    ...prev,
                    maxPerStepBudgetUsd: event.target.value
                  }))
                }
              />
            </label>
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={() => void saveOrchestratorSettings()} disabled={orchestratorBusy}>
              {orchestratorBusy ? "Saving..." : "Save orchestrator settings"}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
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
