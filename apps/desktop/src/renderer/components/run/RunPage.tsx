import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Stop, Plus, X, FolderOpen, Folder, Rocket, Globe } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { RunSidebar } from "./RunSidebar";
import { CommandCard } from "./CommandCard";
import { ProcessMonitor } from "./ProcessMonitor";
import { LaneRuntimeBar } from "./LaneRuntimeBar";
import { RunNetworkPanel } from "./RunNetworkPanel";
import { AddCommandDialog, type AddCommandInitialValues } from "./AddCommandDialog";
import { commandArrayToLine, parseCommandLine } from "../../lib/shell";
import type {
  ProcessDefinition,
  ProcessRuntime,
  ProcessEvent,
  StackButtonDefinition,
  ProjectConfigSnapshot,
  ConfigProcessDefinition,
  ConfigStackButtonDefinition,
} from "../../../shared/types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Parse "KEY=value" lines into a Record. Ignores blank lines and comments. */
function parseEnvText(text: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const env: Record<string, string> = {};
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const eqIdx = l.indexOf("=");
    if (eqIdx < 1) continue;
    env[l.slice(0, eqIdx)] = l.slice(eqIdx + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Serialize a Record back to "KEY=value" lines. */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

function WelcomeScreen() {
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const [recentProjects, setRecentProjects] = useState<Array<{ rootPath: string; displayName: string; exists: boolean }>>([]);

  useEffect(() => {
    window.ade.project.listRecent().then(setRecentProjects).catch(() => {});
  }, []);

  const realProjects = recentProjects.filter((rp) => rp.exists && !rp.rootPath.includes("ade-project"));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        background: COLORS.pageBg,
        gap: 32,
        padding: 48,
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 64,
          height: 64,
          background: `${COLORS.accent}18`,
          border: `1px solid ${COLORS.accent}30`,
          marginBottom: 24,
        }}>
          <Rocket size={32} weight="duotone" style={{ color: COLORS.accent }} />
        </div>
        <h1 style={{
          fontFamily: SANS_FONT,
          fontSize: 24,
          fontWeight: 700,
          color: COLORS.textPrimary,
          margin: "0 0 8px",
        }}>
          Welcome to ADE
        </h1>
        <p style={{
          fontFamily: MONO_FONT,
          fontSize: 12,
          color: COLORS.textMuted,
          margin: 0,
          lineHeight: 1.6,
        }}>
          Open a project folder to get started. ADE will detect your stack,
          set up lanes, and provide AI-powered context for your development workflow.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void openRepo()}
        style={{
          ...primaryButton({ height: 44, padding: "0 28px", fontSize: 13 }),
          gap: 10,
        }}
      >
        <FolderOpen size={18} weight="regular" />
        OPEN PROJECT
      </button>

      {realProjects.length > 0 && (
        <div style={{ width: "100%", maxWidth: 400 }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>RECENT PROJECTS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {realProjects.map((rp) => (
              <button
                key={rp.rootPath}
                type="button"
                onClick={() => void switchProjectToPath(rp.rootPath)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  background: COLORS.cardBg,
                  border: `1px solid ${COLORS.border}`,
                  color: COLORS.textPrimary,
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "border-color 150ms ease, background 150ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = COLORS.accent + "60";
                  e.currentTarget.style.background = COLORS.hoverBg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = COLORS.border;
                  e.currentTarget.style.background = COLORS.cardBg;
                }}
              >
                <Folder size={14} weight="regular" style={{ color: COLORS.accent, flexShrink: 0 }} />
                <div style={{ overflow: "hidden" }}>
                  <div style={{ fontWeight: 600 }}>{rp.displayName}</div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {rp.rootPath}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function RunPage() {
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const runLaneId = useAppStore((s) => s.runLaneId);
  const selectRunLane = useAppStore((s) => s.selectRunLane);
  const showWelcome = useAppStore((s) => s.showWelcome);

  const [config, setConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [definitions, setDefinitions] = useState<ProcessDefinition[]>([]);
  const [runtime, setRuntime] = useState<ProcessRuntime[]>([]);
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingProcess, setEditingProcess] = useState<{ id: string; values: AddCommandInitialValues } | null>(null);
  const [moveToStackProcessId, setMoveToStackProcessId] = useState<string | null>(null);
  const [networkDrawerOpen, setNetworkDrawerOpen] = useState(false);
  const runtimeRefreshTimerRef = useRef<number | null>(null);

  const effectiveLaneId = runLaneId ?? selectedLaneId ?? lanes[0]?.id ?? null;
  const effectiveLaneIdRef = useRef(effectiveLaneId);
  effectiveLaneIdRef.current = effectiveLaneId;
  const selectedLane = useMemo(
    () => lanes.find((lane) => lane.id === effectiveLaneId) ?? null,
    [effectiveLaneId, lanes]
  );

  // Sync runLaneId from selectedLaneId
  useEffect(() => {
    if (!runLaneId && selectedLaneId) {
      selectRunLane(selectedLaneId);
    }
  }, [runLaneId, selectedLaneId, selectRunLane]);

  const refreshDefinitions = useCallback(async () => {
    if (showWelcome) {
      setConfig(null);
      setDefinitions([]);
      return;
    }

    setLoading(true);
    try {
      const [nextConfig, nextDefs] = await Promise.all([
        window.ade.projectConfig.get(),
        window.ade.processes.listDefinitions(),
      ]);
      setConfig(nextConfig);
      setDefinitions(nextDefs);
    } catch (err) {
      console.error("RunPage.refreshDefinitions", err);
    } finally {
      setLoading(false);
    }
  }, [showWelcome]);

  const refreshRuntime = useCallback(async () => {
    if (showWelcome || !effectiveLaneId) {
      setRuntime([]);
      return;
    }
    try {
      const nextRuntime = await window.ade.processes.listRuntime(effectiveLaneId);
      setRuntime(nextRuntime);
    } catch (err) {
      console.error("RunPage.refreshRuntime", err);
    }
  }, [effectiveLaneId, showWelcome]);

  useEffect(() => {
    if (showWelcome) return;
    void refreshDefinitions();
  }, [refreshDefinitions, showWelcome]);

  useEffect(() => {
    if (runtimeRefreshTimerRef.current != null) {
      window.clearTimeout(runtimeRefreshTimerRef.current);
      runtimeRefreshTimerRef.current = null;
    }
    if (showWelcome) {
      setRuntime([]);
      return;
    }
    runtimeRefreshTimerRef.current = window.setTimeout(() => {
      runtimeRefreshTimerRef.current = null;
      void refreshRuntime();
    }, 140);
    return () => {
      if (runtimeRefreshTimerRef.current != null) {
        window.clearTimeout(runtimeRefreshTimerRef.current);
        runtimeRefreshTimerRef.current = null;
      }
    };
  }, [refreshRuntime, showWelcome]);

  // Subscribe to process events (filtered to current effective lane)
  useEffect(() => {
    const unsub = window.ade.processes.onEvent((ev: ProcessEvent) => {
      if (ev.type === "runtime") {
        const currentLaneId = effectiveLaneIdRef.current;
        if (currentLaneId && ev.runtime.laneId !== currentLaneId) return;
        setRuntime((prev) => {
          const idx = prev.findIndex(
            (r) => r.processId === ev.runtime.processId && r.laneId === ev.runtime.laneId
          );
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = ev.runtime;
            return next;
          }
          return [...prev, ev.runtime];
        });
      }
    });
    return unsub;
  }, []);

  // Derived
  const stacks: StackButtonDefinition[] = config?.effective.stackButtons ?? [];
  const processNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of definitions) map[d.id] = d.name;
    return map;
  }, [definitions]);

  const filteredDefinitions = useMemo(() => {
    if (!selectedStackId) return definitions;
    const stack = stacks.find((s) => s.id === selectedStackId);
    if (!stack) return definitions;
    const ids = new Set(stack.processIds);
    return definitions.filter((d) => ids.has(d.id));
  }, [definitions, selectedStackId, stacks]);

  const runtimeMap = useMemo(() => {
    const map: Record<string, ProcessRuntime> = {};
    for (const r of runtime) map[r.processId] = r;
    return map;
  }, [runtime]);

  // Actions
  const handleRun = useCallback(
    async (processId: string) => {
      try {
        if (!effectiveLaneId) return;
        const def = definitions.find((d) => d.id === processId);
        if (!def) return;
        // Start the managed process
        await window.ade.processes.start({ laneId: effectiveLaneId, processId });
        // Also open a shell in the Work tab for manual inspection, but do not
        // replay the managed process command there.
        try {
          await window.ade.pty.create({
            laneId: effectiveLaneId,
            cols: 120,
            rows: 30,
            title: `${def.name} inspector`,
            tracked: true,
            toolType: "run-shell",
          });
        } catch {
          // Terminal creation is best-effort
        }
      } catch (err) {
        console.error("[RunPage] handleRun failed:", err);
      }
    },
    [effectiveLaneId, definitions]
  );

  const handleStop = useCallback(
    async (processId: string) => {
      try {
        if (!effectiveLaneId) return;
        await window.ade.processes.stop({ laneId: effectiveLaneId, processId });
      } catch (err) {
        console.error("[RunPage] handleStop failed:", err);
      }
    },
    [effectiveLaneId]
  );

  const handleKill = useCallback(
    async (processId: string) => {
      try {
        if (!effectiveLaneId) return;
        await window.ade.processes.kill({ laneId: effectiveLaneId, processId });
      } catch (err) {
        console.error("[RunPage] handleKill failed:", err);
      }
    },
    [effectiveLaneId]
  );

  const handleStartAll = useCallback(async () => {
    try {
      if (!effectiveLaneId) return;
      if (selectedStackId) {
        await window.ade.processes.startStack({ laneId: effectiveLaneId, stackId: selectedStackId });
      } else {
        await window.ade.processes.startAll({ laneId: effectiveLaneId });
      }
      // Create inspector terminals for each process being started so the user
      // gets a shell tab per process (matching the behavior of handleRun).
      const targetDefs = selectedStackId
        ? (() => {
            const stack = stacks.find((s) => s.id === selectedStackId);
            if (!stack) return definitions;
            const ids = new Set(stack.processIds);
            return definitions.filter((d) => ids.has(d.id));
          })()
        : definitions;
      for (const def of targetDefs) {
        try {
          await window.ade.pty.create({
            laneId: effectiveLaneId,
            cols: 120,
            rows: 30,
            title: `${def.name} inspector`,
            tracked: true,
            toolType: "run-shell",
          });
        } catch {
          // Terminal creation is best-effort
        }
      }
    } catch (err) {
      console.error("[RunPage] handleStartAll failed:", err);
    }
  }, [effectiveLaneId, selectedStackId, definitions, stacks]);

  const handleStopAll = useCallback(async () => {
    try {
      if (!effectiveLaneId) return;
      if (selectedStackId) {
        await window.ade.processes.stopStack({ laneId: effectiveLaneId, stackId: selectedStackId });
      } else {
        await window.ade.processes.stopAll({ laneId: effectiveLaneId });
      }
    } catch (err) {
      console.error("[RunPage] handleStopAll failed:", err);
    }
  }, [effectiveLaneId, selectedStackId]);

  // Config mutations
  const saveProcessToConfig = useCallback(
    async (cmd: {
      name: string;
      command: string;
      stackId: string | null;
      newStackName: string | null;
      cwd: string;
      env: string;
    }) => {
      if (!config) return;
      const processId = generateId();
      const newProcess: ConfigProcessDefinition = {
        id: processId,
        name: cmd.name,
        command: parseCommandLine(cmd.command),
        cwd: cmd.cwd === "." ? undefined : cmd.cwd,
        env: parseEnvText(cmd.env),
      };

      const shared = { ...config.shared };
      const processes = [...(shared.processes ?? []), newProcess];
      shared.processes = processes;

      // Handle stack assignment
      let stackButtons = [...(shared.stackButtons ?? [])];
      let targetStackId = cmd.stackId;

      if (cmd.newStackName) {
        const newStack: ConfigStackButtonDefinition = {
          id: generateId(),
          name: cmd.newStackName,
          processIds: [processId],
        };
        stackButtons = [...stackButtons, newStack];
        targetStackId = newStack.id;
      } else if (targetStackId) {
        stackButtons = stackButtons.map((s) =>
          s.id === targetStackId
            ? { ...s, processIds: [...(s.processIds ?? []), processId] }
            : s
        );
      }
      shared.stackButtons = stackButtons;

      await window.ade.projectConfig.save({ shared, local: config.local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime]
  );

  const updateProcessInConfig = useCallback(
    async (
      processId: string,
      cmd: {
        name: string;
        command: string;
        stackId: string | null;
        newStackName: string | null;
        cwd: string;
        env: string;
      }
    ) => {
      if (!config) return;
      const shared = { ...config.shared };

      // Update the process definition
      shared.processes = (shared.processes ?? []).map((p) =>
        p.id === processId
          ? {
              ...p,
              name: cmd.name,
              command: parseCommandLine(cmd.command),
              cwd: cmd.cwd === "." ? undefined : cmd.cwd,
              env: parseEnvText(cmd.env),
            }
          : p
      );

      // Update stack assignment: remove from all stacks first, then add to target
      let stackButtons = (shared.stackButtons ?? []).map((s) => ({
        ...s,
        processIds: (s.processIds ?? []).filter((id) => id !== processId),
      }));

      let targetStackId = cmd.stackId;

      if (cmd.newStackName) {
        stackButtons = [
          ...stackButtons,
          { id: generateId(), name: cmd.newStackName, processIds: [processId] },
        ];
      } else if (targetStackId) {
        stackButtons = stackButtons.map((s) =>
          s.id === targetStackId
            ? { ...s, processIds: [...(s.processIds ?? []), processId] }
            : s
        );
      }

      shared.stackButtons = stackButtons;
      await window.ade.projectConfig.save({ shared, local: config.local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime]
  );

  const handleDeleteProcess = useCallback(
    async (processId: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      shared.processes = (shared.processes ?? []).filter((p) => p.id !== processId);
      shared.stackButtons = (shared.stackButtons ?? []).map((s) => ({
        ...s,
        processIds: (s.processIds ?? []).filter((id) => id !== processId),
      }));
      await window.ade.projectConfig.save({ shared, local: config.local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime]
  );

  const handleCreateStack = useCallback(
    async (name: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      const newStack: ConfigStackButtonDefinition = {
        id: generateId(),
        name,
        processIds: [],
      };
      shared.stackButtons = [...(shared.stackButtons ?? []), newStack];
      await window.ade.projectConfig.save({ shared, local: config.local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime]
  );

  const handleRenameStack = useCallback(
    async (stackId: string, name: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      shared.stackButtons = (shared.stackButtons ?? []).map((s) =>
        s.id === stackId ? { ...s, name } : s
      );
      await window.ade.projectConfig.save({ shared, local: config.local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime]
  );

  const handleDeleteStack = useCallback(
    async (stackId: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      shared.stackButtons = (shared.stackButtons ?? []).filter((s) => s.id !== stackId);
      await window.ade.projectConfig.save({ shared, local: config.local });
      if (selectedStackId === stackId) setSelectedStackId(null);
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime, selectedStackId]
  );

  const handleEditProcess = useCallback(
    (processId: string) => {
      const def = definitions.find((d) => d.id === processId);
      if (!def) return;
      // Find which stack this process belongs to
      const currentStack = stacks.find((s) => s.processIds.includes(processId));
      setEditingProcess({
        id: processId,
        values: {
          name: def.name,
          command: commandArrayToLine(def.command),
          stackId: currentStack?.id ?? null,
          cwd: def.cwd || ".",
          env: envToText(def.env),
        },
      });
    },
    [definitions, stacks]
  );

  const handleMoveToStack = useCallback((processId: string) => {
    setMoveToStackProcessId(processId);
  }, []);

  const handleMoveProcessToStack = useCallback(
    async (processId: string, targetStackId: string | null) => {
      if (!config) return;
      const shared = { ...config.shared };

      // Remove from all stacks, then add to target
      let stackButtons = (shared.stackButtons ?? []).map((s) => ({
        ...s,
        processIds: (s.processIds ?? []).filter((id) => id !== processId),
      }));

      if (targetStackId) {
        stackButtons = stackButtons.map((s) =>
          s.id === targetStackId
            ? { ...s, processIds: [...(s.processIds ?? []), processId] }
            : s
        );
      }

      shared.stackButtons = stackButtons;
      await window.ade.projectConfig.save({ shared, local: config.local });
      setMoveToStackProcessId(null);
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime]
  );

  // Show welcome screen when no project is currently selected or user has closed all projects.
  if (showWelcome) {
    return <WelcomeScreen />;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: COLORS.pageBg,
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "16px 20px",
          borderBottom: `1px solid ${COLORS.border}`,
          flexShrink: 0,
        }}
      >
        {/* Page title */}
        <h1
          style={{
            fontFamily: SANS_FONT,
            fontSize: 18,
            fontWeight: 700,
            color: COLORS.textPrimary,
            margin: 0,
          }}
        >
          Run
        </h1>

        {/* Lane selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={LABEL_STYLE}>Lane</span>
          <select
            value={effectiveLaneId ?? ""}
            onChange={(e) => selectRunLane(e.target.value || null)}
            style={{
              height: 28,
              padding: "0 8px",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.outlineBorder}`,
              borderRadius: 0,
              fontFamily: MONO_FONT,
              fontSize: 11,
              color: COLORS.textPrimary,
              outline: "none",
              minWidth: 120,
            }}
          >
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </div>

        {/* Stack label + count (inline, only when processes exist) */}
        {filteredDefinitions.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                fontWeight: 700,
                color: COLORS.textPrimary,
              }}
            >
              {selectedStackId
                ? stacks.find((s) => s.id === selectedStackId)?.name ?? "Stack"
                : "All Commands"}
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                color: COLORS.textDim,
              }}
            >
              ({filteredDefinitions.length})
            </span>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Start All / Stop All (only when processes exist) */}
        {filteredDefinitions.length > 0 && (
          <>
            <button type="button" onClick={handleStartAll} style={primaryButton({ height: 28, fontSize: 10 })}>
              <Play size={12} weight="fill" />
              Start All
            </button>
            <button
              type="button"
              onClick={handleStopAll}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 28,
                padding: "0 12px",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: COLORS.danger,
                background: `${COLORS.danger}18`,
                border: `1px solid ${COLORS.danger}30`,
                borderRadius: 0,
                cursor: "pointer",
              }}
            >
              <Stop size={12} weight="fill" />
              Stop All
            </button>
          </>
        )}

        {/* Action buttons */}
        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          style={outlineButton()}
        >
          <Plus size={14} weight="bold" />
          Add
        </button>

        {/* Network drawer toggle */}
        <button
          type="button"
          onClick={() => setNetworkDrawerOpen((prev) => !prev)}
          aria-label="Toggle network panel"
          style={{
            ...outlineButton({ height: 28, padding: "0 8px" }),
            color: networkDrawerOpen ? COLORS.accent : COLORS.textMuted,
            borderColor: networkDrawerOpen ? `${COLORS.accent}60` : COLORS.outlineBorder,
          }}
        >
          <Globe size={14} />
        </button>
      </div>

      {/* ── Runtime Bar ── */}
      <LaneRuntimeBar laneId={effectiveLaneId} />

      {/* ── Body: Sidebar + Main ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        {/* Sidebar (hidden when no stacks) */}
        {stacks.length > 0 && (
          <RunSidebar
            stacks={stacks}
            selectedStackId={selectedStackId}
            onSelectStack={setSelectedStackId}
            onCreateStack={handleCreateStack}
            onRenameStack={handleRenameStack}
            onDeleteStack={handleDeleteStack}
          />
        )}

        {/* Main content */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Command cards grid */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 20,
            }}
          >
            {loading && filteredDefinitions.length === 0 ? (
              <div
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textDim,
                  textAlign: "center",
                  padding: "40px 0",
                }}
              >
                Loading...
              </div>
            ) : filteredDefinitions.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  padding: "60px 20px",
                }}
              >
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: COLORS.textMuted,
                    textAlign: "center",
                  }}
                >
                  No commands configured
                </div>
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    color: COLORS.textDim,
                    textAlign: "center",
                    maxWidth: 300,
                  }}
                >
                  Add a command for the lane you want to run, then start it here to get runtime state and preview routing.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button type="button" onClick={() => setAddDialogOpen(true)} style={primaryButton()}>
                    <Plus size={14} weight="bold" />
                    Add Command
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: 12,
                }}
              >
                {filteredDefinitions.map((def) => (
                  <CommandCard
                    key={def.id}
                    definition={def}
                    runtime={runtimeMap[def.id] ?? null}
                    stacks={stacks}
                    onRun={handleRun}
                    onStop={handleStop}
                    onEdit={handleEditProcess}
                    onDelete={handleDeleteProcess}
                    onMoveToStack={handleMoveToStack}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Network drawer (slide-out overlay from right) */}
        {networkDrawerOpen && (
          <>
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                zIndex: 90,
              }}
              onClick={() => setNetworkDrawerOpen(false)}
            />
            <div
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                zIndex: 91,
              }}
            >
              <RunNetworkPanel onClose={() => setNetworkDrawerOpen(false)} />
            </div>
          </>
        )}
      </div>

      {/* ── Process Monitor (bottom bar) ── */}
      <ProcessMonitor
        laneId={effectiveLaneId}
        runtimes={runtime}
        processNames={processNames}
        onKill={handleKill}
      />

      {/* ── Dialogs ── */}
      <AddCommandDialog
        stacks={stacks}
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSubmit={saveProcessToConfig}
        laneRootPath={selectedLane?.worktreePath ?? null}
      />

      {/* ── Edit Process Dialog (reuses AddCommandDialog) ── */}
      <AddCommandDialog
        stacks={stacks}
        open={editingProcess !== null}
        onClose={() => setEditingProcess(null)}
        onSubmit={(cmd) => {
          if (editingProcess) {
            void updateProcessInConfig(editingProcess.id, cmd);
            setEditingProcess(null);
          }
        }}
        initialValues={editingProcess?.values ?? null}
        title="Edit Command"
        submitLabel="Save"
        laneRootPath={selectedLane?.worktreePath ?? null}
      />

      {/* ── Move to Stack Dialog ── */}
      {moveToStackProcessId !== null && (
        <MoveToStackDialog
          processId={moveToStackProcessId}
          processName={processNames[moveToStackProcessId] ?? moveToStackProcessId}
          stacks={stacks}
          currentStackId={stacks.find((s) => s.processIds.includes(moveToStackProcessId))?.id ?? null}
          onMove={handleMoveProcessToStack}
          onClose={() => setMoveToStackProcessId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Move-to-Stack Dialog
// ---------------------------------------------------------------------------

type MoveToStackDialogProps = {
  processId: string;
  processName: string;
  stacks: StackButtonDefinition[];
  currentStackId: string | null;
  onMove: (processId: string, stackId: string | null) => void;
  onClose: () => void;
};

function MoveToStackDialog({
  processId,
  processName,
  stacks,
  currentStackId,
  onMove,
  onClose,
}: MoveToStackDialogProps) {
  const [selected, setSelected] = useState<string>(currentStackId ?? "__none__");

  const canSubmit = selected !== (currentStackId ?? "__none__");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 0,
          width: 360,
          maxWidth: "90vw",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 12,
              fontWeight: 700,
              color: COLORS.textPrimary,
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
          >
            Move to Stack
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: COLORS.textMuted,
              cursor: "pointer",
              padding: 2,
              display: "flex",
            }}
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              color: COLORS.textMuted,
            }}
          >
            Move <strong style={{ color: COLORS.textPrimary }}>{processName}</strong> to:
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {/* No stack option */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                cursor: "pointer",
                background: selected === "__none__" ? COLORS.hoverBg : "transparent",
                border: `1px solid ${selected === "__none__" ? COLORS.accent : COLORS.border}`,
                borderRadius: 0,
              }}
            >
              <input
                type="radio"
                name="stack"
                value="__none__"
                checked={selected === "__none__"}
                onChange={(e) => setSelected(e.target.value)}
                style={{ margin: 0 }}
              />
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textSecondary,
                  fontStyle: "italic",
                }}
              >
                No stack
              </span>
            </label>

            {stacks.map((stack) => (
              <label
                key={stack.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  cursor: "pointer",
                  background: selected === stack.id ? COLORS.hoverBg : "transparent",
                  border: `1px solid ${selected === stack.id ? COLORS.accent : COLORS.border}`,
                  borderRadius: 0,
                }}
              >
                <input
                  type="radio"
                  name="stack"
                  value={stack.id}
                  checked={selected === stack.id}
                  onChange={(e) => setSelected(e.target.value)}
                  style={{ margin: 0 }}
                />
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    color: COLORS.textPrimary,
                    fontWeight: 600,
                  }}
                >
                  {stack.name}
                </span>
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textDim,
                    marginLeft: "auto",
                  }}
                >
                  {stack.processIds.length} cmd{stack.processIds.length !== 1 ? "s" : ""}
                </span>
              </label>
            ))}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={outlineButton()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => onMove(processId, selected === "__none__" ? null : selected)}
              style={primaryButton({ opacity: canSubmit ? 1 : 0.4, cursor: canSubmit ? "pointer" : "default" })}
            >
              Move
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
