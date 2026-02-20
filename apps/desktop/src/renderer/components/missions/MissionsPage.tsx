import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Diamond,
  GitPullRequest,
  Hexagon,
  Link2,
  Loader2,
  Pentagon,
  Plus,
  RefreshCw,
  Rocket,
  Route,
  Star,
  Terminal,
  TriangleAlert,
  Waypoints
} from "lucide-react";
import { motion, AnimatePresence, LazyMotion, domAnimation } from "motion/react";
import type {
  MissionArtifactType,
  MissionDetail,
  MissionExecutorPolicy,
  MissionIntervention,
  MissionPlannerEngine,
  MissionPriority,
  MissionStatus,
  MissionStepStatus,
  MissionSummary,
  OrchestratorAttempt,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  StartOrchestratorRunFromMissionArgs
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import {
  staggerContainer,
  staggerContainerSlow,
  staggerItem,
  slideInRight,
  fadeScale,
  springSnappy,
  springGentle,
  easeOut150
} from "../../lib/motion";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";

type CreateDraft = {
  title: string;
  prompt: string;
  laneId: string;
  priority: MissionPriority;
  executionMode: "local" | "relay";
  targetMachineId: string;
  plannerEngine: MissionPlannerEngine;
  executorPolicy: MissionExecutorPolicy;
  allowPlanningQuestions: boolean;
  autoStart: boolean;
  orchestratorProvider: "claude" | "codex" | "auto";
  plannerMode: "ai" | "deterministic" | "auto";
};

type ArtifactDraft = {
  artifactType: MissionArtifactType;
  title: string;
  uri: string;
  description: string;
};

type InterventionDraft = {
  interventionType: MissionIntervention["interventionType"];
  title: string;
  body: string;
};

const STATUS_COLUMNS: Array<{ status: MissionStatus; label: string; hint: string }> = [
  { status: "queued", label: "Queued", hint: "Ready to launch" },
  { status: "planning", label: "Planning", hint: "Synthesizing execution plan" },
  { status: "plan_review", label: "Plan Review", hint: "Awaiting plan approval" },
  { status: "in_progress", label: "Running", hint: "Actively executing" },
  { status: "intervention_required", label: "Action Needed", hint: "Awaiting decision" },
  { status: "completed", label: "Completed", hint: "Finished with outcomes" },
  { status: "failed", label: "Failed", hint: "Needs recovery" },
  { status: "canceled", label: "Canceled", hint: "Stopped intentionally" }
];

const STATUS_ICONS: Record<MissionStatus, string> = {
  queued: "clock",
  planning: "route",
  plan_review: "waypoints",
  in_progress: "zap",
  intervention_required: "alert",
  completed: "check",
  failed: "x",
  canceled: "slash"
};

const STATUS_ACCENT_COLORS: Record<MissionStatus, string> = {
  queued: "rgb(56, 189, 248)",
  planning: "rgb(96, 165, 250)",
  plan_review: "rgb(14, 165, 233)",
  in_progress: "rgb(139, 92, 246)",
  intervention_required: "rgb(251, 191, 36)",
  completed: "rgb(52, 211, 153)",
  failed: "rgb(248, 113, 113)",
  canceled: "rgb(148, 163, 184)"
};

/* Floating geometric shapes config — limited to 4 for perf */
const FLOATING_SHAPES = [
  { Icon: Diamond, size: "h-3 w-3", x: "left-[8%]", y: "top-[18%]", delay: "0s", opacity: "opacity-[0.12]" },
  { Icon: Star, size: "h-2.5 w-2.5", x: "left-[45%]", y: "top-[12%]", delay: "2s", opacity: "opacity-[0.1]" },
  { Icon: Pentagon, size: "h-3.5 w-3.5", x: "left-[78%]", y: "top-[25%]", delay: "1.5s", opacity: "opacity-[0.11]" },
  { Icon: Hexagon, size: "h-4 w-4", x: "left-[22%]", y: "top-[65%]", delay: "1s", opacity: "opacity-[0.08]" }
];

const PLANNER_ENGINES: Array<{ value: MissionPlannerEngine; label: string }> = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "claude_cli", label: "Claude" },
  { value: "codex_cli", label: "Codex" }
];
const EXECUTOR_POLICIES: Array<{ value: MissionExecutorPolicy; label: string; description: string }> = [
  {
    value: "both",
    label: "Both (recommended)",
    description: "Codex for code-heavy steps; Claude for planning/review/docs."
  },
  {
    value: "codex",
    label: "Codex only",
    description: "Route all mission execution steps to Codex."
  },
  {
    value: "claude",
    label: "Claude only",
    description: "Route all mission execution steps to Claude."
  }
];

function statusTone(status: MissionStatus): string {
  if (status === "queued") return "text-sky-300 border-sky-500/40 bg-sky-500/10";
  if (status === "planning") return "text-blue-300 border-blue-500/40 bg-blue-500/10";
  if (status === "plan_review") return "text-cyan-300 border-cyan-500/40 bg-cyan-500/10";
  if (status === "in_progress") return "text-violet-300 border-violet-500/40 bg-violet-500/10";
  if (status === "intervention_required") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  if (status === "completed") return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  if (status === "failed") return "text-red-300 border-red-500/40 bg-red-500/10";
  return "text-muted-fg border-border bg-card/30";
}

function statusBorderColor(status: MissionStatus): string {
  if (status === "queued") return "border-l-sky-400";
  if (status === "planning") return "border-l-blue-400";
  if (status === "plan_review") return "border-l-cyan-400";
  if (status === "in_progress") return "border-l-violet-400";
  if (status === "intervention_required") return "border-l-amber-400";
  if (status === "completed") return "border-l-emerald-400";
  if (status === "failed") return "border-l-red-400";
  return "border-l-muted-fg/40";
}

function priorityTone(priority: MissionPriority): string {
  if (priority === "urgent") return "text-red-300 border-red-500/40 bg-red-500/10";
  if (priority === "high") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  if (priority === "normal") return "text-sky-300 border-sky-500/40 bg-sky-500/10";
  return "text-muted-fg border-border bg-card/30";
}

function stepTone(status: MissionStepStatus): string {
  if (status === "succeeded") return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  if (status === "failed") return "text-red-300 border-red-500/40 bg-red-500/10";
  if (status === "running") return "text-violet-300 border-violet-500/40 bg-violet-500/10";
  if (status === "blocked") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  if (status === "skipped" || status === "canceled") return "text-muted-fg border-border bg-card/30";
  return "text-sky-300 border-sky-500/40 bg-sky-500/10";
}

function stepDotColor(status: MissionStepStatus): string {
  if (status === "succeeded") return "bg-emerald-400";
  if (status === "failed") return "bg-red-400";
  if (status === "running") return "bg-violet-400";
  if (status === "blocked") return "bg-amber-400";
  if (status === "skipped" || status === "canceled") return "bg-muted-fg/40";
  return "bg-sky-400";
}

function interventionTone(status: MissionIntervention["status"]): string {
  if (status === "open") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  if (status === "resolved") return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  return "text-muted-fg border-border bg-card/30";
}

function formatWhen(iso: string | null): string {
  if (!iso) return "-";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString();
}

function shortId(value: string | null | undefined, width = 8): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.length) return "-";
  return trimmed.slice(0, width);
}

function relativeWhen(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const delta = Math.max(0, Date.now() - ts);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function countByStatus(missions: MissionSummary[]) {
  const map: Record<MissionStatus, number> = {
    queued: 0,
    planning: 0,
    plan_review: 0,
    in_progress: 0,
    intervention_required: 0,
    completed: 0,
    failed: 0,
    canceled: 0
  };
  for (const mission of missions) {
    map[mission.status] = (map[mission.status] ?? 0) + 1;
  }
  return map;
}

export function MissionsPage() {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [missions, setMissions] = React.useState<MissionSummary[]>([]);
  const [selectedMissionId, setSelectedMissionId] = React.useState<string | null>(null);
  const [selectedMission, setSelectedMission] = React.useState<MissionDetail | null>(null);
  const [runGraph, setRunGraph] = React.useState<OrchestratorRunGraph | null>(null);

  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [detailBusy, setDetailBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [createBusy, setCreateBusy] = React.useState(false);
  const [missionActionBusy, setMissionActionBusy] = React.useState(false);
  const [artifactBusy, setArtifactBusy] = React.useState(false);
  const [interventionBusy, setInterventionBusy] = React.useState(false);
  const [outcomeBusy, setOutcomeBusy] = React.useState(false);
  const [runBusy, setRunBusy] = React.useState(false);

  const [showForm, setShowForm] = React.useState(false);
  const [launchAnimating, setLaunchAnimating] = React.useState(false);

  /* Collapsible detail sections */
  const [expandedSections, setExpandedSections] = React.useState<Record<string, boolean>>({
    info: true,
    outcome: false,
    steps: true,
    orchestrator: true,
    interventions: true,
    artifacts: true,
    timeline: true
  });

  const toggleSection = (key: string) =>
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const [createDraft, setCreateDraft] = React.useState<CreateDraft>({
    title: "",
    prompt: "",
    laneId: "",
    priority: "normal",
    executionMode: "local",
    targetMachineId: "",
    plannerEngine: "auto",
    executorPolicy: "both",
    allowPlanningQuestions: false,
    autoStart: true,
    orchestratorProvider: "auto",
    plannerMode: "auto"
  });
  const [artifactDraft, setArtifactDraft] = React.useState<ArtifactDraft>({
    artifactType: "pr",
    title: "",
    uri: "",
    description: ""
  });
  const [interventionDraft, setInterventionDraft] = React.useState<InterventionDraft>({
    interventionType: "manual_input",
    title: "",
    body: ""
  });
  const [outcomeDraft, setOutcomeDraft] = React.useState("");

  const selectedMissionSummary = React.useMemo(
    () => (selectedMissionId ? missions.find((mission) => mission.id === selectedMissionId) ?? null : null),
    [missions, selectedMissionId]
  );

  const statusCount = React.useMemo(() => countByStatus(missions), [missions]);
  const attemptsByStep = React.useMemo(() => {
    const map = new Map<string, OrchestratorAttempt[]>();
    if (!runGraph) return map;
    for (const attempt of runGraph.attempts) {
      const bucket = map.get(attempt.stepId) ?? [];
      bucket.push(attempt);
      map.set(attempt.stepId, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => b.attemptNumber - a.attemptNumber);
    }
    return map;
  }, [runGraph]);

  const runningAttemptCount = React.useMemo(
    () => runGraph?.attempts.filter((attempt) => attempt.status === "running").length ?? 0,
    [runGraph]
  );

  const sessionAttempts = React.useMemo(
    () =>
      (runGraph?.attempts ?? [])
        .filter((attempt) => attempt.executorSessionId)
        .map((attempt) => ({
          attemptId: attempt.id,
          stepId: attempt.stepId,
          stepTitle: runGraph?.steps.find((step) => step.id === attempt.stepId)?.title ?? "Step",
          sessionId: attempt.executorSessionId!,
          executorKind: attempt.executorKind,
          status: attempt.status
        })),
    [runGraph]
  );

  const liveSessionAttempts = React.useMemo(
    () => sessionAttempts.filter((entry) => entry.status === "running"),
    [sessionAttempts]
  );

  const [liveSessionTailById, setLiveSessionTailById] = React.useState<Record<string, string>>({});

  const openInterventions = React.useMemo(
    () => selectedMission?.interventions.filter((entry) => entry.status === "open") ?? [],
    [selectedMission]
  );

  const runtimeLaneIds = React.useMemo(
    () =>
      Array.from(
        new Set((runGraph?.steps ?? []).map((step) => step.laneId).filter((laneId): laneId is string => Boolean(laneId)))
      ),
    [runGraph]
  );

  const runtimeLaneStrip = React.useMemo(() => {
    if (!runGraph) return [];
    const laneByStepId = new Map<string, string | null>();
    for (const step of runGraph.steps) {
      laneByStepId.set(step.id, step.laneId);
    }
    return runtimeLaneIds.map((laneId) => {
      const stepCount = runGraph.steps.filter((step) => step.laneId === laneId).length;
      const runningCount = runGraph.attempts.filter((attempt) => {
        const attemptLaneId = laneByStepId.get(attempt.stepId);
        return attemptLaneId === laneId && attempt.status === "running";
      }).length;
      return {
        laneId,
        laneName: lanes.find((lane) => lane.id === laneId)?.name ?? laneId,
        stepCount,
        runningCount
      };
    });
  }, [runGraph, runtimeLaneIds, lanes]);

  const plannerSummary = React.useMemo(() => {
    if (!selectedMission?.steps.length) return null;
    for (const step of selectedMission.steps) {
      const planner =
        step.metadata && typeof step.metadata.planner === "object" && !Array.isArray(step.metadata.planner)
          ? (step.metadata.planner as Record<string, unknown>)
          : null;
      if (!planner) continue;
      return {
        strategy: typeof planner.strategy === "string" ? planner.strategy : "deterministic_split",
        version: typeof planner.version === "string" ? planner.version : "ade.missionPlanner.v1"
      };
    }
    return {
      strategy: "deterministic_split",
      version: "ade.missionPlanner.v1"
    };
  }, [selectedMission]);

  const plannerRunSummary = React.useMemo(() => {
    const events = selectedMission?.events ?? [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const entry = events[index];
      if (!entry || entry.eventType !== "mission_plan_generated") continue;
      const payload = entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {};
      const record = payload as Record<string, unknown>;
      return {
        requestedEngine: typeof record.requestedEngine === "string" ? record.requestedEngine : "auto",
        resolvedEngine: typeof record.resolvedEngine === "string" ? record.resolvedEngine : "deterministic_fallback",
        degraded: record.degraded === true,
        reasonCode: typeof record.reasonCode === "string" ? record.reasonCode : null,
        planHash: typeof record.planHash === "string" ? record.planHash : null,
        normalizedPlanHash: typeof record.normalizedPlanHash === "string" ? record.normalizedPlanHash : null
      };
    }
    return null;
  }, [selectedMission]);

  const runAutopilotState = React.useMemo(() => {
    const autopilot =
      runGraph?.run.metadata && typeof runGraph.run.metadata.autopilot === "object" && !Array.isArray(runGraph.run.metadata.autopilot)
        ? (runGraph.run.metadata.autopilot as Record<string, unknown>)
        : null;
    const enabled = autopilot?.enabled === true;
    const executor = typeof autopilot?.executorKind === "string" ? autopilot.executorKind : null;
    return {
      enabled,
      executor
    };
  }, [runGraph]);

  const canStartOrRerun = !runGraph || runGraph.run.status === "succeeded" || runGraph.run.status === "failed" || runGraph.run.status === "canceled";
  const canCancelRun = Boolean(
    runGraph &&
      runGraph.run.status !== "succeeded" &&
      runGraph.run.status !== "failed" &&
      runGraph.run.status !== "canceled"
  );
  const canResumeRun = runGraph?.run.status === "paused";

  const refreshMissionList = React.useCallback(
    async (opts: { preserveSelection?: boolean; silent?: boolean } = {}) => {
      if (!opts.silent) {
        setRefreshing(true);
      }

      try {
        if (!lanes.length) {
          await refreshLanes().catch(() => {});
        }
        const list = await window.ade.missions.list({ limit: 300 });
        setMissions(list);
        setError(null);

        const preserve = opts.preserveSelection ?? true;
        if (!preserve) {
          setSelectedMissionId(list[0]?.id ?? null);
          return;
        }

        setSelectedMissionId((prev) => {
          if (prev && list.some((mission) => mission.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [lanes.length, refreshLanes]
  );

  const loadMissionDetail = React.useCallback(async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed.length) return;
    setDetailBusy(true);
    try {
      const detail = await window.ade.missions.get(trimmed);
      setSelectedMission(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailBusy(false);
    }
  }, []);

  const loadOrchestratorGraph = React.useCallback(async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed.length) {
      setRunGraph(null);
      return;
    }
    try {
      const runs = await window.ade.orchestrator.listRuns({ missionId: trimmed, limit: 20 });
      const latestRun = runs[0];
      if (!latestRun) {
        setRunGraph(null);
        return;
      }
      const graph = await window.ade.orchestrator.getRunGraph({ runId: latestRun.id, timelineLimit: 120 });
      setRunGraph(graph);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunGraph(null);
    }
  }, []);

  React.useEffect(() => {
    void refreshMissionList({ preserveSelection: true });
  }, [refreshMissionList]);

  React.useEffect(() => {
    if (!selectedMissionId) {
      setSelectedMission(null);
      setRunGraph(null);
      return;
    }
    void loadMissionDetail(selectedMissionId);
    void loadOrchestratorGraph(selectedMissionId);
  }, [selectedMissionId, loadMissionDetail, loadOrchestratorGraph]);

  React.useEffect(() => {
    const unsub = window.ade.missions.onEvent((payload) => {
      void refreshMissionList({ preserveSelection: true, silent: true });
      if (payload.missionId && payload.missionId === selectedMissionId) {
        void loadMissionDetail(payload.missionId);
        void loadOrchestratorGraph(payload.missionId);
      }
    });
    return () => unsub();
  }, [loadMissionDetail, loadOrchestratorGraph, refreshMissionList, selectedMissionId]);

  React.useEffect(() => {
    const unsub = window.ade.orchestrator.onEvent(() => {
      if (!selectedMissionId) return;
      void loadOrchestratorGraph(selectedMissionId);
    });
    return () => unsub();
  }, [loadOrchestratorGraph, selectedMissionId]);

  React.useEffect(() => {
    setOutcomeDraft(selectedMission?.outcomeSummary ?? "");
  }, [selectedMission?.id, selectedMission?.outcomeSummary]);

  React.useEffect(() => {
    if (liveSessionAttempts.length === 0) {
      setLiveSessionTailById({});
      return;
    }

    let cancelled = false;
    const updateTails = async () => {
      const entries = await Promise.all(
        liveSessionAttempts.map(async (entry) => {
          try {
            const tail = await window.ade.sessions.readTranscriptTail({
              sessionId: entry.sessionId,
              maxBytes: 2400
            });
            return [entry.sessionId, tail] as const;
          } catch {
            return [entry.sessionId, ""] as const;
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [sessionId, tail] of entries) {
        next[sessionId] = tail;
      }
      setLiveSessionTailById(next);
    };

    void updateTails();
    const timer = window.setInterval(() => {
      void updateTails();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [liveSessionAttempts]);

  const startRunForMission = React.useCallback(
    async (args: {
      missionId: string;
      laneId?: string | null;
      executorKind: OrchestratorExecutorKind;
      approveExistingPlan?: boolean;
    }) => {
      const missionId = args.missionId.trim();
      if (!missionId.length) return;
      const defaultExecutorKind: OrchestratorExecutorKind = args.executorKind;

      if (args.laneId) {
        try {
          await window.ade.packs.refreshLanePack(args.laneId);
        } catch {
          // Orchestrator also retries pack bootstrap server-side when lane pack is empty.
        }
      }
      try {
        await window.ade.packs.refreshProjectPack({
          laneId: args.laneId ?? undefined
        });
      } catch {
        // Non-fatal in launcher path.
      }

      const startArgs = {
        missionId,
        runMode: "autopilot",
        autopilotOwnerId: "missions-autopilot",
        defaultExecutorKind,
        defaultRetryLimit: 1
      } satisfies StartOrchestratorRunFromMissionArgs;
      const started = args.approveExistingPlan
        ? await window.ade.orchestrator.approveMissionPlan(startArgs)
        : await window.ade.orchestrator.startRunFromMission(startArgs);

      return started;
    },
    []
  );

  const launchMission = async () => {
    const prompt = createDraft.prompt.trim();
    if (!prompt.length) {
      setError("Mission prompt is required.");
      return;
    }
    const fallbackLaneId = lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? "";
    const resolvedLaneId = createDraft.laneId.trim() || fallbackLaneId;

    setLaunchAnimating(true);
    setCreateBusy(true);
    try {
      const resolvedAutopilotExecutor: OrchestratorExecutorKind =
        createDraft.orchestratorProvider === "claude"
          ? "claude"
          : createDraft.orchestratorProvider === "codex"
            ? "codex"
            : createDraft.executorPolicy === "claude"
              ? "claude"
              : "codex";

      const created = await window.ade.missions.create({
        title: createDraft.title.trim() || undefined,
        prompt,
        laneId: resolvedLaneId || undefined,
        priority: createDraft.priority,
        executionMode: createDraft.executionMode,
        targetMachineId: createDraft.targetMachineId.trim() || undefined,
        plannerEngine: createDraft.plannerEngine,
        executorPolicy: createDraft.executorPolicy,
        allowPlanningQuestions: createDraft.allowPlanningQuestions,
        autostart: createDraft.autoStart,
        launchMode: "autopilot",
        autopilotExecutor: resolvedAutopilotExecutor
      });

      setCreateDraft((prev) => ({ ...prev, title: "", prompt: "", allowPlanningQuestions: false }));
      setSelectedMissionId(created.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      await loadMissionDetail(created.id);
      await loadOrchestratorGraph(created.id);
      setError(null);
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
      setTimeout(() => setLaunchAnimating(false), 600);
    }
  };

  const updateMissionStatus = async (status: MissionStatus) => {
    if (!selectedMission) return;
    setMissionActionBusy(true);
    try {
      const updated = await window.ade.missions.update({
        missionId: selectedMission.id,
        status,
        ...(status === "completed" ? { outcomeSummary: outcomeDraft.trim() || null } : {})
      });
      setSelectedMission(updated);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMissionActionBusy(false);
    }
  };

  const deleteMission = async () => {
    if (!selectedMission) return;
    const confirmed = window.confirm(`Delete mission "${selectedMission.title}" and all runtime history?`);
    if (!confirmed) return;
    setMissionActionBusy(true);
    try {
      await window.ade.missions.delete({ missionId: selectedMission.id });
      setSelectedMissionId(null);
      setSelectedMission(null);
      setRunGraph(null);
      await refreshMissionList({ preserveSelection: false, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMissionActionBusy(false);
    }
  };

  const saveOutcome = async () => {
    if (!selectedMission) return;
    setOutcomeBusy(true);
    try {
      const updated = await window.ade.missions.update({
        missionId: selectedMission.id,
        outcomeSummary: outcomeDraft.trim() || null
      });
      setSelectedMission(updated);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOutcomeBusy(false);
    }
  };

  const addArtifact = async () => {
    if (!selectedMission) return;
    if (!artifactDraft.title.trim()) {
      setError("Artifact title is required.");
      return;
    }

    setArtifactBusy(true);
    try {
      await window.ade.missions.addArtifact({
        missionId: selectedMission.id,
        artifactType: artifactDraft.artifactType,
        title: artifactDraft.title.trim(),
        uri: artifactDraft.uri.trim() || undefined,
        description: artifactDraft.description.trim() || undefined,
        laneId: selectedMission.laneId ?? undefined
      });

      setArtifactDraft((prev) => ({ ...prev, title: "", uri: "", description: "" }));
      await loadMissionDetail(selectedMission.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArtifactBusy(false);
    }
  };

  const addIntervention = async () => {
    if (!selectedMission) return;
    if (!interventionDraft.title.trim() || !interventionDraft.body.trim()) {
      setError("Intervention title and body are required.");
      return;
    }

    setInterventionBusy(true);
    try {
      await window.ade.missions.addIntervention({
        missionId: selectedMission.id,
        interventionType: interventionDraft.interventionType,
        title: interventionDraft.title.trim(),
        body: interventionDraft.body.trim(),
        laneId: selectedMission.laneId ?? undefined
      });

      setInterventionDraft((prev) => ({ ...prev, title: "", body: "" }));
      await loadMissionDetail(selectedMission.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInterventionBusy(false);
    }
  };

  const resolveIntervention = async (interventionId: string, status: "resolved" | "dismissed") => {
    if (!selectedMission) return;
    setInterventionBusy(true);
    try {
      await window.ade.missions.resolveIntervention({
        missionId: selectedMission.id,
        interventionId,
        status
      });
      await loadMissionDetail(selectedMission.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInterventionBusy(false);
    }
  };

  const startOrchestratorRun = async () => {
    if (!selectedMission) return;
    setRunBusy(true);
    try {
      const fallbackExecutor: OrchestratorExecutorKind =
        runAutopilotState.executor === "claude" || runAutopilotState.executor === "codex"
          ? (runAutopilotState.executor as OrchestratorExecutorKind)
          : "codex";
      const approveExistingPlan = selectedMission.status === "plan_review";
      await startRunForMission({
        missionId: selectedMission.id,
        laneId: selectedMission.laneId,
        executorKind: fallbackExecutor,
        approveExistingPlan
      });
      await loadOrchestratorGraph(selectedMission.id);
      await loadMissionDetail(selectedMission.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const resumeRun = async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.resumeRun({ runId: runGraph.run.id });
      if (selectedMission) {
        await loadOrchestratorGraph(selectedMission.id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const cancelRun = async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.cancelRun({ runId: runGraph.run.id, reason: "Canceled from Missions UI." });
      if (selectedMission) {
        await loadOrchestratorGraph(selectedMission.id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const openRunningTerminals = () => {
    navigate("/terminals?status=running");
  };

  const openArtifact = async (uri: string | null) => {
    const target = (uri ?? "").trim();
    if (!target) return;
    try {
      await window.ade.app.openExternal(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const jumpToLane = (laneId: string | null) => {
    if (!laneId) return;
    navigate(`/lanes?laneId=${encodeURIComponent(laneId)}`);
  };

  return (
    <LazyMotion features={domAnimation}>
      <div className="min-h-0 h-full overflow-auto p-4">
        <motion.div
          className="mx-auto flex w-full max-w-[1600px] flex-col gap-4"
          variants={staggerContainer}
          initial="initial"
          animate="animate"
        >
          {/* ════════════════════ HERO SECTION ════════════════════ */}
          <motion.section
            variants={staggerItem}
            className="relative overflow-hidden rounded border border-border/30 bg-gradient-to-br from-[--color-surface-raised] via-[--color-surface] to-[--color-muted]/50 p-5 shadow-card"
          >
            {/* Nebula gradient blobs */}
            <div
              className="absolute -right-20 -top-20 h-52 w-52 rounded-full blur-3xl"
              style={{
                background: "radial-gradient(circle, var(--color-accent) 0%, transparent 70%)",
                opacity: 0.12,
                animation: "ade-gradient-shift 15s ease-in-out infinite",
                backgroundSize: "200% 200%"
              }}
            />
            <div
              className="absolute -bottom-16 left-[20%] h-44 w-44 rounded-full blur-3xl"
              style={{
                background: "radial-gradient(circle, var(--color-secondary) 0%, transparent 70%)",
                opacity: 0.1,
                animation: "ade-gradient-shift 20s ease-in-out infinite",
                animationDelay: "3s",
                backgroundSize: "200% 200%"
              }}
            />

            {/* Floating geometric shapes */}
            {FLOATING_SHAPES.map((shape, i) => (
              <div
                key={i}
                className={cn("absolute ade-float text-accent/60", shape.x, shape.y, shape.opacity)}
                style={{ animationDelay: shape.delay }}
              >
                <shape.Icon className={shape.size} />
              </div>
            ))}

            <div className="relative flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-3">
                  <Rocket className="h-5 w-5 text-accent ade-float" />
                  <h1
                    className="text-2xl font-bold tracking-tight"
                    style={{
                      background: "linear-gradient(135deg, var(--color-accent), var(--color-fg), var(--color-accent))",
                      backgroundSize: "200% 100%",
                      WebkitBackgroundClip: "text",
                      backgroundClip: "text",
                      WebkitTextFillColor: "transparent",
                      animation: "ade-gradient-shift 8s ease-in-out infinite"
                    }}
                  >
                    MISSIONS
                  </h1>
                </div>
                <div className="mt-1.5 text-xs text-muted-fg max-w-md">
                  Launch plain-English tasks, track execution across lanes, and capture outcomes for PR handoff.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void refreshMissionList({ preserveSelection: true })}>
                  {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Refresh
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate("/prs")}>
                  <GitPullRequest className="h-3.5 w-3.5" />
                  Open PRs
                </Button>
              </div>
            </div>

            {/* Status counter badges */}
            <motion.div
              className="relative mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6"
              variants={staggerContainer}
              initial="initial"
              animate="animate"
            >
              {STATUS_COLUMNS.map((column) => (
                <motion.div
                  key={column.status}
                  variants={staggerItem}
                  className="group rounded border border-border/25 bg-card/50 px-3 py-2.5 shadow-card transition-all hover:shadow-card-hover hover:border-border/40"
                >
                  <div className="text-[10px] uppercase tracking-wide text-muted-fg/70">{column.label}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-lg font-semibold text-fg">{statusCount[column.status]}</span>
                    {statusCount[column.status] > 0 && (
                      <span
                        className="inline-block h-2 w-2 rounded-full ade-status-breathe"
                        style={{ backgroundColor: STATUS_ACCENT_COLORS[column.status] }}
                      />
                    )}
                  </div>
                  <div className="text-[10px] text-muted-fg/70">{column.hint}</div>
                </motion.div>
              ))}
            </motion.div>
          </motion.section>

          {/* ════════════════════ ERROR BANNER ════════════════════ */}
          <AnimatePresence>
            {error ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
              >
                {error}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* ════════════════════ LAUNCH MISSION FORM ════════════════════ */}
          <motion.section variants={staggerItem} className="relative">
            <motion.div
              className="rounded border border-border/30 shadow-card overflow-hidden"
              style={{
                background: "color-mix(in srgb, var(--color-card) 90%, transparent)"
              }}
            >
              {/* Toggle header */}
              <button
                type="button"
                onClick={() => setShowForm(!showForm)}
                className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-muted/20"
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <Plus className={cn("h-4 w-4 text-accent transition-transform duration-200", showForm && "rotate-45")} />
                  Launch Mission
                </div>
                <div className="text-[11px] text-muted-fg">
                  {showForm ? "Collapse" : "Expand to create"}
                </div>
              </button>

              <AnimatePresence>
                {showForm && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1, transition: { ...springGentle, opacity: easeOut150 } }}
                    exit={{ height: 0, opacity: 0, transition: { duration: 0.15 } }}
                    className="overflow-hidden"
                  >
                    <motion.div
                      className="px-4 pb-4"
                      variants={staggerContainer}
                      initial="initial"
                      animate="animate"
                    >
                      <motion.div variants={staggerItem} className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                        <label className="space-y-1 xl:col-span-2">
                          <div className="text-[11px] text-muted-fg">Mission title (optional)</div>
                          <input
                            value={createDraft.title}
                            onChange={(event) => setCreateDraft((prev) => ({ ...prev, title: event.target.value }))}
                            className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                            placeholder="Refactor auth middleware and open PR"
                          />
                        </label>

                        <label className="space-y-1">
                          <div className="text-[11px] text-muted-fg">Lane</div>
                          <select
                            value={createDraft.laneId}
                            onChange={(event) => setCreateDraft((prev) => ({ ...prev, laneId: event.target.value }))}
                            className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                          >
                            <option value="">Any lane</option>
                            {lanes.map((lane) => (
                              <option key={lane.id} value={lane.id}>
                                {lane.name}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="space-y-1">
                          <div className="text-[11px] text-muted-fg">Priority</div>
                          <select
                            value={createDraft.priority}
                            onChange={(event) => setCreateDraft((prev) => ({ ...prev, priority: event.target.value as MissionPriority }))}
                            className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                          >
                            <option value="urgent">urgent</option>
                            <option value="high">high</option>
                            <option value="normal">normal</option>
                            <option value="low">low</option>
                          </select>
                        </label>

                        <label className="space-y-1">
                          <div className="text-[11px] text-muted-fg">Execution target</div>
                          <select
                            value={createDraft.executionMode}
                            onChange={(event) => setCreateDraft((prev) => ({ ...prev, executionMode: event.target.value as "local" | "relay" }))}
                            className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                          >
                            <option value="local">local machine</option>
                            <option value="relay">relay machine (future)</option>
                          </select>
                        </label>
                      </motion.div>

                      <motion.div variants={staggerItem} className="mt-3 grid gap-3 md:grid-cols-[1fr_240px]">
                        <label className="space-y-1">
                          <div className="text-[11px] text-muted-fg">Mission prompt</div>
                          <textarea
                            value={createDraft.prompt}
                            onChange={(event) => setCreateDraft((prev) => ({ ...prev, prompt: event.target.value }))}
                            className="h-28 w-full resize-y rounded-lg border border-border/30 bg-muted/15 px-2 py-2 text-xs leading-relaxed text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                            placeholder="Example: prepare a PR-ready refactor for login flow, run tests, and summarize changes and risks."
                          />
                        </label>
                        <div className="space-y-2">
                          <label className="space-y-1">
                            <div className="text-[11px] text-muted-fg">Planner engine</div>
                            <select
                              value={createDraft.plannerEngine}
                              onChange={(event) =>
                                setCreateDraft((prev) => ({
                                  ...prev,
                                  plannerEngine: event.target.value as MissionPlannerEngine
                                }))
                              }
                              className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                            >
                              {PLANNER_ENGINES.map((entry) => (
                                <option key={entry.value} value={entry.value}>
                                  {entry.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-1">
                            <div className="text-[11px] text-muted-fg">Executor policy</div>
                            <select
                              value={createDraft.executorPolicy}
                              onChange={(event) =>
                                setCreateDraft((prev) => ({
                                  ...prev,
                                  executorPolicy: event.target.value as MissionExecutorPolicy
                                }))
                              }
                              className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                            >
                              {EXECUTOR_POLICIES.map((entry) => (
                                <option key={entry.value} value={entry.value}>
                                  {entry.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="rounded-lg border border-border/25 bg-muted/20 p-2 text-[11px] text-muted-fg">
                            {EXECUTOR_POLICIES.find((entry) => entry.value === createDraft.executorPolicy)?.description ??
                              "ADE will route execution deterministically by policy."}
                          </div>
                          <label className="space-y-1">
                            <div className="text-[11px] text-muted-fg">Orchestrator provider</div>
                            <select
                              value={createDraft.orchestratorProvider}
                              onChange={(event) =>
                                setCreateDraft((prev) => ({
                                  ...prev,
                                  orchestratorProvider: event.target.value as "claude" | "codex" | "auto"
                                }))
                              }
                              className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                            >
                              <option value="auto">Auto</option>
                              <option value="claude">Claude (recommended)</option>
                              <option value="codex">Codex</option>
                            </select>
                          </label>
                          <label className="space-y-1">
                            <div className="text-[11px] text-muted-fg">Planner mode</div>
                            <select
                              value={createDraft.plannerMode}
                              onChange={(event) =>
                                setCreateDraft((prev) => ({
                                  ...prev,
                                  plannerMode: event.target.value as "ai" | "deterministic" | "auto"
                                }))
                              }
                              className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                            >
                              <option value="auto">Auto</option>
                              <option value="ai">AI Planning</option>
                              <option value="deterministic">Deterministic</option>
                            </select>
                          </label>
                          <label className="space-y-1">
                            <div className="text-[11px] text-muted-fg">Target machine id (optional)</div>
                            <input
                              value={createDraft.targetMachineId}
                              onChange={(event) => setCreateDraft((prev) => ({ ...prev, targetMachineId: event.target.value }))}
                              className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                              placeholder="machine-nyc-01"
                            />
                          </label>
                          <label className="flex items-center gap-2 rounded-lg border border-border/25 bg-muted/20 px-2 py-1.5 text-[11px] text-fg">
                            <input
                              type="checkbox"
                              checked={createDraft.autoStart}
                              onChange={(event) => setCreateDraft((prev) => ({ ...prev, autoStart: event.target.checked }))}
                              className="h-3.5 w-3.5"
                            />
                            Start mission immediately after creation
                          </label>
                          <label className="flex items-center gap-2 rounded-lg border border-border/25 bg-muted/20 px-2 py-1.5 text-[11px] text-fg">
                            <input
                              type="checkbox"
                              checked={createDraft.allowPlanningQuestions}
                              onChange={(event) =>
                                setCreateDraft((prev) => ({ ...prev, allowPlanningQuestions: event.target.checked }))
                              }
                              className="h-3.5 w-3.5"
                            />
                            Allow planner follow-up questions during planning only
                          </label>
                          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}>
                            <Button
                              variant="primary"
                              className="w-full ade-btn-shimmer"
                              onClick={() => void launchMission()}
                              disabled={createBusy}
                            >
                              {createBusy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Rocket className={cn("h-4 w-4 transition-transform", launchAnimating && "-translate-y-1")} />
                              )}
                              {createDraft.autoStart ? "Launch + Start mission" : "Launch mission"}
                            </Button>
                          </motion.div>
                          <div className="rounded-lg border border-border/25 bg-muted/20 p-2 text-[11px] text-muted-fg">
                            Launch can auto-start orchestrator runs and attach tracked terminal sessions in autopilot mode.
                          </div>
                        </div>
                      </motion.div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.section>

          {/* ════════════════════ STATUS BOARD + DETAIL ════════════════════ */}
          {loading ? (
            <motion.div
              variants={staggerItem}
              className="rounded border border-border/25 bg-card/55 p-6 text-sm text-muted-fg"
            >
              <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
              Loading missions...
            </motion.div>
          ) : missions.length === 0 ? (
            <motion.div variants={staggerItem}>
              <EmptyState
                title="No missions yet"
                description="Launch your first mission from the intake form to start automatic execution tracking with input requests only when needed."
              />
            </motion.div>
          ) : (
            <div className="space-y-4">
              {/* ─── KANBAN BOARD ─── */}
              <motion.section
                variants={staggerItem}
                className="rounded border border-border/30 bg-card/55 p-3 shadow-card"
              >
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <Route className="h-4 w-4 text-accent" />
                    Mission Lanes
                  </div>
                  <div className="text-[11px] text-muted-fg">Select a mission for details</div>
                </div>

                <div className="overflow-x-auto pb-1">
                  <motion.div
                    className="flex min-w-max gap-3"
                    variants={staggerContainerSlow}
                    initial="initial"
                    animate="animate"
                  >
                    {STATUS_COLUMNS.map((column) => {
                    const inColumn = missions.filter((mission) => mission.status === column.status);
                    return (
                      <motion.div
                        key={column.status}
                        variants={staggerItem}
                        className="w-[260px] shrink-0 rounded border border-border/25 bg-card/45 overflow-hidden"
                      >
                          {/* Column header with accent bar */}
                          <div
                            className="border-b border-border/20 px-2 py-2"
                            style={{ borderTop: `4px solid ${STATUS_ACCENT_COLORS[column.status]}` }}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="text-xs font-semibold text-fg">{column.label}</div>
                                <div className="text-[10px] text-muted-fg">{column.hint}</div>
                              </div>
                              <Chip className={cn("border px-1.5 py-0.5 text-[10px] ade-status-breathe", statusTone(column.status))}>
                                {inColumn.length}
                              </Chip>
                            </div>
                          </div>

                          <div className="space-y-2 p-2">
                            {inColumn.length === 0 ? (
                              <div className="rounded-lg border border-dashed border-border/25 bg-muted/10 px-2 py-3 text-center text-[11px] text-muted-fg ade-status-breathe">
                                No missions
                              </div>
                            ) : (
                              <motion.div
                                className="space-y-2"
                                variants={staggerContainer}
                                initial="initial"
                                animate="animate"
                              >
                                {inColumn.map((mission) => {
                                  const active = mission.id === selectedMissionId;
                                  const progressPct = mission.totalSteps > 0
                                    ? Math.round((mission.completedSteps / mission.totalSteps) * 100)
                                    : 0;
                                  return (
                                    <motion.button
                                      key={mission.id}
                                      variants={staggerItem}
                                      whileHover={{ y: -2, boxShadow: "var(--shadow-card-hover)" }}
                                      whileTap={{ scale: 0.98 }}
                                      type="button"
                                      onClick={() => setSelectedMissionId(mission.id)}
                                      className={cn(
                                        "w-full rounded-lg border-l-[3px] border border-border/25 px-2 py-2 text-left transition-all",
                                        statusBorderColor(mission.status),
                                        active
                                          ? "border-r-accent/50 border-t-accent/50 border-b-accent/50 bg-accent/10 shadow-card-hover"
                                          : "bg-card/55 hover:bg-muted/35"
                                      )}
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="truncate text-xs font-semibold text-fg">{mission.title}</div>
                                          <div className="mt-0.5 truncate text-[10px] text-muted-fg">
                                            {mission.laneName ?? "Any lane"}
                                          </div>
                                        </div>
                                        <Chip
                                          className={cn(
                                            "shrink-0 border px-1.5 py-0.5 text-[10px]",
                                            priorityTone(mission.priority),
                                            mission.priority === "urgent" && "ade-glow-pulse",
                                            mission.priority === "high" && "ade-status-breathe"
                                          )}
                                        >
                                          {mission.priority}
                                        </Chip>
                                      </div>

                                      {/* Progress bar */}
                                      {mission.totalSteps > 0 && mission.status === "in_progress" && (
                                        <div className="mt-2 h-1.5 w-full rounded-full bg-muted/30 overflow-hidden">
                                          <div
                                            className="h-full rounded-full transition-all duration-500"
                                            style={{
                                              width: `${progressPct}%`,
                                              background: `linear-gradient(90deg, ${STATUS_ACCENT_COLORS.in_progress}, ${STATUS_ACCENT_COLORS.completed})`,
                                              backgroundSize: "200% 100%",
                                              animation: "ade-gradient-shift 2s linear infinite"
                                            }}
                                          />
                                        </div>
                                      )}

                                      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-fg">
                                        <span>{relativeWhen(mission.updatedAt)}</span>
                                        <span>
                                          {mission.completedSteps}/{mission.totalSteps} steps
                                        </span>
                                      </div>
                                      {mission.openInterventions > 0 ? (
                                        <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-300">
                                          <TriangleAlert className="h-3 w-3" />
                                          {mission.openInterventions} input request{mission.openInterventions === 1 ? "" : "s"}
                                        </div>
                                      ) : null}
                                    </motion.button>
                                  );
                                })}
                              </motion.div>
                            )}
                          </div>
                      </motion.div>
                    );
                  })}
                  </motion.div>
                </div>
              </motion.section>

              {/* ─── DETAIL PANEL ─── */}
              <AnimatePresence mode="wait">
                <motion.section
                  key={selectedMissionId ?? "empty"}
                  variants={slideInRight}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="rounded border border-border/30 bg-card/55 p-3 shadow-card"
                >
                  {!selectedMissionSummary ? (
                    <EmptyState title="Select a mission" description="Choose one from the board to view details." />
                  ) : detailBusy || !selectedMission || selectedMission.id !== selectedMissionSummary.id ? (
                    <div className="rounded border border-border/20 bg-card/40 p-4 text-xs text-muted-fg">
                      <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1.5" />
                      Loading mission detail...
                    </div>
                  ) : (
                    <motion.div
                      className="space-y-3"
                      variants={staggerContainer}
                      initial="initial"
                      animate="animate"
                    >
                      {runtimeLaneStrip.length > 0 ? (
                        <motion.div variants={staggerItem} className="rounded border border-border/30 bg-card/50 p-3">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-fg">Active Lanes</div>
                          <div className="mt-2 overflow-x-auto">
                            <div className="flex min-w-max gap-2">
                              {runtimeLaneStrip.map((entry) => (
                                <button
                                  key={entry.laneId}
                                  type="button"
                                  onClick={() => jumpToLane(entry.laneId)}
                                  className="rounded-lg border border-border/25 bg-muted/10 px-2 py-1.5 text-left text-[10px] text-muted-fg transition-colors hover:border-accent/40 hover:bg-accent/5"
                                >
                                  <div className="truncate text-fg">{entry.laneName}</div>
                                  <div className="mt-0.5">
                                    steps {entry.stepCount} · running {entry.runningCount}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        </motion.div>
                      ) : null}

                      <motion.div variants={staggerItem} className="rounded border border-accent/30 bg-accent/5 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="text-xs font-semibold text-fg">Mission Control</div>
                            <div className="mt-1 text-[11px] text-muted-fg">
                              {selectedMission.status === "intervention_required"
                                ? `Needs input. ${openInterventions.length} input request${openInterventions.length === 1 ? "" : "s"} must be resolved.`
                                : selectedMission.status === "plan_review"
                                  ? "Mission plan is ready for review. Approve before execution begins."
                                  : selectedMission.status === "planning"
                                    ? "Mission planning is in progress. Step decomposition and routing are being prepared."
                                : selectedMission.status === "in_progress"
                                  ? "Mission is in progress. Runtime execution details are in Orchestrator Runtime below."
                                  : selectedMission.status === "queued"
                                    ? "Mission is queued and has not started runtime execution yet."
                                    : selectedMission.status === "completed"
                                      ? "Mission is marked completed. You can move it back to queued if you want to re-run."
                                      : selectedMission.status === "failed"
                                        ? "Mission failed. Check input requests and timeline for recovery context."
                                        : "Mission is canceled. Requeue to run again."}
                            </div>
                          </div>
                          <div className="rounded border border-border/30 bg-card/40 px-2 py-1 text-[10px] text-muted-fg">
                            run attempts: {runGraph?.attempts.length ?? 0} · running: {runningAttemptCount}
                          </div>
                        </div>
                        <div className="mt-2 rounded border border-border/20 bg-card/35 px-2 py-1.5 text-[10px] text-muted-fg">
                          planner: {plannerSummary?.strategy ?? "deterministic_split"} ({plannerSummary?.version ?? "ade.missionPlanner.v1"}) ·
                          run mode: {runAutopilotState.enabled ? `autopilot${runAutopilotState.executor ? `/${runAutopilotState.executor}` : ""}` : "manual"}
                        </div>
                        {plannerRunSummary ? (
                          <div className="mt-2 rounded border border-border/20 bg-card/35 px-2 py-1.5 text-[10px] text-muted-fg">
                            planner engine: {plannerRunSummary.requestedEngine} to {plannerRunSummary.resolvedEngine}
                            {plannerRunSummary.degraded ? ` · degraded (${plannerRunSummary.reasonCode ?? "unknown_reason"})` : " · validated"}
                            {plannerRunSummary.normalizedPlanHash ? ` · plan ${shortId(plannerRunSummary.normalizedPlanHash, 10)}` : ""}
                          </div>
                        ) : null}
                        {runGraph ? (
                          <div className="mt-2 rounded border border-border/20 bg-card/35 px-2 py-1.5 text-[10px] text-muted-fg">
                            lanes touched: {runtimeLaneIds.length ? runtimeLaneIds.map((id) => shortId(id)).join(", ") : "none"} · snapshots:{" "}
                            {runGraph.contextSnapshots.length} · handoffs: {runGraph.handoffs.length} · claims: {runGraph.claims.length}
                          </div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={openRunningTerminals}>
                            <Terminal className="h-3.5 w-3.5" />
                            View running terminals
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => navigate("/settings")}>
                            Context inventory
                          </Button>
                        </div>
                        {sessionAttempts.length > 0 ? (
                          <div className="mt-2 space-y-2 rounded border border-border/20 bg-card/35 p-2 text-[10px] text-muted-fg">
                            <div className="text-fg">Active/linked executor sessions</div>
                            {sessionAttempts.slice(0, 6).map((entry) => {
                              const tail = liveSessionTailById[entry.sessionId] ?? "";
                              return (
                                <div key={entry.attemptId} className="rounded border border-border/20 bg-muted/10 px-2 py-1.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="truncate">
                                      {entry.executorKind} · {entry.stepTitle} · session {shortId(entry.sessionId)} · {entry.status}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={() =>
                                        navigate(
                                          `/lanes?sessionId=${encodeURIComponent(entry.sessionId)}&inspectorTab=terminals`
                                        )
                                      }
                                    >
                                      Open
                                    </Button>
                                  </div>
                                  {entry.status === "running" ? (
                                    <pre className="mt-1 max-h-28 overflow-auto rounded border border-border/15 bg-card/40 p-1.5 font-mono text-[10px] leading-relaxed text-muted-fg">
                                      {tail.trim().length > 0 ? tail : "Waiting for terminal output..."}
                                    </pre>
                                  ) : null}
                                </div>
                              );
                            })}
                            {liveSessionAttempts.length > 0 ? (
                              <div className="text-[10px] text-muted-fg">
                                Live streams: {liveSessionAttempts.length} running session{liveSessionAttempts.length === 1 ? "" : "s"} · refreshes every ~2.5s
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="mt-2 rounded border border-dashed border-border/25 bg-card/30 px-2 py-1.5 text-[10px] text-muted-fg">
                            No executor sessions attached yet. Start a run in autopilot mode to spawn tracked sessions.
                          </div>
                        )}
                      </motion.div>

                      {/* ── Info Card ── */}
                      <motion.div variants={staggerItem} className="rounded border border-border/25 bg-card/65 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("info")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <span className="text-xs font-semibold text-fg">Mission Prompt & Metadata</span>
                          <span className="text-[10px] text-muted-fg">{expandedSections.info ? "Collapse" : "Expand"}</span>
                        </button>
                        <AnimatePresence>
                          {expandedSections.info && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={easeOut150}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-fg">{selectedMission.title}</div>
                                    <div className="mt-1 text-[11px] text-muted-fg">{selectedMission.prompt}</div>
                                  </div>
                                  <Chip className={cn("border px-2 py-0.5 text-[10px]", statusTone(selectedMission.status))}>
                                    {selectedMission.status}
                                  </Chip>
                                </div>

                                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-muted-fg">
                                  <div className="rounded-lg border border-border/20 bg-muted/15 px-2 py-1.5">
                                    <span className="text-[10px] uppercase tracking-wide">Lane</span>
                                    <div className="mt-0.5 text-fg">{selectedMission.laneName ?? "Any lane"}</div>
                                  </div>
                                  <div className="rounded-lg border border-border/20 bg-muted/15 px-2 py-1.5">
                                    <span className="text-[10px] uppercase tracking-wide">Execution</span>
                                    <div className="mt-0.5 text-fg">
                                      {selectedMission.executionMode}
                                      {selectedMission.targetMachineId ? ` · ${selectedMission.targetMachineId}` : ""}
                                    </div>
                                  </div>
                                  <div className="rounded-lg border border-border/20 bg-muted/15 px-2 py-1.5">
                                    <span className="text-[10px] uppercase tracking-wide">Created</span>
                                    <div className="mt-0.5 text-fg">{formatWhen(selectedMission.createdAt)}</div>
                                  </div>
                                  <div className="rounded-lg border border-border/20 bg-muted/15 px-2 py-1.5">
                                    <span className="text-[10px] uppercase tracking-wide">Completed</span>
                                    <div className="mt-0.5 text-fg">{formatWhen(selectedMission.completedAt)}</div>
                                  </div>
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                  {(selectedMission.status === "failed" ||
                                    selectedMission.status === "completed" ||
                                    selectedMission.status === "canceled") ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      title="Move mission back to queued so it can be started again."
                                      disabled={missionActionBusy}
                                      onClick={() => void updateMissionStatus("queued")}
                                    >
                                      {missionActionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                      Move to queued
                                    </Button>
                                  ) : null}

                                  <Button size="sm" variant="ghost" onClick={() => jumpToLane(selectedMission.laneId)} disabled={!selectedMission.laneId}>
                                    <Waypoints className="h-3.5 w-3.5" />
                                    Open lane workspace
                                  </Button>
                                  <Button size="sm" variant="ghost" disabled={missionActionBusy} onClick={() => void deleteMission()}>
                                    Delete mission
                                  </Button>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Outcome Summary ── */}
                      <motion.div variants={staggerItem} className="rounded border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("outcome")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                            <CheckCircle2 className="h-3.5 w-3.5 text-accent" />
                            Outcome / Operator Notes
                          </div>
                          <span className="text-[10px] text-muted-fg">{expandedSections.outcome ? "Collapse" : "Expand"}</span>
                        </button>
                        <AnimatePresence>
                          {expandedSections.outcome && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={easeOut150}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3">
                                <textarea
                                  value={outcomeDraft}
                                  onChange={(event) => setOutcomeDraft(event.target.value)}
                                  className="h-20 w-full resize-y rounded-lg border border-border/30 bg-muted/15 px-2 py-1.5 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                                  placeholder="Optional. Capture what shipped, validations run, follow-ups, or handoff notes."
                                />
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <Button size="sm" variant="outline" disabled={outcomeBusy} onClick={() => void saveOutcome()}>
                                    {outcomeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />}
                                    Save notes
                                  </Button>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Mission Plan Steps (vertical timeline) ── */}
                      <motion.div variants={staggerItem} className="rounded border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("steps")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <span className="text-xs font-semibold text-fg">Mission Plan Steps</span>
                          <span className="text-[10px] text-muted-fg">
                            {selectedMission.steps.length} step{selectedMission.steps.length !== 1 ? "s" : ""}
                          </span>
                        </button>
                        <AnimatePresence>
                          {expandedSections.steps && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={easeOut150}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3">
                                <div className="mb-2 rounded border border-border/20 bg-card/35 px-2 py-1.5 text-[10px] text-muted-fg">
                                  These are planning steps generated from your mission prompt. Runtime execution state lives in{" "}
                                  <span className="text-fg">Orchestrator Runtime</span>.
                                </div>
                                <div className="relative">
                                  {/* Vertical timeline line */}
                                  {selectedMission.steps.length > 1 && (
                                    <div className="absolute left-[7px] top-3 bottom-3 w-[2px] bg-border/30" />
                                  )}
                                  <div className="space-y-3">
                                    {selectedMission.steps.map((step) => {
                                      const dependencyIndices = Array.isArray(step.metadata?.dependencyIndices)
                                        ? step.metadata.dependencyIndices
                                            .map((value) => Number(value))
                                            .filter((value) => Number.isFinite(value))
                                            .map((value) => Math.floor(value) + 1)
                                        : [];
                                      const doneCriteria =
                                        typeof step.metadata?.doneCriteria === "string" ? step.metadata.doneCriteria : null;
                                      const joinPolicy =
                                        typeof step.metadata?.joinPolicy === "string" ? step.metadata.joinPolicy : null;
                                      const stepType = typeof step.metadata?.stepType === "string" ? step.metadata.stepType : step.kind;

                                      return (
                                        <div key={step.id} className="relative flex gap-3">
                                          <div className="relative z-10 mt-1 flex-shrink-0">
                                            <div
                                              className={cn(
                                                "h-4 w-4 rounded-full border-2 border-card/60",
                                                stepDotColor(step.status),
                                                step.status === "running" && "ade-glow-pulse"
                                              )}
                                            />
                                          </div>
                                          <div className="flex-1 rounded-lg border border-border/20 bg-muted/10 px-2 py-2">
                                            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-fg">
                                              {stepType}
                                              {joinPolicy ? ` · join=${joinPolicy}` : ""}
                                              {dependencyIndices.length ? ` · depends on step ${dependencyIndices.join(", ")}` : ""}
                                            </div>
                                            <div className="mb-1 text-[10px] text-muted-fg">{step.detail || "Deterministic planner step."}</div>
                                            {doneCriteria ? (
                                              <div className="mb-1 rounded border border-border/15 bg-card/35 px-1.5 py-1 text-[10px] text-muted-fg">
                                                done when: {doneCriteria}
                                              </div>
                                            ) : null}
                                            <div className="flex items-start justify-between gap-2">
                                              <div className="min-w-0">
                                                <div className="truncate text-xs font-medium text-fg">
                                                  {step.index + 1}. {step.title}
                                                </div>
                                              </div>
                                              <Chip className={cn("border px-1.5 py-0.5 text-[10px]", stepTone(step.status))}>{step.status}</Chip>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Orchestrator Runtime ── */}
                      <motion.div variants={staggerItem} className="rounded border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("orchestrator")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                            <Route className="h-3.5 w-3.5 text-accent" />
                            Orchestrator Runtime
                          </div>
                          <span className="text-[10px] text-muted-fg">
                            {runGraph ? `run ${runGraph.run.status}` : "no run"}
                          </span>
                        </button>
                        <AnimatePresence>
                          {expandedSections.orchestrator && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={easeOut150}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3 space-y-2">
                                <div className="rounded-lg border border-border/20 bg-card/35 px-2 py-2 text-[10px] text-muted-fg">
                                  Autopilot is the default runtime mode. ADE schedules runnable steps automatically from the deterministic
                                  plan and only requests intervention when explicitly blocked.
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <Button size="sm" variant="outline" disabled={runBusy || !canStartOrRerun} onClick={() => void startOrchestratorRun()}>
                                    {runBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                                    {runGraph
                                      ? "Rerun mission"
                                      : selectedMission.status === "plan_review"
                                        ? "Approve plan & start"
                                        : "Start run"}
                                  </Button>
                                  <Button size="sm" variant="ghost" disabled={runBusy || !canCancelRun} onClick={() => void cancelRun()}>
                                    Cancel
                                  </Button>
                                  <Button size="sm" variant="ghost" disabled={runBusy || !canResumeRun} onClick={() => void resumeRun()}>
                                    Resume
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={openRunningTerminals}>
                                    View terminals
                                  </Button>
                                </div>
                                {!runGraph ? (
                                  <div className="rounded-lg border border-dashed border-border/25 bg-muted/10 px-2 py-3 text-center text-[11px] text-muted-fg">
                                    No orchestrator run yet for this mission.
                                  </div>
                                ) : (
                                  <div className="space-y-2">
                                    <div className="rounded-lg border border-border/20 bg-muted/10 px-2 py-2 text-[11px] text-muted-fg">
                                      <div>run: {runGraph.run.id}</div>
                                      <div>status: {runGraph.run.status} · profile: {runGraph.run.contextProfile}</div>
                                      <div>steps: {runGraph.steps.length} · attempts: {runGraph.attempts.length} · claims: {runGraph.claims.length}</div>
                                    </div>
                                    {runGraph.attempts.length === 0 ? (
                                      <div className="rounded border border-dashed border-border/20 bg-card/30 px-2 py-2 text-[10px] text-muted-fg">
                                        No attempts started yet.
                                      </div>
                                    ) : null}
                                    <div className="space-y-2">
                                      {runGraph.steps
                                        .slice()
                                        .sort((a, b) => a.stepIndex - b.stepIndex)
                                        .map((step) => {
                                          const attempts = attemptsByStep.get(step.id) ?? [];
                                          const latestAttempt = attempts[0] ?? null;
                                          return (
                                            <div key={step.id} className="rounded-lg border border-border/20 bg-muted/10 px-2 py-2">
                                              <div className="flex items-center justify-between gap-2">
                                                <div className="text-[11px] text-fg">
                                                  {step.stepIndex + 1}. {step.title}
                                                </div>
                                                <Chip className={cn("border px-1.5 py-0.5 text-[10px]", step.status === "succeeded" ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" : step.status === "failed" ? "text-red-300 border-red-500/40 bg-red-500/10" : step.status === "running" ? "text-violet-300 border-violet-500/40 bg-violet-500/10" : step.status === "blocked" ? "text-amber-300 border-amber-500/40 bg-amber-500/10" : "text-sky-300 border-sky-500/40 bg-sky-500/10")}>
                                                  {step.status}
                                                </Chip>
                                              </div>
                                              <div className="mt-1 text-[10px] text-muted-fg">
                                                attempts: {attempts.length}
                                                {latestAttempt ? ` · latest #${latestAttempt.attemptNumber} (${latestAttempt.status})` : ""}
                                              </div>
                                              {latestAttempt ? (
                                                <div className="mt-1 text-[10px] text-muted-fg">
                                                  executor: {latestAttempt.executorKind}
                                                  {latestAttempt.executorSessionId
                                                    ? ` · session ${shortId(latestAttempt.executorSessionId)}`
                                                    : " · session not attached"}
                                                </div>
                                              ) : null}
                                              {latestAttempt?.executorSessionId ? (
                                                <div className="mt-2">
                                                  <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 px-2 text-[11px]"
                                                    onClick={() =>
                                                      navigate(
                                                        `/lanes?sessionId=${encodeURIComponent(latestAttempt.executorSessionId!)}&inspectorTab=terminals`
                                                      )
                                                    }
                                                  >
                                                    Open terminal
                                                  </Button>
                                                </div>
                                              ) : null}
                                            </div>
                                          );
                                        })}
                                    </div>
                                    <div className="rounded-lg border border-border/20 bg-muted/10 px-2 py-2 text-[10px] text-muted-fg">
                                      <div className="font-medium text-fg">Timeline</div>
                                      {runGraph.timeline.length === 0 ? (
                                        <div className="mt-1">No timeline events yet.</div>
                                      ) : (
                                        runGraph.timeline.slice(0, 6).map((entry) => (
                                          <div key={entry.id} className="mt-1">
                                            {entry.createdAt} · {entry.eventType} · {entry.reason}
                                          </div>
                                        ))
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Input Requests ── */}
                      <motion.div variants={staggerItem} className="rounded border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("interventions")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
                            Input Requests
                          </div>
                          <span className="text-[10px] text-muted-fg">
                            {selectedMission.interventions.filter((i) => i.status === "open").length} open
                          </span>
                        </button>
                        <AnimatePresence>
                          {expandedSections.interventions && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={easeOut150}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3 space-y-2">
                                {selectedMission.interventions.length === 0 ? (
                                  <div className="rounded-lg border border-dashed border-border/25 bg-muted/10 px-2 py-3 text-center text-[11px] text-muted-fg">
                                    No input requests.
                                  </div>
                                ) : (
                                  selectedMission.interventions.map((intervention) => (
                                    <div
                                      key={intervention.id}
                                      className={cn(
                                        "rounded-lg border border-border/20 bg-muted/10 px-2 py-2 border-l-[3px]",
                                        intervention.status === "open" ? "border-l-amber-400" : "border-l-emerald-400"
                                      )}
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="truncate text-xs font-medium text-fg">{intervention.title}</div>
                                          <div className="mt-0.5 text-[10px] text-muted-fg">{intervention.body}</div>
                                        </div>
                                        <Chip className={cn("border px-1.5 py-0.5 text-[10px]", interventionTone(intervention.status))}>
                                          {intervention.status}
                                        </Chip>
                                      </div>
                                      {intervention.status === "open" ? (
                                        <div className="mt-2 flex gap-1.5">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 px-2 text-[11px]"
                                            disabled={interventionBusy}
                                            onClick={() => void resolveIntervention(intervention.id, "resolved")}
                                          >
                                            Resolve
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 px-2 text-[11px]"
                                            disabled={interventionBusy}
                                            onClick={() => void resolveIntervention(intervention.id, "dismissed")}
                                          >
                                            Dismiss
                                          </Button>
                                        </div>
                                      ) : null}
                                    </div>
                                  ))
                                )}

                                <div className="mt-3 rounded-lg border border-border/20 bg-card/50 p-2">
                                  <div className="text-[11px] font-medium text-fg">Add input request</div>
                                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                                    <select
                                      value={interventionDraft.interventionType}
                                      onChange={(event) =>
                                        setInterventionDraft((prev) => ({
                                          ...prev,
                                          interventionType: event.target.value as InterventionDraft["interventionType"]
                                        }))
                                      }
                                      className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                                    >
                                      <option value="manual_input">manual_input</option>
                                      <option value="approval_required">approval_required</option>
                                      <option value="conflict">conflict</option>
                                      <option value="policy_block">policy_block</option>
                                      <option value="failed_step">failed_step</option>
                                    </select>
                                    <input
                                      value={interventionDraft.title}
                                      onChange={(event) => setInterventionDraft((prev) => ({ ...prev, title: event.target.value }))}
                                      className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                                      placeholder="Intervention title"
                                    />
                                  </div>
                                  <textarea
                                    value={interventionDraft.body}
                                    onChange={(event) => setInterventionDraft((prev) => ({ ...prev, body: event.target.value }))}
                                    className="mt-2 h-16 w-full rounded-lg border border-border/30 bg-muted/15 px-2 py-1.5 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                                    placeholder="Describe the decision or input needed."
                                  />
                                  <div className="mt-2">
                                    <Button size="sm" variant="outline" disabled={interventionBusy} onClick={() => void addIntervention()}>
                                      {interventionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                                      Add input request
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Artifacts & PRs ── */}
                      <motion.div variants={staggerItem} className="rounded border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("artifacts")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                            <GitPullRequest className="h-3.5 w-3.5 text-accent" />
                            Artifacts & PRs
                          </div>
                          <span className="text-[10px] text-muted-fg">{selectedMission.artifacts.length} recorded</span>
                        </button>
                        <AnimatePresence>
                          {expandedSections.artifacts && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={easeOut150}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3">
                                <div className="space-y-2">
                                  {selectedMission.artifacts.length === 0 ? (
                                    <div className="rounded-lg border border-dashed border-border/25 bg-muted/10 px-2 py-3 text-center text-[11px] text-muted-fg">
                                      No artifacts recorded yet.
                                    </div>
                                  ) : (
                                    selectedMission.artifacts.map((artifact) => (
                                      <div key={artifact.id} className="rounded-lg border border-border/20 bg-muted/10 px-2 py-2">
                                        <div className="flex items-start justify-between gap-2">
                                          <div className="min-w-0">
                                            <div className="truncate text-xs font-medium text-fg">{artifact.title}</div>
                                            <div className="mt-0.5 text-[10px] text-muted-fg">{artifact.description || artifact.uri || "No details"}</div>
                                          </div>
                                          <Chip className="border border-border/30 px-1.5 py-0.5 text-[10px]">{artifact.artifactType}</Chip>
                                        </div>
                                        {artifact.uri ? (
                                          <div className="mt-2">
                                            <button
                                              type="button"
                                              className="group inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
                                              onClick={() => void openArtifact(artifact.uri)}
                                            >
                                              <Link2 className="h-3 w-3" />
                                              <span className="relative">
                                                {artifact.artifactType === "pr" ? "Open PR" : "Open link"}
                                                <span className="absolute bottom-0 left-0 w-0 h-[1px] bg-accent transition-all duration-200 group-hover:w-full" />
                                              </span>
                                            </button>
                                          </div>
                                        ) : null}
                                      </div>
                                    ))
                                  )}
                                </div>

                                <div className="mt-3 rounded-lg border border-border/20 bg-card/50 p-2">
                                  <div className="text-[11px] font-medium text-fg">Add artifact</div>
                                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                                    <select
                                      value={artifactDraft.artifactType}
                                      onChange={(event) =>
                                        setArtifactDraft((prev) => ({
                                          ...prev,
                                          artifactType: event.target.value as ArtifactDraft["artifactType"]
                                        }))
                                      }
                                      className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                                    >
                                      <option value="pr">pr</option>
                                      <option value="link">link</option>
                                      <option value="summary">summary</option>
                                      <option value="note">note</option>
                                      <option value="patch">patch</option>
                                    </select>
                                    <input
                                      value={artifactDraft.title}
                                      onChange={(event) => setArtifactDraft((prev) => ({ ...prev, title: event.target.value }))}
                                      className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                                      placeholder="Artifact title"
                                    />
                                  </div>
                                  <input
                                    value={artifactDraft.uri}
                                    onChange={(event) => setArtifactDraft((prev) => ({ ...prev, uri: event.target.value }))}
                                    className="mt-2 h-8 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                                    placeholder="https://github.com/.../pull/123"
                                  />
                                  <textarea
                                    value={artifactDraft.description}
                                    onChange={(event) => setArtifactDraft((prev) => ({ ...prev, description: event.target.value }))}
                                    className="mt-2 h-14 w-full rounded-lg border border-border/30 bg-muted/15 px-2 py-1.5 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                                    placeholder="Optional notes about this artifact"
                                  />
                                  <div className="mt-2 flex gap-2">
                                    <Button size="sm" variant="outline" disabled={artifactBusy} onClick={() => void addArtifact()}>
                                      {artifactBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                                      Add artifact
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => navigate("/prs")}>
                                      <GitPullRequest className="h-3.5 w-3.5" />
                                      View PR lane
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Mission Timeline ── */}
                      <motion.div variants={staggerItem} className="rounded border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("timeline")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <span className="text-xs font-semibold text-fg">Mission Timeline</span>
                          <span className="text-[10px] text-muted-fg">
                            {selectedMission.events.length} event{selectedMission.events.length !== 1 ? "s" : ""}
                          </span>
                        </button>
                        <AnimatePresence>
                          {expandedSections.timeline && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={easeOut150}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3">
                                <div className="max-h-56 space-y-1 overflow-auto pr-1">
                                  {selectedMission.events.length === 0 ? (
                                    <div className="text-[11px] text-muted-fg">No events yet.</div>
                                  ) : (
                                    selectedMission.events.map((event) => (
                                      <div key={event.id} className="rounded-lg border border-border/15 bg-muted/10 px-2 py-1.5">
                                        <div className="flex items-center justify-between gap-2">
                                          <div className="truncate text-[11px] font-medium text-fg">{event.summary}</div>
                                          <div className="text-[10px] text-muted-fg">{relativeWhen(event.createdAt)}</div>
                                        </div>
                                        <div className="mt-0.5 text-[10px] text-muted-fg">
                                          {event.eventType} · {event.actor}
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </motion.div>
                  )}
                </motion.section>
              </AnimatePresence>
            </div>
          )}
        </motion.div>
      </div>
    </LazyMotion>
  );
}
