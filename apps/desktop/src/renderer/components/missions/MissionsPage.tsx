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
  TriangleAlert,
  Waypoints
} from "lucide-react";
import { motion, AnimatePresence, LazyMotion, domAnimation } from "motion/react";
import type {
  MissionArtifactType,
  MissionDetail,
  MissionIntervention,
  MissionPriority,
  MissionStatus,
  MissionStep,
  MissionStepStatus,
  MissionSummary,
  OrchestratorAttempt,
  OrchestratorRunGraph,
  OrchestratorStep
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
  { status: "in_progress", label: "Running", hint: "Actively executing" },
  { status: "intervention_required", label: "Needs Input", hint: "Awaiting decision" },
  { status: "completed", label: "Completed", hint: "Finished with outcomes" },
  { status: "failed", label: "Failed", hint: "Needs recovery" },
  { status: "canceled", label: "Canceled", hint: "Stopped intentionally" }
];

const STATUS_ICONS: Record<MissionStatus, string> = {
  queued: "clock",
  in_progress: "zap",
  intervention_required: "alert",
  completed: "check",
  failed: "x",
  canceled: "slash"
};

const STATUS_ACCENT_COLORS: Record<MissionStatus, string> = {
  queued: "rgb(56, 189, 248)",
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

function statusTone(status: MissionStatus): string {
  if (status === "queued") return "text-sky-300 border-sky-500/40 bg-sky-500/10";
  if (status === "in_progress") return "text-violet-300 border-violet-500/40 bg-violet-500/10";
  if (status === "intervention_required") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  if (status === "completed") return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  if (status === "failed") return "text-red-300 border-red-500/40 bg-red-500/10";
  return "text-muted-fg border-border bg-card/30";
}

function statusBorderColor(status: MissionStatus): string {
  if (status === "queued") return "border-l-sky-400";
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

function stepActions(step: MissionStep): Array<{ label: string; status: MissionStepStatus; variant: "primary" | "outline" | "ghost" }> {
  if (step.status === "pending") {
    return [{ label: "Start", status: "running", variant: "primary" }];
  }
  if (step.status === "running") {
    return [
      { label: "Done", status: "succeeded", variant: "primary" },
      { label: "Block", status: "blocked", variant: "outline" },
      { label: "Fail", status: "failed", variant: "ghost" }
    ];
  }
  if (step.status === "blocked") {
    return [
      { label: "Resume", status: "running", variant: "primary" },
      { label: "Fail", status: "failed", variant: "ghost" }
    ];
  }
  if (step.status === "failed") {
    return [{ label: "Retry", status: "running", variant: "primary" }];
  }
  return [];
}

function statusActions(status: MissionStatus): Array<{ label: string; status: MissionStatus; variant: "primary" | "outline" | "ghost" }> {
  if (status === "queued") {
    return [
      { label: "Start", status: "in_progress", variant: "primary" },
      { label: "Cancel", status: "canceled", variant: "outline" }
    ];
  }
  if (status === "in_progress") {
    return [
      { label: "Mark Complete", status: "completed", variant: "primary" },
      { label: "Fail", status: "failed", variant: "ghost" }
    ];
  }
  if (status === "intervention_required") {
    return [
      { label: "Resume", status: "in_progress", variant: "primary" },
      { label: "Fail", status: "failed", variant: "outline" },
      { label: "Cancel", status: "canceled", variant: "ghost" }
    ];
  }
  if (status === "failed" || status === "canceled" || status === "completed") {
    return [{ label: "Requeue", status: "queued", variant: "outline" }];
  }
  return [];
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
  const [stepBusyId, setStepBusyId] = React.useState<string | null>(null);
  const [artifactBusy, setArtifactBusy] = React.useState(false);
  const [interventionBusy, setInterventionBusy] = React.useState(false);
  const [outcomeBusy, setOutcomeBusy] = React.useState(false);
  const [runBusy, setRunBusy] = React.useState(false);
  const [attemptBusyId, setAttemptBusyId] = React.useState<string | null>(null);

  const [showForm, setShowForm] = React.useState(false);
  const [launchAnimating, setLaunchAnimating] = React.useState(false);

  /* Collapsible detail sections */
  const [expandedSections, setExpandedSections] = React.useState<Record<string, boolean>>({
    info: true,
    outcome: true,
    steps: true,
    orchestrator: true,
    interventions: true,
    artifacts: true,
    timeline: false
  });

  const toggleSection = (key: string) =>
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const [createDraft, setCreateDraft] = React.useState<CreateDraft>({
    title: "",
    prompt: "",
    laneId: "",
    priority: "normal",
    executionMode: "local",
    targetMachineId: ""
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

  const launchMission = async () => {
    const prompt = createDraft.prompt.trim();
    if (!prompt.length) {
      setError("Mission prompt is required.");
      return;
    }

    setLaunchAnimating(true);
    setCreateBusy(true);
    try {
      const created = await window.ade.missions.create({
        title: createDraft.title.trim() || undefined,
        prompt,
        laneId: createDraft.laneId || undefined,
        priority: createDraft.priority,
        executionMode: createDraft.executionMode,
        targetMachineId: createDraft.targetMachineId.trim() || undefined
      });

      setCreateDraft((prev) => ({ ...prev, title: "", prompt: "" }));
      setSelectedMissionId(created.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      await loadMissionDetail(created.id);
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

  const updateStep = async (step: MissionStep, status: MissionStepStatus) => {
    if (!selectedMission) return;
    setStepBusyId(step.id);
    try {
      await window.ade.missions.updateStep({
        missionId: selectedMission.id,
        stepId: step.id,
        status,
        ...(status === "failed" ? { note: "Marked failed from Missions tab." } : {})
      });
      await loadMissionDetail(selectedMission.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStepBusyId(null);
    }
  };

  const addQuickIntervention = async () => {
    if (!selectedMission) return;
    setInterventionBusy(true);
    try {
      await window.ade.missions.addIntervention({
        missionId: selectedMission.id,
        interventionType: "manual_input",
        title: "Operator input requested",
        body: "Mission requests human input before proceeding.",
        laneId: selectedMission.laneId ?? undefined
      });
      await loadMissionDetail(selectedMission.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
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
      await window.ade.orchestrator.startRunFromMission({
        missionId: selectedMission.id,
        defaultExecutorKind: "manual",
        defaultRetryLimit: 1
      });
      await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const tickRun = async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.tickRun({ runId: runGraph.run.id });
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

  const startStepAttempt = async (step: OrchestratorStep) => {
    if (!runGraph) return;
    setAttemptBusyId(step.id);
    try {
      await window.ade.orchestrator.startAttempt({
        runId: runGraph.run.id,
        stepId: step.id,
        ownerId: "missions-ui"
      });
      if (selectedMission) {
        await loadOrchestratorGraph(selectedMission.id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttemptBusyId(null);
    }
  };

  const completeStepAttempt = async (attemptId: string, status: "succeeded" | "failed" | "blocked" | "canceled") => {
    setAttemptBusyId(attemptId);
    try {
      await window.ade.orchestrator.completeAttempt({
        attemptId,
        status,
        ...(status === "failed" ? { errorClass: "deterministic", errorMessage: "Marked failed by operator." } : {})
      });
      if (selectedMission) {
        await loadOrchestratorGraph(selectedMission.id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttemptBusyId(null);
    }
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
            className="relative overflow-hidden rounded-2xl border border-border/30 bg-gradient-to-br from-[--color-surface-raised] via-[--color-surface] to-[--color-muted]/50 p-5 shadow-card"
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
                  className="group rounded-xl border border-border/25 bg-card/50 px-3 py-2.5 shadow-card transition-all hover:shadow-card-hover hover:border-border/40"
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
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
              >
                {error}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* ════════════════════ LAUNCH MISSION FORM ════════════════════ */}
          <motion.section variants={staggerItem} className="relative">
            <motion.div
              className="rounded-2xl border border-border/30 shadow-card overflow-hidden"
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
                            <div className="text-[11px] text-muted-fg">Target machine id (optional)</div>
                            <input
                              value={createDraft.targetMachineId}
                              onChange={(event) => setCreateDraft((prev) => ({ ...prev, targetMachineId: event.target.value }))}
                              className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none transition-all duration-200 focus:border-accent/40 focus:ring-1 focus:ring-accent/20 focus:shadow-[0_0_8px_var(--color-glow)]"
                              placeholder="machine-nyc-01"
                            />
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
                              Launch Mission
                            </Button>
                          </motion.div>
                          <div className="rounded-lg border border-border/25 bg-muted/20 p-2 text-[11px] text-muted-fg">
                            Missions persist locally now and are ready for orchestrator + machine routing phases.
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
              className="rounded-2xl border border-border/25 bg-card/55 p-6 text-sm text-muted-fg"
            >
              <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
              Loading missions...
            </motion.div>
          ) : missions.length === 0 ? (
            <motion.div variants={staggerItem}>
              <EmptyState
                title="No missions yet"
                description="Launch your first mission from the intake form to start tracking queue, interventions, and outcomes."
              />
            </motion.div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.95fr)]">
              {/* ─── KANBAN BOARD ─── */}
              <motion.section
                variants={staggerItem}
                className="rounded-2xl border border-border/30 bg-card/55 p-3 shadow-card"
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
                    className="flex min-w-max gap-3 pr-2"
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
                          className="w-[280px] shrink-0 rounded-xl border border-border/25 bg-card/45 overflow-hidden"
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
                                          {mission.openInterventions} open intervention{mission.openInterventions === 1 ? "" : "s"}
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
                  className="rounded-2xl border border-border/30 bg-card/55 p-3 shadow-card"
                >
                  {!selectedMissionSummary ? (
                    <EmptyState title="Select a mission" description="Choose one from the board to view details." />
                  ) : detailBusy || !selectedMission || selectedMission.id !== selectedMissionSummary.id ? (
                    <div className="rounded-xl border border-border/20 bg-card/40 p-4 text-xs text-muted-fg">
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
                      {/* ── Info Card ── */}
                      <motion.div variants={staggerItem} className="rounded-xl border border-border/25 bg-card/65 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("info")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <span className="text-xs font-semibold text-fg">Mission Info</span>
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
                                  {statusActions(selectedMission.status).map((action) => (
                                    <Button
                                      key={`${selectedMission.id}:${action.status}`}
                                      size="sm"
                                      variant={action.variant}
                                      disabled={missionActionBusy}
                                      onClick={() => void updateMissionStatus(action.status)}
                                    >
                                      {missionActionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                      {action.label}
                                    </Button>
                                  ))}

                                  {selectedMission.status === "in_progress" ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={interventionBusy}
                                      onClick={() => void addQuickIntervention()}
                                    >
                                      {interventionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TriangleAlert className="h-3.5 w-3.5" />}
                                      Need Input
                                    </Button>
                                  ) : null}

                                  <Button size="sm" variant="ghost" onClick={() => jumpToLane(selectedMission.laneId)} disabled={!selectedMission.laneId}>
                                    <Waypoints className="h-3.5 w-3.5" />
                                    Open lane
                                  </Button>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Outcome Summary ── */}
                      <motion.div variants={staggerItem} className="rounded-xl border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("outcome")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                            <CheckCircle2 className="h-3.5 w-3.5 text-accent" />
                            Outcome Summary
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
                                  placeholder="Capture what shipped, validations run, and follow-up items."
                                />
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <Button size="sm" variant="outline" disabled={outcomeBusy} onClick={() => void saveOutcome()}>
                                    {outcomeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />}
                                    Save summary
                                  </Button>
                                  {selectedMission.status !== "completed" ? (
                                    <Button size="sm" variant="primary" disabled={missionActionBusy} onClick={() => void updateMissionStatus("completed")}>
                                      Mark complete
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Mission Steps (vertical timeline) ── */}
                      <motion.div variants={staggerItem} className="rounded-xl border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("steps")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <span className="text-xs font-semibold text-fg">Mission Steps</span>
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
                                <div className="relative">
                                  {/* Vertical timeline line */}
                                  {selectedMission.steps.length > 1 && (
                                    <div className="absolute left-[7px] top-3 bottom-3 w-[2px] bg-border/30" />
                                  )}
                                  <div className="space-y-3">
                                    {selectedMission.steps.map((step) => (
                                      <div key={step.id} className="relative flex gap-3">
                                        {/* Timeline dot */}
                                        <div className="relative z-10 mt-1 flex-shrink-0">
                                          <div
                                            className={cn(
                                              "h-4 w-4 rounded-full border-2 border-card/60",
                                              stepDotColor(step.status),
                                              step.status === "running" && "ade-glow-pulse"
                                            )}
                                          />
                                        </div>
                                        {/* Step content */}
                                        <div className="flex-1 rounded-lg border border-border/20 bg-muted/10 px-2 py-2">
                                          <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                              <div className="truncate text-xs font-medium text-fg">
                                                {step.index + 1}. {step.title}
                                              </div>
                                              <div className="mt-0.5 text-[10px] text-muted-fg">{step.detail || "Placeholder step for Phase 1 mission intake."}</div>
                                            </div>
                                            <Chip className={cn("border px-1.5 py-0.5 text-[10px]", stepTone(step.status))}>{step.status}</Chip>
                                          </div>
                                          <div className="mt-2 flex flex-wrap gap-1.5">
                                            {stepActions(step).map((action) => (
                                              <Button
                                                key={`${step.id}:${action.status}`}
                                                size="sm"
                                                variant={action.variant}
                                                className="h-7 px-2 text-[11px]"
                                                disabled={stepBusyId === step.id}
                                                onClick={() => void updateStep(step, action.status)}
                                              >
                                                {stepBusyId === step.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                                {action.label}
                                              </Button>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Orchestrator Runtime ── */}
                      <motion.div variants={staggerItem} className="rounded-xl border border-border/25 bg-card/60 overflow-hidden">
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
                                <div className="flex flex-wrap gap-2">
                                  <Button size="sm" variant="outline" disabled={runBusy} onClick={() => void startOrchestratorRun()}>
                                    {runBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                                    Start run from mission steps
                                  </Button>
                                  <Button size="sm" variant="outline" disabled={runBusy || !runGraph} onClick={() => void tickRun()}>
                                    Tick
                                  </Button>
                                  <Button size="sm" variant="outline" disabled={runBusy || !runGraph} onClick={() => void resumeRun()}>
                                    Resume
                                  </Button>
                                  <Button size="sm" variant="ghost" disabled={runBusy || !runGraph} onClick={() => void cancelRun()}>
                                    Cancel
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
                                    <div className="space-y-2">
                                      {runGraph.steps
                                        .slice()
                                        .sort((a, b) => a.stepIndex - b.stepIndex)
                                        .map((step) => {
                                          const attempts = attemptsByStep.get(step.id) ?? [];
                                          const latestAttempt = attempts[0] ?? null;
                                          const attemptBusy = attemptBusyId === step.id || (latestAttempt && attemptBusyId === latestAttempt.id);
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
                                              <div className="mt-2 flex flex-wrap gap-1.5">
                                                {step.status === "ready" ? (
                                                  <Button size="sm" variant="primary" className="h-7 px-2 text-[11px]" disabled={Boolean(attemptBusy)} onClick={() => void startStepAttempt(step)}>
                                                    {attemptBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                                    Start attempt
                                                  </Button>
                                                ) : null}
                                                {latestAttempt && latestAttempt.status === "running" ? (
                                                  <>
                                                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={Boolean(attemptBusy)} onClick={() => void completeStepAttempt(latestAttempt.id, "succeeded")}>
                                                      Complete
                                                    </Button>
                                                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={Boolean(attemptBusy)} onClick={() => void completeStepAttempt(latestAttempt.id, "failed")}>
                                                      Fail
                                                    </Button>
                                                  </>
                                                ) : null}
                                              </div>
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

                      {/* ── Interventions ── */}
                      <motion.div variants={staggerItem} className="rounded-xl border border-border/25 bg-card/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleSection("interventions")}
                          className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/10 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
                            Interventions
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
                                    No interventions logged.
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
                                  <div className="text-[11px] font-medium text-fg">Add intervention</div>
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
                                      Add intervention
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>

                      {/* ── Artifacts & PRs ── */}
                      <motion.div variants={staggerItem} className="rounded-xl border border-border/25 bg-card/60 overflow-hidden">
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
                      <motion.div variants={staggerItem} className="rounded-xl border border-border/25 bg-card/60 overflow-hidden">
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
