import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Stop, Plus, X, FolderOpen, Folder, Terminal } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { CommandCard } from "./CommandCard";
import { CommandPalette } from "../app/CommandPalette";
import { ProcessMonitor, type RunShellSession } from "./ProcessMonitor";
import { LaneRuntimeBar } from "./LaneRuntimeBar";
import { AddCommandDialog, type AddCommandInitialValues } from "./AddCommandDialog";
import { RunStackTabs } from "./RunStackTabs";
import { RunNetworkPanel } from "./RunNetworkPanel";
import { commandArrayToLine, parseCommandLine } from "../../lib/shell";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { toRelativeTime } from "../graph/graphHelpers";
import type {
  ProcessDefinition,
  ProcessRuntime,
  ProcessEvent,
  StackButtonDefinition,
  ProjectConfigSnapshot,
  ConfigProcessReadiness,
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

function parseDependsOnCsv(value: string): string[] | undefined {
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function parseGracefulShutdownMs(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function buildReadinessConfig(args: {
  readinessType: "none" | "port" | "logRegex";
  readinessPort: string;
  readinessPattern: string;
}): ConfigProcessReadiness | undefined {
  if (args.readinessType === "port") {
    const port = Number.parseInt(args.readinessPort.trim(), 10);
    return Number.isFinite(port) && port > 0 ? { type: "port", port } : undefined;
  }
  if (args.readinessType === "logRegex") {
    const pattern = args.readinessPattern.trim();
    return pattern.length > 0 ? { type: "logRegex", pattern } : undefined;
  }
  return undefined;
}

function WelcomeScreen() {
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const [recentProjects, setRecentProjects] = useState<Array<{ rootPath: string; displayName: string; exists: boolean; lastOpenedAt?: string; laneCount?: number }>>([]);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);

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
        background: `radial-gradient(circle at 50% 30%, ${COLORS.accent}15 0%, ${COLORS.pageBg} 40%)`,
        gap: 32,
        padding: 48,
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 520 }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 16,
          animation: "pulse-glow 3s infinite",
        }}>
          <img src="./logo.png" alt="ADE Logo" style={{ width: 280, height: 280, objectFit: "contain" }} />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setProjectBrowserOpen(true)}
        style={{
          ...primaryButton({ height: 48, padding: "0 32px", fontSize: 14 }),
          gap: 12,
          boxShadow: `0 4px 20px ${COLORS.accent}40`,
          transition: "transform 0.2s ease, box-shadow 0.2s ease",
          marginTop: -16, // pull closer to logo
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "translateY(-2px)";
          e.currentTarget.style.boxShadow = `0 6px 24px ${COLORS.accent}60`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "none";
          e.currentTarget.style.boxShadow = `0 4px 20px ${COLORS.accent}40`;
        }}
      >
        <FolderOpen size={20} weight="regular" />
        OPEN PROJECT
      </button>

      {realProjects.length > 0 && (
        <div style={{ width: "100%", maxWidth: 440, marginTop: 8 }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 12, textAlign: "center", color: COLORS.textMuted }}>RECENT PROJECTS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {realProjects.map((rp) => (
              <button
                key={rp.rootPath}
                type="button"
                onClick={() => void switchProjectToPath(rp.rootPath)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 16px",
                  background: "rgba(255,255,255,0.02)",
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 12,
                  color: COLORS.textPrimary,
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.2s ease",
                  backdropFilter: "blur(10px)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = COLORS.accent + "60";
                  e.currentTarget.style.background = "rgba(255,255,255,0.05)";
                  e.currentTarget.style.transform = "scale(1.01)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = COLORS.border;
                  e.currentTarget.style.background = "rgba(255,255,255,0.02)";
                  e.currentTarget.style.transform = "none";
                }}
              >
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: `${COLORS.accent}15`,
                  color: COLORS.accent,
                  flexShrink: 0,
                }}>
                  <Folder size={16} weight="regular" />
                </div>
                <div style={{ overflow: "hidden", flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{rp.displayName}</div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {rp.rootPath}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  {rp.laneCount !== undefined && (
                    <span style={{
                      fontSize: 10,
                      background: `${COLORS.accent}20`,
                      color: COLORS.accent,
                      padding: "2px 6px",
                      borderRadius: 10,
                      fontWeight: 600,
                    }}>
                      {rp.laneCount} lane{rp.laneCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {rp.lastOpenedAt && (
                    <span style={{ fontSize: 9, color: COLORS.textDim }}>
                      {toRelativeTime(rp.lastOpenedAt)}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <CommandPalette
        open={projectBrowserOpen}
        onOpenChange={setProjectBrowserOpen}
        intent="project-browse"
      />
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [runShellSessions, setRunShellSessions] = useState<RunShellSession[]>([]);
  const [shellBusy, setShellBusy] = useState(false);
  const [networkDrawerOpen, setNetworkDrawerOpen] = useState(false);
  const [monitorFocusTarget, setMonitorFocusTarget] = useState<{ kind: "process" | "shell"; id: string } | null>(null);
  const [monitorFocusSequence, setMonitorFocusSequence] = useState(0);
  const runtimeRefreshTimerRef = useRef<number | null>(null);
  const runShellSessionsRef = useRef<RunShellSession[]>([]);

  const effectiveLaneId = runLaneId ?? selectedLaneId ?? null;
  const effectiveLaneIdRef = useRef(effectiveLaneId);
  effectiveLaneIdRef.current = effectiveLaneId;
  const selectedLane = useMemo(
    () => lanes.find((lane) => lane.id === effectiveLaneId) ?? null,
    [effectiveLaneId, lanes]
  );
  runShellSessionsRef.current = runShellSessions;

  const focusMonitor = useCallback((target: { kind: "process" | "shell"; id: string } | null) => {
    setMonitorFocusTarget(target);
    setMonitorFocusSequence((current) => current + 1);
  }, []);

  const disposeRunShellSessions = useCallback(async (sessions: RunShellSession[]) => {
    if (sessions.length === 0) return;
    await Promise.allSettled(
      sessions.map((session) => window.ade.pty.dispose({ ptyId: session.ptyId, sessionId: session.sessionId })),
    );
  }, []);

  useEffect(() => {
    logRendererDebugEvent("renderer.run.page_mount");
    return () => {
      logRendererDebugEvent("renderer.run.page_unmount");
    };
  }, []);

  useEffect(() => {
    return () => {
      void disposeRunShellSessions(runShellSessionsRef.current);
    };
  }, [disposeRunShellSessions]);

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

    const startedAt = performance.now();
    logRendererDebugEvent("renderer.run.refresh_definitions.begin", {
      effectiveLaneId: effectiveLaneIdRef.current ?? null,
    });
    setLoading(true);
    try {
      const [nextConfig, nextDefs] = await Promise.all([
        window.ade.projectConfig.get(),
        window.ade.processes.listDefinitions(),
      ]);
      setConfig(nextConfig);
      setDefinitions(nextDefs);
      logRendererDebugEvent("renderer.run.refresh_definitions.done", {
        effectiveLaneId: effectiveLaneIdRef.current ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        definitionCount: nextDefs.length,
        processCount: nextConfig.effective.processes.length,
      });
    } catch (err) {
      logRendererDebugEvent("renderer.run.refresh_definitions.failed", {
        effectiveLaneId: effectiveLaneIdRef.current ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      });
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
    const startedAt = performance.now();
    logRendererDebugEvent("renderer.run.refresh_runtime.begin", {
      effectiveLaneId,
    });
    try {
      const nextRuntime = await window.ade.processes.listRuntime(effectiveLaneId);
      setRuntime(nextRuntime);
      logRendererDebugEvent("renderer.run.refresh_runtime.done", {
        effectiveLaneId,
        durationMs: Math.round(performance.now() - startedAt),
        runtimeCount: nextRuntime.length,
      });
    } catch (err) {
      logRendererDebugEvent("renderer.run.refresh_runtime.failed", {
        effectiveLaneId,
        durationMs: Math.round(performance.now() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      });
      console.error("RunPage.refreshRuntime", err);
    }
  }, [effectiveLaneId, showWelcome]);

  useEffect(() => {
    if (showWelcome) return;
    void refreshDefinitions();
  }, [refreshDefinitions, showWelcome]);

  useEffect(() => {
    setActionError(null);
  }, [effectiveLaneId]);

  useEffect(() => {
    const previousSessions = runShellSessionsRef.current;
    setRunShellSessions([]);
    if (previousSessions.length === 0) return;
    void disposeRunShellSessions(previousSessions);
  }, [disposeRunShellSessions, effectiveLaneId]);

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
        if (!currentLaneId || ev.runtime.laneId !== currentLaneId) return;
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
  const stacks = useMemo<StackButtonDefinition[]>(
    () => config?.effective.stackButtons ?? [],
    [config?.effective.stackButtons],
  );
  const selectedStack = useMemo(
    () => stacks.find((stack) => stack.id === selectedStackId) ?? null,
    [selectedStackId, stacks],
  );
  const processNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of definitions) map[d.id] = d.name;
    return map;
  }, [definitions]);

  const processDefinitions = useMemo(() => {
    const map: Record<string, ProcessDefinition> = {};
    for (const definition of definitions) map[definition.id] = definition;
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
        setActionError(null);
        await window.ade.processes.start({ laneId: effectiveLaneId, processId });
        focusMonitor({ kind: "process", id: processId });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        console.error("[RunPage] handleRun failed:", err);
      }
    },
    [effectiveLaneId, focusMonitor]
  );

  const handleStop = useCallback(
    async (processId: string) => {
      try {
        if (!effectiveLaneId) return;
        setActionError(null);
        await window.ade.processes.stop({ laneId: effectiveLaneId, processId });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        console.error("[RunPage] handleStop failed:", err);
      }
    },
    [effectiveLaneId]
  );

  const handleRestart = useCallback(
    async (processId: string) => {
      try {
        if (!effectiveLaneId) return;
        setActionError(null);
        await window.ade.processes.restart({ laneId: effectiveLaneId, processId });
        focusMonitor({ kind: "process", id: processId });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        console.error("[RunPage] handleRestart failed:", err);
      }
    },
    [effectiveLaneId, focusMonitor]
  );

  const handleKill = useCallback(
    async (processId: string) => {
      try {
        if (!effectiveLaneId) return;
        setActionError(null);
        await window.ade.processes.kill({ laneId: effectiveLaneId, processId });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        console.error("[RunPage] handleKill failed:", err);
      }
    },
    [effectiveLaneId]
  );

  const handleStartAll = useCallback(async () => {
    try {
      if (!effectiveLaneId) return;
      setActionError(null);
      if (selectedStackId) {
        await window.ade.processes.startStack({ laneId: effectiveLaneId, stackId: selectedStackId });
        const firstProcessId = selectedStack?.processIds[0] ?? null;
        if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
      } else {
        await window.ade.processes.startAll({ laneId: effectiveLaneId });
        const firstProcessId = filteredDefinitions[0]?.id ?? null;
        if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
      }
    } catch (err) {
      // Auto-confirm trust when the user explicitly starts processes.
      if (err instanceof Error && err.message.includes("ADE_TRUST_REQUIRED") && effectiveLaneId) {
        try {
          await window.ade.projectConfig.confirmTrust();
          if (selectedStackId) {
            await window.ade.processes.startStack({ laneId: effectiveLaneId, stackId: selectedStackId });
            const firstProcessId = selectedStack?.processIds[0] ?? null;
            if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
          } else {
            await window.ade.processes.startAll({ laneId: effectiveLaneId });
            const firstProcessId = filteredDefinitions[0]?.id ?? null;
            if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
          }
          return;
        } catch (retryErr) {
          setActionError(retryErr instanceof Error ? retryErr.message : String(retryErr));
          return;
        }
      }
      setActionError(err instanceof Error ? err.message : String(err));
      console.error("[RunPage] handleStartAll failed:", err);
    }
  }, [effectiveLaneId, filteredDefinitions, focusMonitor, selectedStack, selectedStackId]);

  const handleStopAll = useCallback(async () => {
    try {
      if (!effectiveLaneId) return;
      setActionError(null);
      if (selectedStackId) {
        await window.ade.processes.stopStack({ laneId: effectiveLaneId, stackId: selectedStackId });
      } else {
        await window.ade.processes.stopAll({ laneId: effectiveLaneId });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      console.error("[RunPage] handleStopAll failed:", err);
    }
  }, [effectiveLaneId, selectedStackId]);

  const handleRestartStack = useCallback(
    async (stackId: string) => {
      try {
        if (!effectiveLaneId) return;
        setActionError(null);
        await window.ade.processes.restartStack({ laneId: effectiveLaneId, stackId });
        const targetStack = stacks.find((stack) => stack.id === stackId);
        const firstProcessId = targetStack?.processIds[0] ?? null;
        if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        console.error("[RunPage] handleRestartStack failed:", err);
      }
    },
    [effectiveLaneId, focusMonitor, stacks],
  );

  const handleLaunchShell = useCallback(async () => {
    if (!effectiveLaneId || shellBusy) return;
    setShellBusy(true);
    setActionError(null);
    try {
      const existingCount = runShellSessionsRef.current.length;
      const title = existingCount > 0 ? `Shell ${existingCount + 1}` : "Shell";
      const result = await window.ade.pty.create({
        laneId: effectiveLaneId,
        cols: 100,
        rows: 30,
        title,
        tracked: false,
        toolType: "shell",
      });
      const session: RunShellSession = { sessionId: result.sessionId, ptyId: result.ptyId, title };
      setRunShellSessions((current) => [...current, session]);
      focusMonitor({ kind: "shell", id: session.sessionId });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setShellBusy(false);
    }
  }, [effectiveLaneId, focusMonitor, shellBusy]);

  const handleCloseRunShell = useCallback(async (sessionId: string) => {
    const target = runShellSessionsRef.current.find((session) => session.sessionId === sessionId);
    setRunShellSessions((current) => current.filter((session) => session.sessionId !== sessionId));
    if (!target) return;
    try {
      await window.ade.pty.dispose({ ptyId: target.ptyId, sessionId: target.sessionId });
    } catch {
      // ignore shell disposal failures in the Run tab
    }
  }, []);

  // Config mutations
  const saveProcessToConfig = useCallback(
    async (cmd: {
      name: string;
      command: string;
      stackId: string | null;
      newStackName: string | null;
      cwd: string;
      env: string;
      autostart: boolean;
      restart: AddCommandInitialValues["restart"];
      gracefulShutdownMs: string;
      dependsOn: string;
      readinessType: AddCommandInitialValues["readinessType"];
      readinessPort: string;
      readinessPattern: string;
    }) => {
      if (!config) return;
      const processId = generateId();
      const newProcess: ConfigProcessDefinition = {
        id: processId,
        name: cmd.name,
        command: parseCommandLine(cmd.command),
        cwd: cmd.cwd === "." ? undefined : cmd.cwd,
        env: parseEnvText(cmd.env),
        autostart: cmd.autostart ? true : undefined,
        restart: cmd.restart !== "never" ? cmd.restart : undefined,
        gracefulShutdownMs: parseGracefulShutdownMs(cmd.gracefulShutdownMs),
        dependsOn: parseDependsOnCsv(cmd.dependsOn),
        readiness: buildReadinessConfig(cmd),
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
        autostart: boolean;
        restart: AddCommandInitialValues["restart"];
        gracefulShutdownMs: string;
        dependsOn: string;
        readinessType: AddCommandInitialValues["readinessType"];
        readinessPort: string;
        readinessPattern: string;
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
              autostart: cmd.autostart ? true : undefined,
              restart: cmd.restart !== "never" ? cmd.restart : undefined,
              gracefulShutdownMs: parseGracefulShutdownMs(cmd.gracefulShutdownMs),
              dependsOn: parseDependsOnCsv(cmd.dependsOn),
              readiness: buildReadinessConfig(cmd),
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

  const handleUpdateStackStartOrder = useCallback(
    async (stackId: string, startOrder: "parallel" | "dependency") => {
      if (!config) return;
      const shared = { ...config.shared };
      shared.stackButtons = (shared.stackButtons ?? []).map((stack) =>
        stack.id === stackId ? { ...stack, startOrder } : stack,
      );
      await window.ade.projectConfig.save({ shared, local: config.local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime],
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
          autostart: def.autostart,
          restart: def.restart,
          gracefulShutdownMs: String(def.gracefulShutdownMs ?? 7000),
          dependsOn: (def.dependsOn ?? []).join(", "),
          readinessType: def.readiness.type,
          readinessPort: def.readiness.type === "port" ? String(def.readiness.port ?? "") : "",
          readinessPattern: def.readiness.type === "logRegex" ? def.readiness.pattern ?? "" : "",
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
            onChange={(e) => selectRunLane(e.target.value.length ? e.target.value : null)}
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
            <option value="">
              No lane selected
            </option>
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </div>

        {/* Selection summary */}
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
                ? selectedStack?.name ?? "Stack"
                : "All commands"}
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
            {selectedStack ? (
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 9,
                  color: COLORS.textDim,
                  border: `1px solid ${COLORS.border}`,
                  padding: "1px 4px",
                }}
              >
                {selectedStack.startOrder === "dependency" ? "dependency order" : "parallel order"}
              </span>
            ) : null}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Start All / Stop All (only when processes exist) */}
        {filteredDefinitions.length > 0 && (
          <>
            <button type="button" onClick={handleStartAll} style={primaryButton({ height: 28, fontSize: 10 })}>
              <Play size={12} weight="fill" />
              {selectedStack ? "Start Stack" : "Start All"}
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
              {selectedStack ? "Stop Stack" : "Stop All"}
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => void handleLaunchShell()}
          disabled={!effectiveLaneId || shellBusy}
          style={{
            ...outlineButton(),
            opacity: effectiveLaneId && !shellBusy ? 1 : 0.45,
            cursor: effectiveLaneId && !shellBusy ? "pointer" : "default",
          }}
        >
          <Terminal size={14} weight="bold" />
          {shellBusy ? "Opening shell..." : "New shell"}
        </button>

        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          style={outlineButton()}
        >
          <Plus size={14} weight="bold" />
          Add command
        </button>
      </div>

      {/* ── Runtime Bar ── */}
      <LaneRuntimeBar
        laneId={effectiveLaneId}
        onOpenPreviewRouting={() => setNetworkDrawerOpen(true)}
      />

      {/* ── Stack tabs ── */}
      <RunStackTabs
        stacks={stacks}
        selectedStackId={selectedStackId}
        onSelectStack={setSelectedStackId}
        onCreateStack={handleCreateStack}
        onRenameStack={handleRenameStack}
        onDeleteStack={handleDeleteStack}
        onStartStack={async (stackId) => {
          if (!effectiveLaneId) return;
          setActionError(null);
          try {
            await window.ade.processes.startStack({ laneId: effectiveLaneId, stackId });
            const targetStack = stacks.find((stack) => stack.id === stackId);
            const firstProcessId = targetStack?.processIds[0] ?? null;
            if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
          } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
          }
        }}
        onStopStack={async (stackId) => {
          if (!effectiveLaneId) return;
          setActionError(null);
          try {
            await window.ade.processes.stopStack({ laneId: effectiveLaneId, stackId });
          } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
          }
        }}
        onRestartStack={(stackId) => {
          void handleRestartStack(stackId);
        }}
        onUpdateStackStartOrder={handleUpdateStackStartOrder}
      />

      {/* ── Main content ── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {actionError ? (
          <div
            style={{
              margin: "20px 20px 0",
              padding: "10px 12px",
              border: `1px solid ${COLORS.danger}40`,
              borderLeft: `3px solid ${COLORS.danger}`,
              background: `${COLORS.danger}12`,
              color: COLORS.textPrimary,
              fontFamily: MONO_FONT,
              fontSize: 11,
              whiteSpace: "pre-wrap",
            }}
          >
            {actionError}
          </div>
        ) : null}

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
                No commands in this view
              </div>
              <div
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textDim,
                  textAlign: "center",
                  maxWidth: 340,
                }}
              >
                Add a command, pick a stack tab, then run it here. Output opens in the bottom panel automatically.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button type="button" onClick={() => setAddDialogOpen(true)} style={primaryButton()}>
                  <Plus size={14} weight="bold" />
                  Add command
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
                  onRestart={handleRestart}
                  onEdit={handleEditProcess}
                  onDelete={handleDeleteProcess}
                  onMoveToStack={handleMoveToStack}
                />
              ))}
            </div>
          )}
        </div>

        {networkDrawerOpen ? (
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
        ) : null}
      </div>

      {/* ── Process Monitor (bottom bar) ── */}
      <ProcessMonitor
        laneId={effectiveLaneId}
        runtimes={runtime}
        processDefinitions={processDefinitions}
        processNames={processNames}
        shellSessions={runShellSessions}
        focusTarget={monitorFocusTarget}
        focusSequence={monitorFocusSequence}
        onKill={handleKill}
        onCloseShell={(sessionId) => {
          void handleCloseRunShell(sessionId);
        }}
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
        title="Edit command"
        submitLabel="Save changes"
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
