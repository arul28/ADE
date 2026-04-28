import { useCallback, useMemo, useEffect, useRef, useState } from "react";
import { LazyMotion, domAnimation } from "motion/react";
import {
  ArrowRight,
  CalendarBlank,
  CheckCircle,
  Compass,
  FlagBanner,
  GitBranch,
  ListChecks,
} from "@phosphor-icons/react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../state/appStore";
import { MONO_FONT } from "../lanes/laneDesignTokens";

/* ── Store & extracted components ── */
import { useMissionsStore, type MissionsStore } from "./useMissionsStore";
import { MissionSidebar } from "./MissionSidebar";
import { MissionDetailView } from "./MissionDetailView";
import { ManageMissionDialog, MissionContextMenu } from "./ManageMissionDialog";
import { MissionCreateDialogHost } from "./MissionCreateDialogHost";
import { MissionSettingsDialog } from "./MissionSettingsDialog";
import { useMissionPolling } from "./useMissionPolling";

import type { CreateDraft, CreateMissionDefaults } from "./CreateMissionDialog";
import { buildMissionLaunchRequest, prewarmCreateMissionDialogCache } from "./CreateMissionDialog";
import {
  hasFreshPhaseItems,
  hasFreshPhaseProfiles,
  setCachedPhaseItems,
  setCachedPhaseProfiles,
} from "./missionDialogDataCache";

/* Re-export helpers used by tests */
export { collapsePlannerStreamMessages, resolveStepHeartbeatAt } from "./missionHelpers";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

type AppPackagingState = "checking" | "packaged" | "dev";

function ProductionMissionsComingSoon() {
  const navigate = useNavigate();
  const previewItems = [
    {
      icon: Compass,
      title: "Mission planning",
      body: "Turn a larger goal into phases, worker lanes, checkpoints, and proof requirements before agents start.",
    },
    {
      icon: GitBranch,
      title: "Lane orchestration",
      body: "Coordinate multi-agent work across isolated lanes, then bring results back with reviewable handoffs.",
    },
    {
      icon: ListChecks,
      title: "Human checkpoints",
      body: "Pause when ADE needs operator input, budget approval, or a decision before external side effects happen.",
    },
    {
      icon: CheckCircle,
      title: "Artifacts and closeout",
      body: "Collect logs, summaries, screenshots, and implementation proof into one mission record.",
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-bg text-fg">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col justify-center px-6 py-10">
        <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <section className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px] text-emerald-200">
              <FlagBanner size={14} weight="regular" />
              Coming soon
            </div>

            <div>
              <h1 className="text-4xl font-semibold tracking-normal text-[#F5FAFF]">Missions are almost ready</h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-muted-fg">
                Missions are ADE's multi-step orchestration layer for work that is bigger than one chat thread:
                planning, delegation, lane execution, intervention, and proof captured as one run.
              </p>
            </div>

            <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-4">
              <div className="flex items-start gap-3">
                <CalendarBlank size={18} weight="regular" className="mt-0.5 shrink-0 text-[#7DD3FC]" />
                <div>
                  <div className="text-sm font-semibold text-[#F5FAFF]">Production access is paused</div>
                  <p className="mt-1 text-sm leading-6 text-muted-fg">
                    The tab is visible so teams can see where missions fit, but creation and live runs stay disabled
                    in packaged builds until the orchestration flow is production-ready.
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate("/automations")}
              className="inline-flex h-9 items-center gap-2 rounded border border-white/[0.12] bg-white/[0.04] px-4 font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#D8E3F2] transition-colors hover:border-[#7DD3FC]/40 hover:text-[#F5FAFF]"
            >
              Review automations
              <ArrowRight size={13} weight="regular" />
            </button>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            {previewItems.map(({ icon: Icon, title, body }) => (
              <article key={title} className="rounded-lg border border-white/[0.08] bg-black/15 p-4">
                <Icon size={18} weight="regular" className="text-[#A78BFA]" />
                <div className="mt-3 text-sm font-semibold text-[#F5FAFF]">{title}</div>
                <p className="mt-2 text-xs leading-5 text-muted-fg">{body}</p>
              </article>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function MissionsProductionGate({ children }: { children: React.ReactElement }) {
  const [state, setState] = useState<AppPackagingState>("checking");

  useEffect(() => {
    let cancelled = false;
    window.ade.app.getInfo().then(
      (info) => {
        if (!cancelled) setState(info.isPackaged ? "packaged" : "dev");
      },
      () => {
        if (!cancelled) setState("dev");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex h-full min-w-0 flex-col bg-bg">
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-4 w-48 animate-pulse rounded-md bg-white/[0.06]" />
          <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-fg">
            Checking mission availability...
          </div>
        </div>
      </div>
    );
  }

  if (state === "packaged") return <ProductionMissionsComingSoon />;

  return children;
}

/* ── Sidebar width persistence (VAL-UX-010) ── */
const SIDEBAR_WIDTH_KEY = "ade.missions.sidebarWidth";
const SIDEBAR_MIN_PX = 200;
const SIDEBAR_MAX_PX = 400;
const SIDEBAR_DEFAULT_PX = 248;
const SIDEBAR_COLLAPSE_THRESHOLD = 900;

/** Read persisted sidebar width (in pixels) from localStorage. */
function readPersistedSidebarPx(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= SIDEBAR_MIN_PX && n <= SIDEBAR_MAX_PX) return n;
    }
  } catch { /* ignore */ }
  return SIDEBAR_DEFAULT_PX;
}

/** Persist sidebar width (in pixels) to localStorage. */
function persistSidebarPx(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch { /* ignore */ }
}

/* ── Fine-grained page-level selector (VAL-ARCH-008) ── */
const selectPageData = (s: MissionsStore) => ({
  loading: s.loading,
  missionSettingsOpen: s.missionSettingsOpen,
  missionSettingsBusy: s.missionSettingsBusy,
  missionSettingsError: s.missionSettingsError,
  missionSettingsNotice: s.missionSettingsNotice,
  missionSettingsDraft: s.missionSettingsDraft,
});

/* ════════════════════ MAIN COMPONENT ════════════════════ */

function MissionsWorkspace() {
  const [searchParams] = useSearchParams();
  const lanes = useAppStore((s) => s.lanes);
  const mappedLanes = useMemo(() => lanes.map((l) => ({ id: l.id, name: l.name })), [lanes]);
  const appliedQueryMissionIdRef = useRef<string | null>(null);

  /* ── Fine-grained store slice via useShallow (VAL-ARCH-008) ── */
  const {
    loading,
    missionSettingsOpen,
    missionSettingsBusy,
    missionSettingsError,
    missionSettingsNotice,
    missionSettingsDraft,
  } = useMissionsStore(useShallow(selectPageData));

  /* ── Default lane for create dialog ── */
  const defaultCreateLaneId = useMemo(
    () => lanes.find((l) => l.laneType === "primary")?.id ?? lanes[0]?.id ?? null,
    [lanes],
  );

  const createMissionDefaults = useMemo<CreateMissionDefaults>(
    () => ({
      orchestratorModel: missionSettingsDraft.defaultOrchestratorModel,
      permissionConfig: missionSettingsDraft.permissionConfig,
    }),
    [missionSettingsDraft],
  );

  /* ── Initial data load ── */
  useEffect(() => {
    let cancelled = false;
    const store = useMissionsStore.getState();
    void store.refreshMissionList({ preserveSelection: true });
    const dashboardTimer = window.setTimeout(() => {
      if (cancelled) return;
      void store.loadDashboard();
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(dashboardTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      void useMissionsStore.getState().loadMissionSettings();
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.ade.orchestrator.getModelCapabilities().then(
        (result) => { if (!cancelled) useMissionsStore.getState().setModelCapabilities(result); },
        () => { if (!cancelled) useMissionsStore.getState().setModelCapabilities(null); },
      );
    }, 1_200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (!hasFreshPhaseProfiles()) {
        void window.ade.missions.listPhaseProfiles({}).then((profiles) => {
          if (cancelled || profiles.length === 0) return;
          setCachedPhaseProfiles(profiles);
        }).catch(() => {});
      }
      if (!hasFreshPhaseItems()) {
        void window.ade.missions.listPhaseItems({}).then((items) => {
          if (cancelled) return;
          setCachedPhaseItems(items);
        }).catch(() => {});
      }
      void prewarmCreateMissionDialogCache().catch(() => {});
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  /* ── Event subscriptions — delegated to store (VAL-ARCH-007) ── */
  useEffect(() => {
    const cleanup = useMissionsStore.getState().initEventSubscriptions();
    return cleanup;
  }, []);

  /* ── Selection change via consolidated getFullMissionView (VAL-ARCH-004) ── */
  const selectedMissionId = useMissionsStore((s) => s.selectedMissionId);
  useEffect(() => {
    void useMissionsStore.getState().selectMission(selectedMissionId);
  }, [selectedMissionId]);

  useEffect(() => {
    const missionParam = (searchParams.get("missionId") ?? "").trim();
    if (!missionParam) {
      appliedQueryMissionIdRef.current = null;
      return;
    }
    if (appliedQueryMissionIdRef.current === missionParam) return;
    appliedQueryMissionIdRef.current = missionParam;
    void useMissionsStore.getState().selectMission(missionParam);
  }, [searchParams]);

  /* ── Checkpoint polling via shared coordinator ── */
  const runGraph = useMissionsStore((s) => s.runGraph);
  const checkpointPollEnabled = Boolean(runGraph && !TERMINAL_RUN_STATUSES.has(runGraph.run.status));
  const checkpointRunId = runGraph?.run.id ?? null;
  const refreshCheckpointStatus = useCallback(() => {
    const store = useMissionsStore.getState();
    if (!checkpointRunId) { store.setCheckpointStatus(null); return; }
    void window.ade.orchestrator.getCheckpointStatus({ runId: checkpointRunId }).then(
      (next) => store.setCheckpointStatus(next),
      () => store.setCheckpointStatus(null),
    );
  }, [checkpointRunId]);
  useMissionPolling(refreshCheckpointStatus, 10_000, checkpointPollEnabled);
  useEffect(() => {
    if (!checkpointPollEnabled) useMissionsStore.getState().setCheckpointStatus(null);
  }, [checkpointPollEnabled]);

  /* ── Step selection reconciliation ── */
  useEffect(() => {
    const steps = runGraph?.steps ?? [];
    const store = useMissionsStore.getState();
    const currentStepId = store.selectedStepId;
    if (!steps.length) {
      if (currentStepId !== null) store.setSelectedStepId(null);
      return;
    }
    if (currentStepId && steps.some((s) => s.id === currentStepId)) return;
    const running = steps.find((s) => s.status === "running");
    store.setSelectedStepId((running ?? steps[0]).id);
  }, [runGraph]);

  useEffect(() => {
    useMissionsStore.getState().setCoordinatorPromptInspector(null);
    useMissionsStore.getState().setWorkerPromptInspector(null);
  }, [selectedMissionId]);

  /* ── Attention toast notifications (timers owned by store, VAL-ARCH-007) ── */
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const prevMissionStatusRef = useRef<string | null>(null);
  const prevOpenInterventionCountRef = useRef<number>(0);

  useEffect(() => {
    if (!selectedMission) {
      prevMissionStatusRef.current = null;
      prevOpenInterventionCountRef.current = 0;
      return;
    }
    const prevStatus = prevMissionStatusRef.current;
    const prevOpenCount = prevOpenInterventionCountRef.current;
    const currentStatus = selectedMission.status;
    const currentOpenCount = selectedMission.openInterventions;
    prevMissionStatusRef.current = currentStatus;
    prevOpenInterventionCountRef.current = currentOpenCount;
    if (prevStatus === null) return;

    const store = useMissionsStore.getState();
    if (currentStatus === "intervention_required" && prevStatus !== "intervention_required") {
      store.addAttentionToast("Mission requires intervention", "warning", selectedMission.title, selectedMission.id);
    } else if (currentStatus === "failed" && prevStatus !== "failed") {
      store.addAttentionToast("Mission has failed", "error", selectedMission.title, selectedMission.id);
    } else if (currentOpenCount > prevOpenCount && currentStatus === "in_progress") {
      store.addAttentionToast(
        `${currentOpenCount - prevOpenCount} new intervention${currentOpenCount - prevOpenCount === 1 ? "" : "s"} opened`,
        "warning",
        selectedMission.title,
        selectedMission.id,
      );
    }
  }, [selectedMission?.status, selectedMission?.openInterventions, selectedMission?.id, selectedMission?.title, selectedMission]);

  useEffect(() => {
    return () => useMissionsStore.getState().cleanupToastTimers();
  }, []);

  /* ── Responsive sidebar collapse (VAL-UX-010) ── */
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${SIDEBAR_COLLAPSE_THRESHOLD}px)`);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setCollapsed(e.matches);
    handler(mql);
    mql.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
    return () => mql.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
  }, []);

  const defaultSidebarPx = useMemo(() => readPersistedSidebarPx(), []);

  /* ── Mission launch handler ── */
  const handleLaunchMission = useCallback(
    async (draft: CreateDraft) => {
      const store = useMissionsStore.getState();
      const prompt = draft.prompt.trim();
      if (!prompt) { store.setError("Mission prompt is required."); return; }
      try {
        const created = await window.ade.missions.create(
          buildMissionLaunchRequest({
            draft,
            activePhases: draft.phaseOverride,
            defaultLaneId: defaultCreateLaneId,
          }),
        );
        store.setSelectedMissionId(created.id);
        await store.selectMission(created.id);
        await store.refreshMissionList({ preserveSelection: true, silent: true });
        store.setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [defaultCreateLaneId],
  );

  /* ── Loading screen ── */
  if (loading) {
    return (
      <div className="flex h-full min-w-0 flex-col bg-bg">
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <div className="animate-pulse flex flex-col items-center gap-2">
            <div className="h-4 w-48 rounded-md bg-white/[0.06]" />
            <div className="h-3 w-32 rounded-md bg-white/[0.04]" />
          </div>
          <div
            className="text-[10px] font-bold uppercase tracking-widest text-muted-fg"
            style={{ fontFamily: MONO_FONT }}
          >
            LOADING MISSIONS...
          </div>
        </div>
      </div>
    );
  }

  /* ════════════════════ RENDER ════════════════════ */
  return (
    <LazyMotion features={domAnimation}>
      <Group
        id="missions-layout"
        orientation="horizontal"
        className="flex h-full min-h-0 bg-bg"
      >
        {/* Sidebar (resizable 200-400px, VAL-UX-010) */}
        {!collapsed && (
          <>
            <Panel
              id="missions-sidebar"
              defaultSize={defaultSidebarPx}
              minSize={SIDEBAR_MIN_PX}
              maxSize={SIDEBAR_MAX_PX}
              onResize={(size) => persistSidebarPx(size.inPixels)}
              style={{ overflow: "hidden" }}
            >
              <MissionSidebar />
            </Panel>
            <Separator
              id="missions-separator"
              className="w-[4px] bg-white/[0.06] hover:bg-[#A78BFA]/20 active:bg-[#A78BFA]/30 transition-colors cursor-col-resize"
            />
          </>
        )}

        {/* Main workspace */}
        <Panel id="missions-detail" minSize="50%">
          <div className="flex flex-1 flex-col min-w-0 h-full bg-bg">
            <MissionDetailView />
          </div>
        </Panel>
      </Group>

      {/* Context Menu */}
      <MissionContextMenu />

      {/* Manage Mission Dialog */}
      <ManageMissionDialog />

      {/* Create Mission Dialog */}
      <MissionCreateDialogHost
        lanes={mappedLanes}
        defaultLaneId={defaultCreateLaneId}
        missionDefaults={createMissionDefaults}
        onLaunch={handleLaunchMission}
      />

      {/* Mission Settings Dialog */}
      {missionSettingsOpen ? (
        <MissionSettingsDialog
          open={missionSettingsOpen}
          onClose={() => {
            if (missionSettingsBusy) return;
            useMissionsStore.getState().setMissionSettingsOpen(false);
          }}
          draft={missionSettingsDraft}
          onDraftChange={(update) => useMissionsStore.getState().setMissionSettingsDraft((prev) => ({ ...prev, ...update }))}
          onSave={() => void useMissionsStore.getState().saveMissionSettings()}
          busy={missionSettingsBusy}
          error={missionSettingsError}
          notice={missionSettingsNotice}
        />
      ) : null}
    </LazyMotion>
  );
}

/* Re-export for compatibility: the page was previously a named export */
export default function MissionsPage() {
  return (
    <MissionsProductionGate>
      <MissionsWorkspace />
    </MissionsProductionGate>
  );
}

export { MissionsPage };
