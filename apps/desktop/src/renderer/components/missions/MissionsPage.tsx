import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  GitPullRequest,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Route,
  TriangleAlert,
  Waypoints
} from "lucide-react";
import type {
  MissionArtifactType,
  MissionDetail,
  MissionIntervention,
  MissionPriority,
  MissionStatus,
  MissionStep,
  MissionStepStatus,
  MissionSummary
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
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

function statusTone(status: MissionStatus): string {
  if (status === "queued") return "text-sky-300 border-sky-500/40 bg-sky-500/10";
  if (status === "in_progress") return "text-violet-300 border-violet-500/40 bg-violet-500/10";
  if (status === "intervention_required") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  if (status === "completed") return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  if (status === "failed") return "text-red-300 border-red-500/40 bg-red-500/10";
  return "text-muted-fg border-border bg-card/30";
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

  React.useEffect(() => {
    void refreshMissionList({ preserveSelection: true });
  }, [refreshMissionList]);

  React.useEffect(() => {
    if (!selectedMissionId) {
      setSelectedMission(null);
      return;
    }
    void loadMissionDetail(selectedMissionId);
  }, [selectedMissionId, loadMissionDetail]);

  React.useEffect(() => {
    const unsub = window.ade.missions.onEvent((payload) => {
      void refreshMissionList({ preserveSelection: true, silent: true });
      if (payload.missionId && payload.missionId === selectedMissionId) {
        void loadMissionDetail(payload.missionId);
      }
    });
    return () => unsub();
  }, [loadMissionDetail, refreshMissionList, selectedMissionId]);

  React.useEffect(() => {
    setOutcomeDraft(selectedMission?.outcomeSummary ?? "");
  }, [selectedMission?.id, selectedMission?.outcomeSummary]);

  const launchMission = async () => {
    const prompt = createDraft.prompt.trim();
    if (!prompt.length) {
      setError("Mission prompt is required.");
      return;
    }

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
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
    <div className="min-h-0 h-full overflow-auto p-4">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4">
        <section className="relative overflow-hidden rounded-2xl border border-border/30 bg-gradient-to-br from-[--color-surface-raised] via-[--color-surface] to-[--color-muted]/50 p-4 shadow-card">
          <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
          <div className="absolute -bottom-16 -left-10 h-36 w-36 rounded-full bg-secondary/20 blur-2xl" />

          <div className="relative flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                <Rocket className="h-4 w-4 text-accent" />
                Missions
              </div>
              <div className="mt-1 text-xs text-muted-fg">
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

          <div className="relative mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
            {STATUS_COLUMNS.map((column) => (
              <div key={column.status} className="rounded-xl border border-border/25 bg-card/50 px-3 py-2.5 shadow-card">
                <div className="text-[10px] uppercase tracking-wide text-muted-fg/70">{column.label}</div>
                <div className="mt-1 text-lg font-semibold text-fg">{statusCount[column.status]}</div>
                <div className="text-[10px] text-muted-fg/70">{column.hint}</div>
              </div>
            ))}
          </div>
        </section>

        {error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        <section className="rounded-2xl border border-border/30 bg-card/55 p-4 shadow-card">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Plus className="h-4 w-4 text-accent" />
            Launch Mission
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <label className="space-y-1 xl:col-span-2">
              <div className="text-[11px] text-muted-fg">Mission title (optional)</div>
              <input
                value={createDraft.title}
                onChange={(event) => setCreateDraft((prev) => ({ ...prev, title: event.target.value }))}
                className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                placeholder="Refactor auth middleware and open PR"
              />
            </label>

            <label className="space-y-1">
              <div className="text-[11px] text-muted-fg">Lane</div>
              <select
                value={createDraft.laneId}
                onChange={(event) => setCreateDraft((prev) => ({ ...prev, laneId: event.target.value }))}
                className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
                className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
                className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
              >
                <option value="local">local machine</option>
                <option value="relay">relay machine (future)</option>
              </select>
            </label>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_240px]">
            <label className="space-y-1">
              <div className="text-[11px] text-muted-fg">Mission prompt</div>
              <textarea
                value={createDraft.prompt}
                onChange={(event) => setCreateDraft((prev) => ({ ...prev, prompt: event.target.value }))}
                className="h-28 w-full resize-y rounded-lg border border-border/30 bg-muted/15 px-2 py-2 text-xs leading-relaxed text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                placeholder="Example: prepare a PR-ready refactor for login flow, run tests, and summarize changes and risks."
              />
            </label>
            <div className="space-y-2">
              <label className="space-y-1">
                <div className="text-[11px] text-muted-fg">Target machine id (optional)</div>
                <input
                  value={createDraft.targetMachineId}
                  onChange={(event) => setCreateDraft((prev) => ({ ...prev, targetMachineId: event.target.value }))}
                  className="h-9 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                  placeholder="machine-nyc-01"
                />
              </label>
              <Button variant="primary" className="w-full" onClick={() => void launchMission()} disabled={createBusy}>
                {createBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                Launch Mission
              </Button>
              <div className="rounded-lg border border-border/25 bg-muted/20 p-2 text-[11px] text-muted-fg">
                Missions persist locally now and are ready for orchestrator + machine routing phases.
              </div>
            </div>
          </div>
        </section>

        {loading ? (
          <div className="rounded-2xl border border-border/25 bg-card/55 p-6 text-sm text-muted-fg">Loading missions…</div>
        ) : missions.length === 0 ? (
          <EmptyState
            title="No missions yet"
            description="Launch your first mission from the intake form to start tracking queue, interventions, and outcomes."
          />
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.95fr)]">
            <section className="rounded-2xl border border-border/30 bg-card/55 p-3 shadow-card">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <Route className="h-4 w-4 text-accent" />
                  Mission Lanes
                </div>
                <div className="text-[11px] text-muted-fg">Select a mission for details</div>
              </div>

              <div className="overflow-x-auto pb-1">
                <div className="flex min-w-max gap-3 pr-2">
                  {STATUS_COLUMNS.map((column) => {
                    const inColumn = missions.filter((mission) => mission.status === column.status);
                    return (
                      <div key={column.status} className="w-[280px] shrink-0 rounded-xl border border-border/25 bg-card/45 p-2">
                        <div className="mb-2 flex items-center justify-between">
                          <div>
                            <div className="text-xs font-semibold text-fg">{column.label}</div>
                            <div className="text-[10px] text-muted-fg">{column.hint}</div>
                          </div>
                          <Chip className={cn("border px-1.5 py-0.5 text-[10px]", statusTone(column.status))}>
                            {inColumn.length}
                          </Chip>
                        </div>

                        <div className="space-y-2">
                          {inColumn.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border/25 bg-muted/10 px-2 py-3 text-center text-[11px] text-muted-fg">
                              No missions
                            </div>
                          ) : (
                            inColumn.map((mission) => {
                              const active = mission.id === selectedMissionId;
                              return (
                                <button
                                  key={mission.id}
                                  type="button"
                                  onClick={() => setSelectedMissionId(mission.id)}
                                  className={cn(
                                    "w-full rounded-lg border px-2 py-2 text-left transition-all",
                                    active
                                      ? "border-accent/50 bg-accent/10 shadow-card-hover"
                                      : "border-border/25 bg-card/55 hover:bg-muted/35"
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="truncate text-xs font-semibold text-fg">{mission.title}</div>
                                      <div className="mt-0.5 truncate text-[10px] text-muted-fg">
                                        {mission.laneName ?? "Any lane"}
                                      </div>
                                    </div>
                                    <Chip className={cn("shrink-0 border px-1.5 py-0.5 text-[10px]", priorityTone(mission.priority))}>
                                      {mission.priority}
                                    </Chip>
                                  </div>
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
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border/30 bg-card/55 p-3 shadow-card">
              {!selectedMissionSummary ? (
                <EmptyState title="Select a mission" description="Choose one from the board to view details." />
              ) : detailBusy || !selectedMission || selectedMission.id !== selectedMissionSummary.id ? (
                <div className="rounded-xl border border-border/20 bg-card/40 p-4 text-xs text-muted-fg">Loading mission detail…</div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border/25 bg-card/65 p-3">
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

                  <div className="rounded-xl border border-border/25 bg-card/60 p-3">
                    <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-fg">
                      <CheckCircle2 className="h-3.5 w-3.5 text-accent" />
                      Outcome Summary
                    </div>
                    <textarea
                      value={outcomeDraft}
                      onChange={(event) => setOutcomeDraft(event.target.value)}
                      className="h-20 w-full resize-y rounded-lg border border-border/30 bg-muted/15 px-2 py-1.5 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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

                  <div className="rounded-xl border border-border/25 bg-card/60 p-3">
                    <div className="mb-2 text-xs font-semibold text-fg">Mission Steps</div>
                    <div className="space-y-2">
                      {selectedMission.steps.map((step) => (
                        <div key={step.id} className="rounded-lg border border-border/20 bg-muted/10 px-2 py-2">
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
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border/25 bg-card/60 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
                      Interventions
                    </div>
                    <div className="space-y-2">
                      {selectedMission.interventions.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border/25 bg-muted/10 px-2 py-3 text-center text-[11px] text-muted-fg">
                          No interventions logged.
                        </div>
                      ) : (
                        selectedMission.interventions.map((intervention) => (
                          <div key={intervention.id} className="rounded-lg border border-border/20 bg-muted/10 px-2 py-2">
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
                    </div>

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
                          className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
                          className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                          placeholder="Intervention title"
                        />
                      </div>
                      <textarea
                        value={interventionDraft.body}
                        onChange={(event) => setInterventionDraft((prev) => ({ ...prev, body: event.target.value }))}
                        className="mt-2 h-16 w-full rounded-lg border border-border/30 bg-muted/15 px-2 py-1.5 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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

                  <div className="rounded-xl border border-border/25 bg-card/60 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg">
                      <GitPullRequest className="h-3.5 w-3.5 text-accent" />
                      Artifacts & PRs
                    </div>

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
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-[11px]"
                                  onClick={() => void openArtifact(artifact.uri)}
                                >
                                  <Link2 className="h-3 w-3" />
                                  {artifact.artifactType === "pr" ? "Open PR" : "Open link"}
                                </Button>
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
                          className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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
                          className="h-8 rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                          placeholder="Artifact title"
                        />
                      </div>
                      <input
                        value={artifactDraft.uri}
                        onChange={(event) => setArtifactDraft((prev) => ({ ...prev, uri: event.target.value }))}
                        className="mt-2 h-8 w-full rounded-lg border border-border/30 bg-muted/20 px-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                        placeholder="https://github.com/.../pull/123"
                      />
                      <textarea
                        value={artifactDraft.description}
                        onChange={(event) => setArtifactDraft((prev) => ({ ...prev, description: event.target.value }))}
                        className="mt-2 h-14 w-full rounded-lg border border-border/30 bg-muted/15 px-2 py-1.5 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
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

                  <div className="rounded-xl border border-border/25 bg-card/60 p-3">
                    <div className="mb-2 text-xs font-semibold text-fg">Mission Timeline</div>
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
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
