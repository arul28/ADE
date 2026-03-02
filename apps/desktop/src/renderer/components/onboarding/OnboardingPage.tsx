import React from "react";
import { useNavigate } from "react-router-dom";
import { WarningCircle, CheckCircle, GitBranch, Package, Sparkle, MagicWand } from "@phosphor-icons/react";
import type {
  ConfigAutomationRule,
  ConfigStackButtonDefinition,
  LaneSummary,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  ProjectConfigFile,
  ProjectConfigSnapshot
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { formatDate } from "../../lib/format";
import { quoteShellArg, commandArrayToLine, parseCommandLine } from "../../lib/shell";

type StepId =
  | "welcome"
  | "detect-defaults"
  | "review-config"
  | "configure-ai"
  | "detect-branches"
  | "import-branches"
  | "generate-packs"
  | "complete";

type DraftRow = {
  enabled: boolean;
  id: string;
  name: string;
  cwd: string;
  commandLine: string;
};

type StackDraftRow = ConfigStackButtonDefinition & { include: boolean };

type AutomationDraftRow = ConfigAutomationRule & { include: boolean };

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = item.id.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function previewLines(title: string, bullets: string[]) {
  return (
    <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-3 text-xs">
      <div className="flex items-center gap-2 font-semibold text-fg">
        <MagicWand size={16} weight="regular" className="text-muted-fg" />
        {title}
      </div>
      <ul className="mt-2 space-y-1 text-muted-fg">
        {bullets.map((b) => (
          <li key={b} className="flex gap-2">
            <span className="text-muted-fg">•</span>
            <span className="min-w-0">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function stepMeta(id: StepId): { title: string; subtitle: string } {
  if (id === "welcome") {
    return { title: "Welcome", subtitle: "A quick tour + safe setup" };
  }
  if (id === "detect-defaults") {
    return { title: "Detect Defaults", subtitle: "Scan repo for likely commands" };
  }
  if (id === "review-config") {
    return { title: "Review Config", subtitle: "Edit what gets written to .ade/ade.yaml" };
  }
  if (id === "configure-ai") {
    return { title: "Configure AI", subtitle: "Set up AI providers and features" };
  }
  if (id === "detect-branches") {
    return { title: "Detect Branches", subtitle: "Find existing branches to import as lanes" };
  }
  if (id === "import-branches") {
    return { title: "Import Branches", subtitle: "Create worktrees for selected branches" };
  }
  if (id === "generate-packs") {
    return { title: "Generate Packs", subtitle: "Create initial context + conflict packs" };
  }
  return { title: "Complete", subtitle: "Finish onboarding" };
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [step, setStep] = React.useState<StepId>("welcome");
  const [statusCompletedAt, setStatusCompletedAt] = React.useState<string | null>(null);
  const [skipBusy, setSkipBusy] = React.useState(false);

  const [defaultsBusy, setDefaultsBusy] = React.useState(false);
  const [defaultsError, setDefaultsError] = React.useState<string | null>(null);
  const [defaults, setDefaults] = React.useState<OnboardingDetectionResult | null>(null);

  const [configSnapshot, setConfigSnapshot] = React.useState<ProjectConfigSnapshot | null>(null);
  const [configBusy, setConfigBusy] = React.useState(false);
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [applyMode, setApplyMode] = React.useState<"append" | "replace">("append");
  const [configAppliedAt, setConfigAppliedAt] = React.useState<string | null>(null);

  const [processDraft, setProcessDraft] = React.useState<DraftRow[]>([]);
  const [testDraft, setTestDraft] = React.useState<DraftRow[]>([]);
  const [stackDraft, setStackDraft] = React.useState<StackDraftRow[]>([]);
  const [automationDraft, setAutomationDraft] = React.useState<AutomationDraftRow[]>([]);

  const [branchesBusy, setBranchesBusy] = React.useState(false);
  const [branchesError, setBranchesError] = React.useState<string | null>(null);
  const [branches, setBranches] = React.useState<OnboardingExistingLaneCandidate[]>([]);
  const [branchQuery, setBranchQuery] = React.useState("");
  const [selectedBranches, setSelectedBranches] = React.useState<Set<string>>(new Set());
  const [importParentLaneId, setImportParentLaneId] = React.useState<string>("__primary__");

  const [importBusy, setImportBusy] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);
  const [importResults, setImportResults] = React.useState<
    Record<string, { status: "pending" | "imported" | "skipped" | "failed"; lane?: LaneSummary; error?: string }>
  >({});

  const [packsBusy, setPacksBusy] = React.useState(false);
  const [packsError, setPacksError] = React.useState<string | null>(null);
  const [packsDoneAt, setPacksDoneAt] = React.useState<string | null>(null);

  const [aiStatus, setAiStatus] = React.useState<import("../../../shared/types").AiSettingsStatus | null>(null);
  const [aiToggles, setAiToggles] = React.useState<Record<string, boolean>>({
    terminal_summaries: true,
    pr_descriptions: true,
    narratives: true,
    conflict_proposals: true,
    mission_planning: true,
    orchestrator: true,
    initial_context: true,
  });
  const [aiSaving, setAiSaving] = React.useState(false);

  const primaryLane = React.useMemo(() => lanes.find((lane) => lane.laneType === "primary") ?? null, [lanes]);

  const selectedParentLaneId = React.useMemo(() => {
    if (importParentLaneId === "__none__") return null;
    if (importParentLaneId === "__primary__") return primaryLane?.id ?? null;
    return importParentLaneId.trim() || null;
  }, [importParentLaneId, primaryLane?.id]);

  const refreshStatus = React.useCallback(async () => {
    const next = await window.ade.onboarding.getStatus();
    setStatusCompletedAt(next.completedAt);
  }, []);

  const refreshConfigSnapshot = React.useCallback(async () => {
    const snap = await window.ade.projectConfig.get();
    setConfigSnapshot(snap);
  }, []);

  React.useEffect(() => {
    void refreshStatus().catch(() => {});
    void refreshConfigSnapshot().catch(() => {});
  }, [refreshStatus, refreshConfigSnapshot]);

  React.useEffect(() => {
    if (step === "configure-ai") {
      window.ade.ai.getStatus().then(setAiStatus).catch(() => {});
    }
  }, [step]);

  const steps: StepId[] = React.useMemo(
    () => ["welcome", "detect-defaults", "review-config", "configure-ai", "detect-branches", "import-branches", "generate-packs", "complete"],
    []
  );

  const stepIndex = steps.indexOf(step);
  const canGoBack = stepIndex > 0;
  const showStepsSidebar = step !== "welcome";

  const goNext = () => {
    const next = steps[stepIndex + 1];
    if (next) setStep(next);
  };

  const goPrev = () => {
    const prev = steps[stepIndex - 1];
    if (prev) setStep(prev);
  };

  const skipOnboarding = React.useCallback(async () => {
    setSkipBusy(true);
    try {
      const next = await window.ade.onboarding.complete();
      setStatusCompletedAt(next.completedAt);
      navigate("/lanes", { replace: true });
    } finally {
      setSkipBusy(false);
    }
  }, [navigate]);

  const runDetectDefaults = async () => {
    setDefaultsBusy(true);
    setDefaultsError(null);
    try {
      const res = await window.ade.onboarding.detectDefaults();
      setDefaults(res);
      // Initialize config drafts from suggested config (user can still change later).
      const cfg = res.suggestedConfig;
      setProcessDraft(
        (cfg.processes ?? []).map((p) => ({
          enabled: true,
          id: p.id,
          name: p.name ?? p.id,
          cwd: p.cwd ?? ".",
          commandLine: commandArrayToLine(p.command ?? [])
        }))
      );
      setTestDraft(
        (cfg.testSuites ?? []).map((t) => ({
          enabled: true,
          id: t.id,
          name: t.name ?? t.id,
          cwd: t.cwd ?? ".",
          commandLine: commandArrayToLine(t.command ?? [])
        }))
      );
      setStackDraft(
        (cfg.stackButtons ?? []).map((s) => ({
          include: true,
          id: s.id,
          name: s.name ?? s.id,
          processIds: s.processIds ?? [],
          startOrder: s.startOrder ?? "parallel"
        }))
      );
      setAutomationDraft(
        (cfg.automations ?? []).map((r) => ({
          include: true,
          id: r.id,
          name: r.name ?? r.id,
          enabled: r.enabled ?? true,
          trigger: r.trigger ?? { type: "manual" },
          actions: r.actions ?? []
        }))
      );
    } catch (err) {
      setDefaultsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDefaultsBusy(false);
    }
  };

  const applyConfig = async () => {
    if (!defaults) return;
    setConfigBusy(true);
    setConfigError(null);
    try {
      const snap = await window.ade.projectConfig.get();
      const shared = snap.shared;

      const enabledProcesses = processDraft
        .filter((p) => p.enabled)
        .map((p) => ({
          id: p.id.trim(),
          name: p.name.trim(),
          cwd: p.cwd.trim() || ".",
          command: parseCommandLine(p.commandLine),
          env: {},
          autostart: false,
          restart: "never" as const
        }))
        .filter((p) => p.id.length > 0);

      const enabledTests = testDraft
        .filter((t) => t.enabled)
        .map((t) => ({
          id: t.id.trim(),
          name: t.name.trim(),
          cwd: t.cwd.trim() || ".",
          command: parseCommandLine(t.commandLine),
          env: {},
          tags: ["custom" as const]
        }))
        .filter((t) => t.id.length > 0);

      const enabledStacks = stackDraft
        .filter((s) => s.include)
        .map((s) => ({
          id: (s.id ?? "").trim(),
          name: ((s.name ?? s.id) ?? "").trim(),
          processIds: (s.processIds ?? []).map((id) => id.trim()).filter(Boolean),
          startOrder: (s.startOrder === "dependency" ? "dependency" : "parallel") as "parallel" | "dependency"
        }))
        .filter((s) => s.id.length > 0);

      const enabledAutomations = automationDraft
        .filter((r) => r.include)
        .map((r) => ({
          id: (r.id ?? "").trim(),
          name: ((r.name ?? r.id) ?? "").trim(),
          enabled: Boolean(r.enabled),
          trigger: r.trigger,
          actions: r.actions
        }))
        .filter((r) => r.id.length > 0);

      const nextShared: ProjectConfigFile =
        applyMode === "replace"
          ? {
              ...shared,
              processes: uniqueById(enabledProcesses),
              testSuites: uniqueById(enabledTests),
              stackButtons: uniqueById(enabledStacks),
              automations: uniqueById(enabledAutomations)
            }
          : {
              ...shared,
              processes: uniqueById([...(shared.processes ?? []), ...enabledProcesses]),
              testSuites: uniqueById([...(shared.testSuites ?? []), ...enabledTests]),
              stackButtons: uniqueById([...(shared.stackButtons ?? []), ...enabledStacks]),
              automations: uniqueById([...(shared.automations ?? []), ...enabledAutomations])
            };

      await window.ade.projectConfig.save({
        shared: nextShared,
        local: snap.local
      });

      const now = new Date().toISOString();
      setConfigAppliedAt(now);
      await refreshConfigSnapshot();
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfigBusy(false);
    }
  };

  const runDetectBranches = async () => {
    setBranchesBusy(true);
    setBranchesError(null);
    try {
      const res = await window.ade.onboarding.detectExistingLanes();
      setBranches(res);
      // Default selection: branches that are ahead (likely active work).
      const nextSelected = new Set(res.filter((b) => b.ahead > 0).slice(0, 40).map((b) => b.branchRef));
      setSelectedBranches(nextSelected);
    } catch (err) {
      setBranchesError(err instanceof Error ? err.message : String(err));
    } finally {
      setBranchesBusy(false);
    }
  };

  const visibleBranches = React.useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    const list = [...branches];
    if (!q) return list;
    return list.filter((b) => b.branchRef.toLowerCase().includes(q));
  }, [branches, branchQuery]);

  const importSelected = async () => {
    const branchRefs = Array.from(selectedBranches);
    if (branchRefs.length === 0) return;

    setImportBusy(true);
    setImportError(null);
    setImportResults((prev) => {
      const next = { ...prev };
      for (const ref of branchRefs) {
        next[ref] = { status: "pending" };
      }
      return next;
    });

    try {
      const results: Record<string, { status: "pending" | "imported" | "skipped" | "failed"; lane?: LaneSummary; error?: string }> = {};
      for (const branchRef of branchRefs) {
        try {
          const lane = await window.ade.lanes.importBranch({
            branchRef,
            name: branchRef,
            parentLaneId: selectedParentLaneId
          });
          results[branchRef] = { status: "imported", lane };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/already exists for branch/i.test(message) || /Lane already exists/i.test(message)) {
            results[branchRef] = { status: "skipped", error: message };
          } else if (/rev-parse|verify|Needed a single revision|unknown revision|not a valid/i.test(message)) {
            results[branchRef] = { status: "failed", error: `Branch not found or invalid: ${message}` };
          } else {
            results[branchRef] = { status: "failed", error: message };
          }
        }

        setImportResults((prev) => ({ ...prev, [branchRef]: results[branchRef]! }));
      }

      await refreshLanes();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportBusy(false);
    }
  };

  const generatePacks = async () => {
    setPacksBusy(true);
    setPacksError(null);
    try {
      const importedLaneIds = Object.values(importResults)
        .map((r) => r.lane?.id ?? null)
        .filter((id): id is string => Boolean(id));
      await window.ade.onboarding.generateInitialPacks({ laneIds: importedLaneIds.length ? importedLaneIds : undefined });
      setPacksDoneAt(new Date().toISOString());
    } catch (err) {
      setPacksError(err instanceof Error ? err.message : String(err));
    } finally {
      setPacksBusy(false);
    }
  };

  const complete = async () => {
    setConfigError(null);
    try {
      const next = await window.ade.onboarding.complete();
      setStatusCompletedAt(next.completedAt);
      navigate("/project", { replace: true });
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    }
  };

  const heading = stepMeta(step);

  const configStats = React.useMemo(() => {
    const shared = configSnapshot?.shared;
    return {
      existingProcesses: shared?.processes?.length ?? 0,
      existingTests: shared?.testSuites?.length ?? 0,
      existingStacks: shared?.stackButtons?.length ?? 0,
      existingAutomations: shared?.automations?.length ?? 0,
      draftProcesses: processDraft.filter((p) => p.enabled).length,
      draftTests: testDraft.filter((t) => t.enabled).length,
      draftStacks: stackDraft.filter((s) => s.include).length,
      draftAutomations: automationDraft.filter((r) => r.include).length
    };
  }, [configSnapshot, processDraft, testDraft, stackDraft, automationDraft]);

  return (
    <div className="h-full min-h-0 overflow-auto bg-bg text-fg">
      <div className="mx-auto w-full max-w-6xl p-4">
        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold">Project onboarding</div>
              <div className="mt-1 text-xs text-muted-fg">
                {project?.displayName ?? project?.rootPath ?? "Project"} · status:{" "}
                {statusCompletedAt ? (
                  <span className="text-emerald-400">completed {formatDate(statusCompletedAt)}</span>
                ) : (
                  <span className="text-amber-300">incomplete</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {showStepsSidebar ? (
                <Chip>
                  Step {Math.max(1, stepIndex + 1)}/{steps.length}
                </Chip>
              ) : null}
              {!statusCompletedAt ? (
                <Button size="sm" variant="outline" disabled={skipBusy} onClick={() => void skipOnboarding()}>
                  {skipBusy ? "Skipping…" : "Skip for now"}
                </Button>
              ) : null}
              {statusCompletedAt ? (
                <Button size="sm" variant="outline" onClick={() => navigate("/project", { replace: true })}>
                  Go to Run
                </Button>
              ) : null}
            </div>
          </div>

          <div className={cn("mt-4 grid gap-3", showStepsSidebar ? "lg:grid-cols-[260px_1fr]" : "lg:grid-cols-1")}>
            {showStepsSidebar ? (
              <aside className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-2">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">Steps</div>
              <div className="mt-1 space-y-1">
                {steps.map((id, idx) => {
                  const meta = stepMeta(id);
                  const active = id === step;
                  const complete = idx < stepIndex;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={cn(
                        "w-full rounded-md border px-2 py-2 text-left text-xs transition-colors",
                        active ? "border-accent bg-accent/15 shadow-[0_0_16px_-4px_rgba(6,214,160,0.15)]" : "border-border/30 bg-card hover:bg-card/80"
                      )}
                      onClick={() => setStep(id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {complete ? (
                              <CheckCircle size={16} weight="regular" className="text-emerald-400" />
                            ) : active ? (
                              <Sparkle size={16} weight="regular" className="text-accent" />
                            ) : (
                              <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-card/80 border border-border/20 text-[10px] text-muted-fg">
                                {idx + 1}
                              </span>
                            )}
                            <span className="truncate font-semibold text-fg">{meta.title}</span>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-fg">{meta.subtitle}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              </aside>
            ) : null}

            <main className="min-w-0 space-y-3">
              <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-3">
                <div className="text-sm font-semibold">{heading.title}</div>
                <div className="mt-1 text-xs text-muted-fg">{heading.subtitle}</div>
              </div>

              {step === "welcome" ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-md border border-border/10 bg-card backdrop-blur-sm p-2">
                        <Sparkle size={20} weight="regular" className="text-accent" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">Start quickly</div>
                        <div className="mt-1 text-xs text-muted-fg">
                          Onboarding is optional. You can jump straight into Lanes and come back later to auto-detect commands, import branches as lanes, and generate initial packs.
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button size="sm" disabled={skipBusy} onClick={() => void skipOnboarding()}>
                            {skipBusy ? "Skipping…" : "Skip and start working"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => goNext()}>
                            Guided setup
                          </Button>
                        </div>
                        <div className="mt-3 text-[11px] text-muted-fg">You can re-open this wizard anytime via `#/onboarding`.</div>
                      </div>
                    </div>
                  </div>

                  <details className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4">
                    <summary className="cursor-pointer text-xs font-semibold text-fg">What guided onboarding does</summary>
                    <div className="mt-3 space-y-2">
                      {previewLines("High-level steps", [
                        "Detect defaults from common repo markers (no commands are executed).",
                        "Draft and review `.ade/ade.yaml` before saving.",
                        "Optionally import existing branches as lanes (creates worktrees under `.ade/worktrees`).",
                        "Generate initial packs for quick context + conflict prediction."
                      ])}
                      <div className="grid gap-2 md:grid-cols-2">
                        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-3 text-xs">
                          <div className="flex items-center gap-2 font-semibold text-fg">
                            <GitBranch size={16} weight="regular" className="text-muted-fg" />
                            Lanes + worktrees
                          </div>
                          <div className="mt-1 text-muted-fg">Keep multiple branches checked out side-by-side without clobbering your working tree.</div>
                        </div>
                        <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-3 text-xs">
                          <div className="flex items-center gap-2 font-semibold text-fg">
                            <Package size={16} weight="regular" className="text-muted-fg" />
                            Packs + conflict radar
                          </div>
                          <div className="mt-1 text-muted-fg">Packs capture deterministic context; conflict radar predicts overlaps so you can fix issues early.</div>
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              ) : null}

              {step === "detect-defaults" ? (
                <div className="space-y-3">
                  {previewLines("What ADE will do", [
                    "Read a small set of files to detect your stack (no commands will be executed).",
                    "Parse CI workflow files (best-effort) to suggest test commands."
                  ])}

                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={defaultsBusy} onClick={() => void runDetectDefaults()}>
                      {defaultsBusy ? "Scanning..." : "Detect defaults"}
                    </Button>
                    {defaults ? (
                      <Chip>
                        {defaults.indicators.length} indicators · {defaults.suggestedWorkflows.length} workflows
                      </Chip>
                    ) : null}
                  </div>

                  {defaultsError ? (
                    <div className="rounded border border-red-800 bg-red-900/25 px-3 py-2 text-xs text-red-200">
                      {defaultsError}
                    </div>
                  ) : null}

                  {defaults ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-3 text-xs">
                        <div className="font-semibold text-fg">Signals</div>
                        <div className="mt-2 space-y-1">
                          {defaults.indicators.length === 0 ? (
                            <div className="text-muted-fg">No indicators detected.</div>
                          ) : (
                            defaults.indicators.slice(0, 12).map((ind) => (
                              <div key={`${ind.type}:${ind.file}`} className="flex items-center justify-between gap-2">
                                <span className="truncate text-fg">{ind.type}</span>
                                <span className="shrink-0 text-muted-fg">{ind.file}</span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-3 text-xs">
                        <div className="font-semibold text-fg">Suggested config</div>
                        <div className="mt-2 text-muted-fg">
                          processes: {defaults.suggestedConfig.processes?.length ?? 0} · test suites:{" "}
                          {defaults.suggestedConfig.testSuites?.length ?? 0} · stacks: {defaults.suggestedConfig.stackButtons?.length ?? 0} · automations:{" "}
                          {defaults.suggestedConfig.automations?.length ?? 0}
                        </div>
                        <div className="mt-2 space-y-1 text-muted-fg">
                          {(defaults.suggestedConfig.testSuites ?? []).slice(0, 6).map((suite) => (
                            <div key={suite.id} className="truncate">
                              {suite.id}: {commandArrayToLine(suite.command ?? [])}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-4 text-xs text-muted-fg">
                      Run detection to generate a starting config draft.
                    </div>
                  )}
                </div>
              ) : null}

              {step === "review-config" ? (
                <div className="space-y-3">
                  {previewLines("What ADE will do", [
                    "Write your selected processes, test suites, stack buttons, and automations into .ade/ade.yaml (shared project config).",
                    "Validate config before saving. No commands are executed."
                  ])}

                  <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-3 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-fg">Config target</div>
                        <div className="mt-1 text-muted-fg">
                          Existing: {configStats.existingProcesses} processes · {configStats.existingTests} test suites ·{" "}
                          {configStats.existingStacks} stacks · {configStats.existingAutomations} automations
                          <br />
                          Draft: {configStats.draftProcesses} processes · {configStats.draftTests} test suites ·{" "}
                          {configStats.draftStacks} stacks · {configStats.draftAutomations} automations
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] text-muted-fg">Apply mode</label>
                        <select
                          className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          value={applyMode}
                          onChange={(e) => setApplyMode(e.target.value as "append" | "replace")}
                        >
                          <option value="append">Append (recommended)</option>
                          <option value="replace">Replace (destructive)</option>
                        </select>
                        <Button size="sm" disabled={!defaults || configBusy} onClick={() => void applyConfig()}>
                          {configBusy ? "Saving..." : "Apply to .ade/ade.yaml"}
                        </Button>
                      </div>
                    </div>
                    {applyMode === "replace" ? (
                      <div className="mt-2 flex items-start gap-2 rounded border border-amber-700/60 bg-amber-900/20 px-2 py-1 text-[11px] text-amber-200">
                        <WarningCircle size={16} weight="regular" className="mt-0.5" />
                        <div>
                          Replace overwrites existing processes/test suites in shared config.
                          If you already have a tuned config, prefer Append.
                        </div>
                      </div>
                    ) : null}
                    {configAppliedAt ? (
                      <div className="mt-2 flex items-center gap-2 rounded border border-emerald-800 bg-emerald-900/20 px-2 py-1 text-[11px] text-emerald-200">
                        <CheckCircle size={16} weight="regular" />
                        Applied at {formatDate(configAppliedAt)}
                      </div>
                    ) : null}
                  </div>

                  {configError ? (
                    <div className="rounded border border-red-800 bg-red-900/25 px-3 py-2 text-xs text-red-200">
                      {configError}
                    </div>
                  ) : null}

                  {!defaults ? (
                    <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-4 text-xs text-muted-fg">
                      Run Detect Defaults first.
                    </div>
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="rounded border border-border/30 bg-card backdrop-blur-sm p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Processes</div>
                        <div className="mt-2 space-y-2">
                          {processDraft.length === 0 ? (
                            <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-3 text-xs text-muted-fg">
                              No suggested processes.
                            </div>
                          ) : null}
                          {processDraft.map((row, idx) => (
                            <div key={`${row.id}:${idx}`} className="rounded border border-border/10 bg-card backdrop-blur-sm p-2">
                              <div className="flex items-center justify-between gap-2">
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={row.enabled}
                                    onChange={(e) =>
                                      setProcessDraft((prev) =>
                                        prev.map((p, i) => (i === idx ? { ...p, enabled: e.target.checked } : p))
                                      )
                                    }
                                  />
                                  <span className="font-semibold text-fg">{row.id}</span>
                                </label>
                                <Chip>{row.cwd}</Chip>
                              </div>
                              <div className="mt-2 grid gap-2 md:grid-cols-2">
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                                  value={row.name}
                                  onChange={(e) =>
                                    setProcessDraft((prev) =>
                                      prev.map((p, i) => (i === idx ? { ...p, name: e.target.value } : p))
                                    )
                                  }
                                  placeholder="name"
                                />
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg font-mono"
                                  value={row.commandLine}
                                  onChange={(e) =>
                                    setProcessDraft((prev) =>
                                      prev.map((p, i) => (i === idx ? { ...p, commandLine: e.target.value } : p))
                                    )
                                  }
                                  placeholder="command"
                                />
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                                  value={row.cwd}
                                  onChange={(e) =>
                                    setProcessDraft((prev) =>
                                      prev.map((p, i) => (i === idx ? { ...p, cwd: e.target.value } : p))
                                    )
                                  }
                                  placeholder="cwd"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
	                      <div className="rounded border border-border/30 bg-card backdrop-blur-sm p-3">
	                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Test suites</div>
	                        <div className="mt-2 space-y-2">
	                          {testDraft.length === 0 ? (
                            <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-3 text-xs text-muted-fg">
                              No suggested test suites.
                            </div>
                          ) : null}
	                          {testDraft.map((row, idx) => (
	                            <div key={`${row.id}:${idx}`} className="rounded border border-border/10 bg-card backdrop-blur-sm p-2">
                              <div className="flex items-center justify-between gap-2">
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={row.enabled}
                                    onChange={(e) =>
                                      setTestDraft((prev) =>
                                        prev.map((p, i) => (i === idx ? { ...p, enabled: e.target.checked } : p))
                                      )
                                    }
                                  />
                                  <span className="font-semibold text-fg">{row.id}</span>
                                </label>
                                <Chip>{row.cwd}</Chip>
                              </div>
                              <div className="mt-2 grid gap-2 md:grid-cols-2">
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                                  value={row.name}
                                  onChange={(e) =>
                                    setTestDraft((prev) =>
                                      prev.map((p, i) => (i === idx ? { ...p, name: e.target.value } : p))
                                    )
                                  }
                                  placeholder="name"
                                />
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg font-mono"
                                  value={row.commandLine}
                                  onChange={(e) =>
                                    setTestDraft((prev) =>
                                      prev.map((p, i) => (i === idx ? { ...p, commandLine: e.target.value } : p))
                                    )
                                  }
                                  placeholder="command"
                                />
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                                  value={row.cwd}
                                  onChange={(e) =>
                                    setTestDraft((prev) =>
                                      prev.map((p, i) => (i === idx ? { ...p, cwd: e.target.value } : p))
                                    )
                                  }
                                  placeholder="cwd"
                                />
                              </div>
	                            </div>
	                          ))}
	                        </div>
	                      </div>

                      <div className="rounded border border-border/30 bg-card backdrop-blur-sm p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Stack buttons</div>
                        <div className="mt-2 space-y-2">
                          {stackDraft.length === 0 ? (
                            <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-3 text-xs text-muted-fg">
                              No suggested stack buttons.
                            </div>
                          ) : null}
                          {stackDraft.map((row, idx) => (
                            <div key={`${row.id}:${idx}`} className="rounded border border-border/10 bg-card backdrop-blur-sm p-2">
                              <div className="flex items-center justify-between gap-2">
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(row.include)}
                                    onChange={(e) =>
                                      setStackDraft((prev) => prev.map((s, i) => (i === idx ? { ...s, include: e.target.checked } : s)))
                                    }
                                  />
                                  <span className="font-semibold text-fg">{row.id}</span>
                                </label>
                                <select
                                  className="h-7 rounded border border-border/30 bg-bg px-2 text-[11px] text-muted-fg"
                                  value={row.startOrder ?? "parallel"}
                                  onChange={(e) =>
                                    setStackDraft((prev) =>
                                      prev.map((s, i) =>
                                        i === idx
                                          ? { ...s, startOrder: e.target.value === "dependency" ? "dependency" : "parallel" }
                                          : s
                                      )
                                    )
                                  }
                                >
                                  <option value="parallel">parallel</option>
                                  <option value="dependency">dependency</option>
                                </select>
                              </div>
                              <div className="mt-2 grid gap-2 md:grid-cols-2">
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                                  value={row.name ?? ""}
                                  onChange={(e) =>
                                    setStackDraft((prev) =>
                                      prev.map((s, i) => (i === idx ? { ...s, name: e.target.value } : s))
                                    )
                                  }
                                  placeholder="name"
                                />
                                <input
                                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg font-mono"
                                  value={(row.processIds ?? []).join(", ")}
                                  onChange={(e) =>
                                    setStackDraft((prev) =>
                                      prev.map((s, i) =>
                                        i === idx
                                          ? {
                                              ...s,
                                              processIds: e.target.value
                                                .split(",")
                                                .map((v) => v.trim())
                                                .filter(Boolean)
                                            }
                                          : s
                                      )
                                    )
                                  }
                                  placeholder="process ids (comma-separated)"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded border border-border/30 bg-card backdrop-blur-sm p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Automations</div>
                        <div className="mt-2 space-y-2">
                          {automationDraft.length === 0 ? (
                            <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-3 text-xs text-muted-fg">
                              No suggested automations.
                            </div>
                          ) : null}
                          {automationDraft.map((row, idx) => {
                            const triggerType = row.trigger?.type ?? "manual";
                            const triggerSuffix =
                              triggerType === "schedule" && row.trigger?.cron ? ` (${row.trigger.cron})` : triggerType === "commit" && row.trigger?.branch ? ` (${row.trigger.branch})` : "";
                            const actionTypes = (row.actions ?? []).map((a) => (a as any)?.type).filter(Boolean).join(", ");
                            return (
                              <div key={`${row.id}:${idx}`} className="rounded border border-border/10 bg-card backdrop-blur-sm p-2">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <label className="flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={Boolean(row.include)}
                                      onChange={(e) =>
                                        setAutomationDraft((prev) =>
                                          prev.map((r, i) => (i === idx ? { ...r, include: e.target.checked } : r))
                                        )
                                      }
                                    />
                                    <span className="font-semibold text-fg">{row.id}</span>
                                  </label>
                                  <div className="flex items-center gap-2">
                                    <Chip>
                                      {triggerType}
                                      {triggerSuffix}
                                    </Chip>
                                    <label className="flex items-center gap-2 text-xs text-muted-fg">
                                      <input
                                        type="checkbox"
                                        checked={Boolean(row.enabled)}
                                        onChange={(e) =>
                                          setAutomationDraft((prev) =>
                                            prev.map((r, i) => (i === idx ? { ...r, enabled: e.target.checked } : r))
                                          )
                                        }
                                      />
                                      enabled
                                    </label>
                                  </div>
                                </div>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                  <input
                                    className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                                    value={row.name ?? ""}
                                    onChange={(e) =>
                                      setAutomationDraft((prev) =>
                                        prev.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r))
                                      )
                                    }
                                    placeholder="name"
                                  />
                                  <div className="flex items-center rounded border border-border/15 bg-card px-2 text-[11px] text-muted-fg font-mono">
                                    {actionTypes || "(no actions)"}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
	                    </div>
	                  )}
	                </div>
	              ) : null}

              {step === "configure-ai" ? (
                <div className="space-y-3">
                  {/* Provider Detection */}
                  <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-fg mb-3">Detected AI Providers</div>
                    {aiStatus?.detectedAuth?.length ? (
                      <div className="space-y-2">
                        {aiStatus.detectedAuth.map((auth, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <CheckCircle size={14} weight="fill" className="text-emerald-400" />
                            <span className="text-fg">
                              {auth.cli ? `${auth.cli} CLI` : auth.provider ?? "Unknown"}{" "}
                              {auth.type === "cli-subscription" ? " (subscription)" : auth.type === "api-key" ? " (API key)" : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-fg">No AI providers detected. You can add API keys in Settings later.</div>
                    )}
                    {aiStatus?.availableProviders ? (
                      <div className="mt-2 flex items-center gap-3 text-xs text-muted-fg">
                        <span>Claude: {aiStatus.availableProviders.claude ? "\u2713" : "\u2014"}</span>
                        <span>Codex: {aiStatus.availableProviders.codex ? "\u2713" : "\u2014"}</span>
                      </div>
                    ) : null}
                  </div>

                  {/* Feature Toggles */}
                  <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-fg mb-3">AI Features</div>
                    <div className="text-xs text-muted-fg mb-3">Choose which AI features to enable. All can be changed later in Settings.</div>
                    <div className="space-y-2">
                      {([
                        { key: "terminal_summaries", label: "Terminal Summaries", desc: "Summarize terminal sessions when they close" },
                        { key: "pr_descriptions", label: "PR Descriptions", desc: "Auto-draft PR descriptions from lane changes" },
                        { key: "narratives", label: "Narratives", desc: "Generate work narratives for completed tasks" },
                        { key: "conflict_proposals", label: "Conflict Proposals", desc: "Suggest resolutions for merge conflicts" },
                        { key: "mission_planning", label: "Mission Planning", desc: "AI-powered mission planning" },
                        { key: "orchestrator", label: "Orchestrator", desc: "AI orchestrator for mission execution" },
                        { key: "initial_context", label: "Initial Context", desc: "Generate initial project context" },
                      ] as const).map(({ key, label, desc }) => (
                        <label key={key} className="flex items-center gap-3 rounded border border-border/10 bg-card/50 px-3 py-2 cursor-pointer hover:bg-card/80 transition-colors">
                          <input
                            type="checkbox"
                            checked={aiToggles[key] ?? true}
                            onChange={(e) => setAiToggles((prev) => ({ ...prev, [key]: e.target.checked }))}
                            className="accent-emerald-400"
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-fg">{label}</div>
                            <div className="text-[11px] text-muted-fg">{desc}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Save / Skip buttons */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded border border-border/30 bg-card px-3 py-1.5 text-xs font-semibold text-muted-fg hover:text-fg transition-colors"
                      onClick={goNext}
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      className="rounded border border-accent/30 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/25 transition-colors"
                      disabled={aiSaving}
                      onClick={async () => {
                        setAiSaving(true);
                        try {
                          const features: Record<string, boolean> = {};
                          for (const [k, v] of Object.entries(aiToggles)) features[k] = v;
                          await window.ade.ai.updateConfig({ features });
                        } catch {
                          // ignore errors, non-blocking
                        } finally {
                          setAiSaving(false);
                        }
                        goNext();
                      }}
                    >
                      {aiSaving ? "Saving..." : "Save & Continue"}
                    </button>
                  </div>
                </div>
              ) : null}

              {step === "detect-branches" ? (
                <div className="space-y-3">
                  {previewLines("What ADE will do", [
                    "List local branches and exclude ones already represented as lanes.",
                    "Compute ahead/behind vs your base reference to help pick candidates."
                  ])}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={branchesBusy} onClick={() => void runDetectBranches()}>
                      {branchesBusy ? "Scanning..." : "Detect branches"}
                    </Button>
                    {branches.length ? <Chip>{branches.length} candidates</Chip> : null}
                  </div>

                  {branchesError ? (
                    <div className="rounded border border-red-800 bg-red-900/25 px-3 py-2 text-xs text-red-200">
                      {branchesError}
                    </div>
                  ) : null}

                  {branches.length ? (
                    <div className="rounded border border-border/30 bg-card backdrop-blur-sm p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-muted-fg">Select branches to import</div>
                        <div className="flex items-center gap-2">
                          <input
                            className="h-8 w-[min(320px,100%)] rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none placeholder:text-muted-fg"
                            placeholder="Search branches"
                            value={branchQuery}
                            onChange={(e) => setBranchQuery(e.target.value)}
                          />
                          <Chip>{selectedBranches.size} selected</Chip>
                        </div>
                      </div>

                      <div className="mt-2 max-h-[360px] overflow-auto rounded border border-border/10 bg-card">
                        <table className="w-full text-left text-xs">
                          <thead className="sticky top-0 bg-bg">
                            <tr className="border-b border-border/10">
                              <th className="px-3 py-2 font-semibold text-fg">Import</th>
                              <th className="px-3 py-2 font-semibold text-fg">Branch</th>
                              <th className="px-3 py-2 font-semibold text-fg">Ahead</th>
                              <th className="px-3 py-2 font-semibold text-fg">Behind</th>
                              <th className="px-3 py-2 font-semibold text-fg">Remote</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/10">
                            {visibleBranches.map((b) => {
                              const checked = selectedBranches.has(b.branchRef);
                              return (
                                <tr key={b.branchRef}>
                                  <td className="px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(e) =>
                                        setSelectedBranches((prev) => {
                                          const next = new Set(prev);
                                          if (e.target.checked) next.add(b.branchRef);
                                          else next.delete(b.branchRef);
                                          return next;
                                        })
                                      }
                                    />
                                  </td>
                                  <td className="px-3 py-2 font-mono text-fg">{b.branchRef}</td>
                                  <td className="px-3 py-2 text-muted-fg">{b.ahead}</td>
                                  <td className="px-3 py-2 text-muted-fg">{b.behind}</td>
                                  <td className="px-3 py-2 text-muted-fg">{b.hasRemote ? "origin" : "-"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-muted-fg">
                          Import parent:{" "}
                          <select
                            className="ml-2 h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                            value={importParentLaneId}
                            onChange={(e) => setImportParentLaneId(e.target.value)}
                          >
                            <option value="__primary__">Primary lane (recommended)</option>
                            <option value="__none__">No parent (baseRef only)</option>
                            {lanes
                              .filter((lane) => lane.laneType !== "primary")
                              .map((lane) => (
                                <option key={lane.id} value={lane.id}>
                                  {lane.name}
                                </option>
                              ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedBranches(new Set(visibleBranches.map((b) => b.branchRef)))}
                          >
                            Select all (filtered)
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedBranches(new Set())}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-4 text-xs text-muted-fg">
                      Detect branches to import existing work into lanes.
                    </div>
                  )}
                </div>
              ) : null}

              {step === "import-branches" ? (
                <div className="space-y-3">
                  {previewLines("What ADE will do", [
                    `Run git worktree add for each selected branch (under .ade/worktrees).`,
                    "Create lane records in ADE local DB and refresh lane list."
                  ])}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={importBusy || selectedBranches.size === 0} onClick={() => void importSelected()}>
                      {importBusy ? "Importing..." : `Import ${selectedBranches.size} branch${selectedBranches.size === 1 ? "" : "es"}`}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void refreshLanes()} disabled={importBusy}>
                      Refresh lanes
                    </Button>
                    {selectedParentLaneId ? (
                      <Chip>parent: {lanes.find((l) => l.id === selectedParentLaneId)?.name ?? "Primary"}</Chip>
                    ) : (
                      <Chip>no parent</Chip>
                    )}
                  </div>

                  {importError ? (
                    <div className="rounded border border-red-800 bg-red-900/25 px-3 py-2 text-xs text-red-200">
                      {importError}
                    </div>
                  ) : null}

                  {Object.keys(importResults).length ? (
                    <div className="rounded border border-border/30 bg-card backdrop-blur-sm p-3">
                      <div className="text-xs font-semibold text-muted-fg">Import results</div>
                      <div className="mt-2 max-h-[320px] overflow-auto rounded border border-border/10 bg-card">
                        <table className="w-full text-left text-xs">
                          <thead className="sticky top-0 bg-bg">
                            <tr className="border-b border-border/10">
                              <th className="px-3 py-2 font-semibold text-fg">Branch</th>
                              <th className="px-3 py-2 font-semibold text-fg">Status</th>
                              <th className="px-3 py-2 font-semibold text-fg">Details</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/10">
                            {Object.entries(importResults).map(([branchRef, res]) => (
                              <tr key={branchRef}>
                                <td className="px-3 py-2 font-mono text-fg">{branchRef}</td>
                                <td
                                  className={cn(
                                    "px-3 py-2",
                                    res.status === "imported"
                                      ? "text-emerald-300"
                                      : res.status === "skipped"
                                        ? "text-amber-300"
                                        : res.status === "failed"
                                          ? "text-red-300"
                                          : "text-muted-fg"
                                  )}
                                >
                                  {res.status}
                                </td>
                                <td className="px-3 py-2 text-muted-fg">
                                  {res.lane ? `${res.lane.name} (${res.lane.id.slice(0, 8)})` : res.error ?? "-"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded border border-dashed border-border/20 bg-card backdrop-blur-sm p-4 text-xs text-muted-fg">
                      No imports yet. Select branches in the previous step.
                    </div>
                  )}
                </div>
              ) : null}

              {step === "generate-packs" ? (
                <div className="space-y-3">
                  {previewLines("What ADE will do", [
                    "Refresh project pack and lane packs for imported lanes.",
                    "Generate baseline conflict packs using merge-tree (no AI calls)."
                  ])}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={packsBusy} onClick={() => void generatePacks()}>
                      {packsBusy ? "Generating..." : "Generate initial packs"}
                    </Button>
                    {packsDoneAt ? <Chip>done {formatDate(packsDoneAt)}</Chip> : null}
                  </div>

                  {packsError ? (
                    <div className="rounded border border-red-800 bg-red-900/25 px-3 py-2 text-xs text-red-200">
                      {packsError}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {step === "complete" ? (
                <div className="space-y-3">
                  {previewLines("What ADE will do", [
                    "Mark onboarding complete for this project (local ADE DB).",
                    "You can re-open this wizard anytime by visiting #/onboarding."
                  ])}

                  <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-md border border-border/10 bg-card backdrop-blur-sm p-2">
                        <Sparkle size={20} weight="regular" className="text-accent" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">You are ready</div>
                        <div className="mt-1 text-xs text-muted-fg">
                          Next: go to Run to start processes/tests, and to Conflicts to use the radar and generate proposals.
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => void complete()} disabled={Boolean(statusCompletedAt)}>
                        {statusCompletedAt ? "Completed" : "Complete onboarding"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => navigate("/project", { replace: true })}>
                        Go to Run
                      </Button>
                    </div>

                    {configError ? (
                      <div className="mt-2 rounded border border-red-800 bg-red-900/25 px-3 py-2 text-xs text-red-200">
                        {configError}
                      </div>
                    ) : null}
                  </div>

                  {/* AI configuration summary */}
                  {aiStatus ? (
                    <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 mt-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 rounded-md border border-border/10 bg-card backdrop-blur-sm p-2">
                          <MagicWand size={20} weight="regular" className="text-accent" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold">AI Ready</div>
                          <div className="mt-1 space-y-1 text-xs text-muted-fg">
                            {aiStatus.detectedAuth?.length ? (
                              <div>{aiStatus.detectedAuth.length} AI provider{aiStatus.detectedAuth.length !== 1 ? "s" : ""} configured</div>
                            ) : (
                              <div>No AI providers configured yet</div>
                            )}
                            <div>{Object.values(aiToggles).filter(Boolean).length} of 7 AI features enabled</div>
                            <div>You can change these anytime in Settings &rarr; AI Features</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={!canGoBack} onClick={goPrev}>
                    Back
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  {step === "welcome" ? (
                    <Button size="sm" onClick={goNext}>
                      Start
                      <Sparkle size={16} weight="regular" />
                    </Button>
                  ) : step === "detect-defaults" ? (
                    <Button size="sm" disabled={!defaults} onClick={goNext}>
                      Next
                      <Sparkle size={16} weight="regular" />
                    </Button>
                  ) : step === "review-config" ? (
                    <Button size="sm" onClick={goNext}>
                      Next
                      <Sparkle size={16} weight="regular" />
                    </Button>
                  ) : step === "configure-ai" ? (
                    null  // Save/Skip handled in step content
                  ) : step === "detect-branches" ? (
                    <Button size="sm" onClick={goNext}>
                      Next
                      <Sparkle size={16} weight="regular" />
                    </Button>
                  ) : step === "import-branches" ? (
                    <Button size="sm" onClick={goNext}>
                      Next
                      <Sparkle size={16} weight="regular" />
                    </Button>
                  ) : step === "generate-packs" ? (
                    <Button size="sm" onClick={goNext}>
                      Next
                      <Sparkle size={16} weight="regular" />
                    </Button>
                  ) : (
                    <div className="text-xs text-muted-fg">Done</div>
                  )}
                </div>
              </div>

              {statusCompletedAt ? (
                <div className="rounded border border-emerald-800 bg-emerald-900/20 px-3 py-2 text-xs text-emerald-200">
                  Onboarding completed at {formatDate(statusCompletedAt)}.
                </div>
              ) : null}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
