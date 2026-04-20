import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderOpen, Play, Plus, Stop, Terminal } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
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
  ConfigProcessDefinition,
  ConfigProcessReadiness,
  ConfigStackButtonDefinition,
  ProcessDefinition,
  ProcessEvent,
  ProcessGroupDefinition,
  ProcessRuntime,
  ProjectConfigSnapshot,
  ConfigProcessGroupDefinition,
  StackButtonDefinition,
} from "../../../shared/types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function parseEnvText(text: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const env: Record<string, string> = {};
  for (const line of trimmed.split("\n")) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    const eqIdx = value.indexOf("=");
    if (eqIdx < 1) continue;
    env[value.slice(0, eqIdx)] = value.slice(eqIdx + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function envToText(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

function parseGracefulShutdownMs(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseDependsOnCsv(value: string): string[] | undefined {
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function buildReadinessConfig(args: {
  readinessType: "none" | "port" | "logRegex";
  readinessPort: string;
  readinessPattern: string;
}): ConfigProcessReadiness | undefined {
  if (args.readinessType === "port") {
    const port = Number.parseInt(args.readinessPort.trim(), 10);
    return Number.isInteger(port) && port > 0 ? { type: "port", port } : undefined;
  }
  if (args.readinessType === "logRegex") {
    const pattern = args.readinessPattern.trim();
    return pattern ? { type: "logRegex", pattern } : undefined;
  }
  return undefined;
}

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "." || trimmed === "./") return ".";
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return normalized || ".";
  return normalized.replace(/^\.\/+/, "") || ".";
}

function isAbsoluteConfigPath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

function trimTrailingSlash(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (/^[A-Za-z]:\/?$/.test(normalized)) return normalized.replace(/\/+$/, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

function projectRelativeFromAbsolute(projectRoot: string | null, value: string): string | null {
  if (!projectRoot || !isAbsoluteConfigPath(value)) return null;
  const root = trimTrailingSlash(projectRoot);
  const candidate = trimTrailingSlash(value);
  const windowsPath = /^[A-Za-z]:\//.test(root) || /^[A-Za-z]:\//.test(candidate);
  const rootKey = windowsPath ? root.toLowerCase() : root;
  const candidateKey = windowsPath ? candidate.toLowerCase() : candidate;
  if (candidateKey === rootKey) return ".";
  if (!candidateKey.startsWith(`${rootKey}/`)) return null;
  return candidate.slice(root.length + 1) || ".";
}

function relativePathFromProjectDir(fromDir: string, toPath: string): string {
  const fromParts = normalizeRelativePath(fromDir).split("/").filter((part) => part && part !== ".");
  const toParts = normalizeRelativePath(toPath).split("/").filter((part) => part && part !== ".");
  let idx = 0;
  while (idx < fromParts.length && idx < toParts.length && fromParts[idx] === toParts[idx]) idx += 1;
  const up = fromParts.slice(idx).map(() => "..");
  const down = toParts.slice(idx);
  const relative = [...up, ...down].join("/");
  return relative || ".";
}

function normalizeCwdForConfig(cwd: string, projectRoot: string | null): string | undefined {
  const normalized = normalizeRelativePath(cwd);
  if (normalized === ".") return undefined;
  return projectRelativeFromAbsolute(projectRoot, normalized) ?? normalized;
}

function normalizeCommandForConfig(commandLine: string, cwd: string | undefined, projectRoot: string | null): {
  command: string[];
  localOnly: boolean;
} {
  const command = parseCommandLine(commandLine);
  const normalizedCwd = cwd ?? ".";
  const hasOutsideProjectAbsolutePath = command.some((part) =>
    isAbsoluteConfigPath(part) && projectRelativeFromAbsolute(projectRoot, part) == null
  );
  if (!command[0]) return { command, localOnly: hasOutsideProjectAbsolutePath };

  const executableProjectPath = projectRelativeFromAbsolute(projectRoot, command[0]);
  if (executableProjectPath == null) {
    return { command, localOnly: hasOutsideProjectAbsolutePath };
  }

  const executableFromCwd = relativePathFromProjectDir(normalizedCwd, executableProjectPath);
  const executable = executableFromCwd.includes("/") || executableFromCwd.startsWith(".")
    ? executableFromCwd
    : `./${executableFromCwd}`;
  return {
    command: [executable, ...command.slice(1)],
    localOnly: hasOutsideProjectAbsolutePath
  };
}

function buildProcessConfigDefinition(
  processId: string,
  cmd: {
    name: string;
    command: string;
    cwd: string;
    env: string;
    autostart: boolean;
    restart: AddCommandInitialValues["restart"];
    gracefulShutdownMs: string;
    dependsOn: string;
    readinessType: AddCommandInitialValues["readinessType"];
    readinessPort: string;
    readinessPattern: string;
    groupIds: string[];
  },
  allGroupIds: string[],
  projectRoot: string | null,
): { process: ConfigProcessDefinition; localOnly: boolean } {
  const cwd = normalizeCwdForConfig(cmd.cwd, projectRoot);
  const command = normalizeCommandForConfig(cmd.command, cwd, projectRoot);
  const cwdLocalOnly = isAbsoluteConfigPath(cmd.cwd) && projectRelativeFromAbsolute(projectRoot, cmd.cwd) == null;
  return {
    process: {
      id: processId,
      name: cmd.name,
      command: command.command,
      cwd,
      env: parseEnvText(cmd.env),
      autostart: cmd.autostart ? true : undefined,
      restart: cmd.restart === "never" ? undefined : cmd.restart,
      gracefulShutdownMs: parseGracefulShutdownMs(cmd.gracefulShutdownMs),
      dependsOn: parseDependsOnCsv(cmd.dependsOn),
      readiness: buildReadinessConfig(cmd),
      groupIds: allGroupIds.length > 0 ? allGroupIds : undefined,
    },
    localOnly: command.localOnly || cwdLocalOnly
  };
}

function upsertProcess(processes: ConfigProcessDefinition[] | undefined, processEntry: ConfigProcessDefinition): ConfigProcessDefinition[] {
  const existing = processes ?? [];
  return existing.some((entry) => entry.id === processEntry.id)
    ? existing.map((entry) => (entry.id === processEntry.id ? processEntry : entry))
    : [...existing, processEntry];
}

function removeProcess(processes: ConfigProcessDefinition[] | undefined, processId: string): ConfigProcessDefinition[] {
  return (processes ?? []).filter((entry) => entry.id !== processId);
}

function upsertStackButton(
  stackButtons: ConfigStackButtonDefinition[] | undefined,
  stack: ConfigStackButtonDefinition,
): ConfigStackButtonDefinition[] {
  const existing = stackButtons ?? [];
  return existing.some((entry) => entry.id === stack.id)
    ? existing.map((entry) => (entry.id === stack.id ? stack : entry))
    : [...existing, stack];
}

function uniqueProcessIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

const RUN_PAGE_LANE_STORAGE_KEY = "ade.runPageLaneSelections.v1";

type PersistedRunPageLaneState = {
  lastLaneId: string | null;
  commandLaneIds: Record<string, string>;
};

function readRunPageLaneState(projectRoot: string | null): PersistedRunPageLaneState {
  if (!projectRoot) return { lastLaneId: null, commandLaneIds: {} };
  try {
    const raw = window.localStorage.getItem(RUN_PAGE_LANE_STORAGE_KEY);
    if (!raw) return { lastLaneId: null, commandLaneIds: {} };
    const parsed = JSON.parse(raw) as Record<string, PersistedRunPageLaneState>;
    const state = parsed[projectRoot];
    if (!state || typeof state !== "object") return { lastLaneId: null, commandLaneIds: {} };
    return {
      lastLaneId: typeof state.lastLaneId === "string" ? state.lastLaneId : null,
      commandLaneIds: Object.fromEntries(
        Object.entries(state.commandLaneIds ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    };
  } catch {
    return { lastLaneId: null, commandLaneIds: {} };
  }
}

function writeRunPageLaneState(projectRoot: string | null, state: PersistedRunPageLaneState) {
  if (!projectRoot) return;
  try {
    const raw = window.localStorage.getItem(RUN_PAGE_LANE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, PersistedRunPageLaneState> : {};
    parsed[projectRoot] = state;
    window.localStorage.setItem(RUN_PAGE_LANE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore persistence failures
  }
}

function runPageLaneStateEqual(left: PersistedRunPageLaneState, right: PersistedRunPageLaneState): boolean {
  if (left.lastLaneId !== right.lastLaneId) return false;
  const leftEntries = Object.entries(left.commandLaneIds);
  const rightEntries = Object.entries(right.commandLaneIds);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([processId, laneId]) => right.commandLaneIds[processId] === laneId);
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
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16,
            animation: "pulse-glow 3s infinite",
          }}
        >
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
          marginTop: -16,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.transform = "translateY(-2px)";
          event.currentTarget.style.boxShadow = `0 6px 24px ${COLORS.accent}60`;
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.transform = "none";
          event.currentTarget.style.boxShadow = `0 4px 20px ${COLORS.accent}40`;
        }}
      >
        <FolderOpen size={20} weight="regular" />
        OPEN PROJECT
      </button>

      {realProjects.length > 0 ? (
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
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: `${COLORS.accent}15`,
                    color: COLORS.accent,
                    flexShrink: 0,
                  }}
                >
                  <Folder size={16} weight="regular" />
                </div>
                <div style={{ overflow: "hidden", flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{rp.displayName}</div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {rp.rootPath}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  {rp.laneCount !== undefined ? (
                    <span
                      style={{
                        fontSize: 10,
                        background: `${COLORS.accent}20`,
                        color: COLORS.accent,
                        padding: "2px 6px",
                        borderRadius: 10,
                        fontWeight: 600,
                      }}
                    >
                      {rp.laneCount} lane{rp.laneCount !== 1 ? "s" : ""}
                    </span>
                  ) : null}
                  {rp.lastOpenedAt ? (
                    <span style={{ fontSize: 9, color: COLORS.textDim }}>{toRelativeTime(rp.lastOpenedAt)}</span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <CommandPalette open={projectBrowserOpen} onOpenChange={setProjectBrowserOpen} intent="project-browse" />
    </div>
  );
}

export function RunPage() {
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const runLaneId = useAppStore((s) => s.runLaneId);
  const selectRunLane = useAppStore((s) => s.selectRunLane);
  const showWelcome = useAppStore((s) => s.showWelcome);

  const projectRoot = project?.rootPath ?? null;
  const [persistedLaneState, setPersistedLaneState] = useState<PersistedRunPageLaneState>(() => readRunPageLaneState(projectRoot));
  const [config, setConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [definitions, setDefinitions] = useState<ProcessDefinition[]>([]);
  const [runtime, setRuntime] = useState<ProcessRuntime[]>([]);
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingProcess, setEditingProcess] = useState<{ id: string; values: AddCommandInitialValues } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runShellSessions, setRunShellSessions] = useState<RunShellSession[]>([]);
  const [shellBusy, setShellBusy] = useState(false);
  const [networkDrawerOpen, setNetworkDrawerOpen] = useState(false);
  const [monitorFocusTarget, setMonitorFocusTarget] = useState<{ kind: "process" | "shell"; id: string } | null>(null);
  const [monitorFocusSequence, setMonitorFocusSequence] = useState(0);
  const runtimeRefreshTimerRef = useRef<number | null>(null);
  const runShellSessionsRef = useRef<RunShellSession[]>([]);

  const persistedDefaultLaneId = persistedLaneState.lastLaneId;
  const defaultLaneId = runLaneId ?? persistedDefaultLaneId ?? selectedLaneId ?? lanes[0]?.id ?? null;
  const processDefinitions = useMemo(() => Object.fromEntries(definitions.map((definition) => [definition.id, definition])), [definitions]);
  const processNames = useMemo(() => Object.fromEntries(definitions.map((definition) => [definition.id, definition.name])), [definitions]);
  const stacks = useMemo<StackButtonDefinition[]>(() => config?.effective.stackButtons ?? [], [config?.effective.stackButtons]);
  const groups = useMemo<ProcessGroupDefinition[]>(() => config?.effective.processGroups ?? [], [config?.effective.processGroups]);

  const selectedStack = useMemo(
    () => stacks.find((stack) => stack.id === selectedStackId) ?? null,
    [selectedStackId, stacks],
  );

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );

  const commandLaneMap = useMemo(() => {
    const allowed = new Set(lanes.map((lane) => lane.id));
    const fallbackLaneId = defaultLaneId ?? lanes[0]?.id ?? null;
    const map: Record<string, string> = {};
    for (const definition of definitions) {
      const persistedLaneId = persistedLaneState.commandLaneIds[definition.id];
      const laneId = persistedLaneId && allowed.has(persistedLaneId)
        ? persistedLaneId
        : fallbackLaneId;
      if (laneId) map[definition.id] = laneId;
    }
    return map;
  }, [defaultLaneId, definitions, lanes, persistedLaneState.commandLaneIds]);

  const refreshLanePersistence = useCallback((updater: (current: PersistedRunPageLaneState) => PersistedRunPageLaneState) => {
    setPersistedLaneState((current) => {
      const next = updater(current);
      if (runPageLaneStateEqual(current, next)) return current;
      writeRunPageLaneState(projectRoot, next);
      return next;
    });
  }, [projectRoot]);

  useEffect(() => {
    setPersistedLaneState(readRunPageLaneState(projectRoot));
  }, [projectRoot]);

  useEffect(() => {
    if (!projectRoot) return;
    const allowed = new Set(lanes.map((lane) => lane.id));
    refreshLanePersistence((current) => {
      const nextCommandLaneIds: Record<string, string> = {};
      for (const definition of definitions) {
        const laneId = commandLaneMap[definition.id];
        if (laneId && allowed.has(laneId)) nextCommandLaneIds[definition.id] = laneId;
      }
      const nextLastLaneId = current.lastLaneId && allowed.has(current.lastLaneId)
        ? current.lastLaneId
        : defaultLaneId;
      return {
        lastLaneId: nextLastLaneId ?? null,
        commandLaneIds: nextCommandLaneIds,
      };
    });
  }, [commandLaneMap, defaultLaneId, definitions, lanes, projectRoot, refreshLanePersistence]);

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

  const refreshDefinitions = useCallback(async () => {
    if (showWelcome) {
      setConfig(null);
      setDefinitions([]);
      return;
    }

    setLoading(true);
    try {
      const [nextConfig, nextDefinitions] = await Promise.all([
        window.ade.projectConfig.get(),
        window.ade.processes.listDefinitions(),
      ]);
      setConfig(nextConfig);
      setDefinitions(nextDefinitions);
    } catch (error) {
      console.error("RunPage.refreshDefinitions", error);
    } finally {
      setLoading(false);
    }
  }, [showWelcome]);

  const refreshRuntime = useCallback(async () => {
    if (showWelcome) {
      setRuntime([]);
      return;
    }
    const laneIds = Array.from(
      new Set([
        ...Object.values(commandLaneMap),
        ...runShellSessions.map((session) => session.laneId),
      ].filter((value): value is string => Boolean(value))),
    );
    if (laneIds.length === 0) {
      setRuntime([]);
      return;
    }
    try {
      const snapshots = await Promise.all(
        laneIds.map((laneId) => window.ade.processes.listRuntime(laneId).catch(() => [] as ProcessRuntime[])),
      );
      const next = snapshots.flat();
      setRuntime(next);
    } catch (error) {
      console.error("RunPage.refreshRuntime", error);
    }
  }, [commandLaneMap, runShellSessions, showWelcome]);

  useEffect(() => {
    if (showWelcome) return;
    void refreshDefinitions();
  }, [refreshDefinitions, showWelcome]);

  useEffect(() => {
    if (groups.length === 0) {
      if (selectedGroupId !== null) setSelectedGroupId(null);
      return;
    }
    if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(null);
    }
  }, [groups, selectedGroupId]);

  useEffect(() => {
    if (stacks.length === 0) {
      if (selectedStackId !== null) setSelectedStackId(null);
      return;
    }
    if (selectedStackId && !stacks.some((stack) => stack.id === selectedStackId)) {
      setSelectedStackId(null);
    }
  }, [selectedStackId, stacks]);

  useEffect(() => {
    setActionError(null);
  }, [defaultLaneId]);

  useEffect(() => {
    if (runtimeRefreshTimerRef.current != null) {
      window.clearTimeout(runtimeRefreshTimerRef.current);
      runtimeRefreshTimerRef.current = null;
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
  }, [refreshRuntime]);

  useEffect(() => {
    const unsubscribe = window.ade.processes.onEvent((event: ProcessEvent) => {
      if (event.type !== "runtime") return;
      setRuntime((current) => {
        const next = [...current];
        const index = next.findIndex((runtimeItem) => runtimeItem.runId === event.runtime.runId);
        if (index >= 0) {
          next[index] = event.runtime;
        } else {
          next.unshift(event.runtime);
        }
        return next;
      });
    });
    return unsubscribe;
  }, []);

  const resolveProcessLaneId = useCallback((processId: string): string | null => {
    return commandLaneMap[processId] ?? defaultLaneId ?? null;
  }, [commandLaneMap, defaultLaneId]);

  const selectProcessLane = useCallback((processId: string, laneId: string) => {
    selectRunLane(laneId);
    refreshLanePersistence((current) => ({
      lastLaneId: laneId,
      commandLaneIds: {
        ...current.commandLaneIds,
        [processId]: laneId,
      },
    }));
  }, [refreshLanePersistence, selectRunLane]);

  const selectDefaultLane = useCallback((laneId: string | null) => {
    selectRunLane(laneId);
    refreshLanePersistence((current) => ({
      ...current,
      lastLaneId: laneId,
    }));
  }, [refreshLanePersistence, selectRunLane]);

  const startProcess = useCallback(async (processId: string, laneId: string, allowTrustRetry = true): Promise<ProcessRuntime> => {
    try {
      return await window.ade.processes.start({ laneId, processId });
    } catch (error) {
      if (
        allowTrustRetry
        && error instanceof Error
        && error.message.includes("ADE_TRUST_REQUIRED")
      ) {
        await window.ade.projectConfig.confirmTrust();
        return await window.ade.processes.start({ laneId, processId });
      }
      throw error;
    }
  }, []);

  const handleRun = useCallback(async (processId: string) => {
    const laneId = resolveProcessLaneId(processId);
    if (!laneId) return;
    try {
      setActionError(null);
      const started = await startProcess(processId, laneId);
      focusMonitor({ kind: "process", id: started.runId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      console.error("[RunPage] handleRun failed:", error);
    }
  }, [focusMonitor, resolveProcessLaneId, startProcess]);

  const handleStop = useCallback(async (processId: string) => {
    const laneId = resolveProcessLaneId(processId);
    if (!laneId) return;
    try {
      setActionError(null);
      await window.ade.processes.stop({ laneId, processId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      console.error("[RunPage] handleStop failed:", error);
    }
  }, [resolveProcessLaneId]);

  const handleKillRuntime = useCallback(async (runtimeItem: ProcessRuntime) => {
    try {
      setActionError(null);
      await window.ade.processes.kill({
        laneId: runtimeItem.laneId,
        processId: runtimeItem.processId,
        runId: runtimeItem.runId,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      console.error("[RunPage] handleKillRuntime failed:", error);
    }
  }, []);

  const runDefinitions = useCallback(async (targetDefinitions: ProcessDefinition[]) => {
    const launchTargets = targetDefinitions
      .map((definition) => ({
        definition,
        laneId: resolveProcessLaneId(definition.id),
      }))
      .filter((entry): entry is { definition: ProcessDefinition; laneId: string } => Boolean(entry.laneId));
    if (launchTargets.length === 0) return;

    try {
      setActionError(null);
      const settled = await Promise.allSettled(
        launchTargets.map((entry) => startProcess(entry.definition.id, entry.laneId, false)),
      );
      const successes = settled
        .filter((result): result is PromiseFulfilledResult<ProcessRuntime> => result.status === "fulfilled")
        .map((result) => result.value);
      const failures = launchTargets.flatMap((entry, index) => {
        const result = settled[index];
        return result?.status === "rejected" ? [{ entry, reason: result.reason }] : [];
      });
      const trustFailures = failures.filter((failure) =>
        failure.reason instanceof Error && failure.reason.message.includes("ADE_TRUST_REQUIRED")
      );

      let retrySuccesses: ProcessRuntime[] = [];
      if (trustFailures.length > 0) {
        await window.ade.projectConfig.confirmTrust();
        const retrySettled = await Promise.allSettled(
          trustFailures.map((failure) => startProcess(failure.entry.definition.id, failure.entry.laneId, false)),
        );
        retrySuccesses = retrySettled
          .filter((result): result is PromiseFulfilledResult<ProcessRuntime> => result.status === "fulfilled")
          .map((result) => result.value);
        const retryFailure = retrySettled.find((result) => result.status === "rejected");
        if (retryFailure?.status === "rejected") {
          setActionError(retryFailure.reason instanceof Error ? retryFailure.reason.message : String(retryFailure.reason));
        }
      }

      const firstFailure = failures.find((failure) =>
        !(failure.reason instanceof Error && failure.reason.message.includes("ADE_TRUST_REQUIRED"))
      );
      if (firstFailure) {
        setActionError(firstFailure.reason instanceof Error ? firstFailure.reason.message : String(firstFailure.reason));
      }

      const first = successes[0] ?? retrySuccesses[0] ?? null;
      if (first) focusMonitor({ kind: "process", id: first.runId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      console.error("[RunPage] runDefinitions failed:", error);
    }
  }, [focusMonitor, resolveProcessLaneId, startProcess]);

  const stopDefinitions = useCallback(async (targetDefinitions: ProcessDefinition[]) => {
    try {
      setActionError(null);
      await Promise.all(
        targetDefinitions.map(async (definition) => {
          const laneId = resolveProcessLaneId(definition.id);
          if (!laneId) return;
          await window.ade.processes.stop({ laneId, processId: definition.id });
        }),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      console.error("[RunPage] stopDefinitions failed:", error);
    }
  }, [resolveProcessLaneId]);

  const startStackById = useCallback(async (stackId: string) => {
    if (!defaultLaneId) return;
    try {
      setActionError(null);
      await window.ade.processes.startStack({ laneId: defaultLaneId, stackId });
      const stack = stacks.find((entry) => entry.id === stackId);
      const firstProcessId = stack?.processIds[0] ?? null;
      if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
    } catch (error) {
      if (error instanceof Error && error.message.includes("ADE_TRUST_REQUIRED")) {
        try {
          await window.ade.projectConfig.confirmTrust();
          await window.ade.processes.startStack({ laneId: defaultLaneId, stackId });
          return;
        } catch (retryError) {
          setActionError(retryError instanceof Error ? retryError.message : String(retryError));
          return;
        }
      }
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [defaultLaneId, focusMonitor, stacks]);

  const stopStackById = useCallback(async (stackId: string) => {
    if (!defaultLaneId) return;
    try {
      setActionError(null);
      await window.ade.processes.stopStack({ laneId: defaultLaneId, stackId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [defaultLaneId]);

  const restartStackById = useCallback(async (stackId: string) => {
    if (!defaultLaneId) return;
    try {
      setActionError(null);
      await window.ade.processes.restartStack({ laneId: defaultLaneId, stackId });
      const stack = stacks.find((entry) => entry.id === stackId);
      const firstProcessId = stack?.processIds[0] ?? null;
      if (firstProcessId) focusMonitor({ kind: "process", id: firstProcessId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [defaultLaneId, focusMonitor, stacks]);

  const handleLaunchShell = useCallback(async () => {
    const laneId = defaultLaneId;
    if (!laneId || shellBusy) return;
    setShellBusy(true);
    setActionError(null);
    try {
      const existingCount = runShellSessionsRef.current.length;
      const title = existingCount > 0 ? `Shell ${existingCount + 1}` : "Shell";
      const result = await window.ade.pty.create({
        laneId,
        cols: 100,
        rows: 30,
        title,
        tracked: false,
        toolType: "shell",
      });
      const session: RunShellSession = { sessionId: result.sessionId, ptyId: result.ptyId, title, laneId };
      setRunShellSessions((current) => [...current, session]);
      focusMonitor({ kind: "shell", id: session.sessionId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setShellBusy(false);
    }
  }, [defaultLaneId, focusMonitor, shellBusy]);

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

  const saveProcessToConfig = useCallback(async (cmd: {
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
    groupIds: string[];
    newGroupNames: string[];
  }) => {
    if (!config) return;
    const processId = generateId();
    const createdGroups: ConfigProcessGroupDefinition[] = cmd.newGroupNames.map((name) => ({
      id: generateId(),
      name,
    }));
    const allGroupIds = [...cmd.groupIds, ...createdGroups.map((group) => group.id)];
    const { process: newProcess, localOnly } = buildProcessConfigDefinition(processId, cmd, allGroupIds, projectRoot);

    const shared = { ...config.shared };
    const local = { ...config.local };
    if (localOnly) {
      local.processes = upsertProcess(local.processes, newProcess);
      local.processGroups = [...(local.processGroups ?? []), ...createdGroups];
    } else {
      shared.processes = upsertProcess(shared.processes, newProcess);
      shared.processGroups = [...(shared.processGroups ?? []), ...createdGroups];
    }

    let targetStackId = cmd.stackId;
    if (cmd.newStackName) {
      const newStack: ConfigStackButtonDefinition = {
        id: generateId(),
        name: cmd.newStackName,
        processIds: [processId],
      };
      targetStackId = newStack.id;
      if (localOnly) {
        local.stackButtons = upsertStackButton(local.stackButtons, newStack);
      } else {
        shared.stackButtons = upsertStackButton(shared.stackButtons, newStack);
      }
    } else if (targetStackId) {
      if (localOnly) {
        const effectiveStack = config.effective.stackButtons.find((stack) => stack.id === targetStackId);
        if (effectiveStack) {
          local.stackButtons = upsertStackButton(local.stackButtons, {
            ...effectiveStack,
            processIds: uniqueProcessIds([...(effectiveStack.processIds ?? []), processId]),
          });
        }
      } else {
        shared.stackButtons = (shared.stackButtons ?? []).map((stack) =>
          stack.id === targetStackId
            ? { ...stack, processIds: uniqueProcessIds([...(stack.processIds ?? []), processId]) }
            : stack,
        );
      }
    }

    await window.ade.projectConfig.save({ shared, local });
    await Promise.all([refreshDefinitions(), refreshRuntime()]);
  }, [config, projectRoot, refreshDefinitions, refreshRuntime]);

  const updateProcessInConfig = useCallback(async (
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
      groupIds: string[];
      newGroupNames: string[];
    },
  ) => {
    if (!config) return;
    const shared = { ...config.shared };
    const local = { ...config.local };
    const createdGroups: ConfigProcessGroupDefinition[] = cmd.newGroupNames.map((name) => ({
      id: generateId(),
      name,
    }));
    const allGroupIds = [...cmd.groupIds, ...createdGroups.map((group) => group.id)];
    const { process: nextProcess, localOnly } = buildProcessConfigDefinition(processId, cmd, allGroupIds, projectRoot);
    const existingLocal = (config.local.processes ?? []).some((entry) => entry.id === processId);
    const targetLocal = existingLocal || localOnly;

    if (targetLocal) {
      local.processes = upsertProcess(local.processes, nextProcess);
      local.processGroups = [...(local.processGroups ?? []), ...createdGroups];
      if (localOnly) {
        shared.processes = removeProcess(shared.processes, processId);
        shared.stackButtons = (shared.stackButtons ?? []).map((stack) => ({
          ...stack,
          processIds: (stack.processIds ?? []).filter((id) => id !== processId),
        }));
      }
    } else {
      shared.processes = upsertProcess(shared.processes, nextProcess);
      shared.processGroups = [...(shared.processGroups ?? []), ...createdGroups];
      local.processes = removeProcess(local.processes, processId);
    }

    if (cmd.newStackName) {
      const newStack = { id: generateId(), name: cmd.newStackName, processIds: [processId] };
      if (targetLocal) {
        for (const stack of config.effective.stackButtons.filter((entry) => entry.processIds.includes(processId))) {
          local.stackButtons = upsertStackButton(local.stackButtons, {
            ...stack,
            processIds: stack.processIds.filter((id) => id !== processId),
          });
        }
        local.stackButtons = upsertStackButton(local.stackButtons, newStack);
      } else {
        shared.stackButtons = [
          ...(shared.stackButtons ?? []).map((stack) => ({
            ...stack,
            processIds: (stack.processIds ?? []).filter((id) => id !== processId),
          })),
          newStack,
        ];
      }
    } else if (cmd.stackId) {
      if (targetLocal) {
        for (const stack of config.effective.stackButtons.filter((entry) => entry.processIds.includes(processId) || entry.id === cmd.stackId)) {
          local.stackButtons = upsertStackButton(local.stackButtons, {
            ...stack,
            processIds: uniqueProcessIds(
              stack.id === cmd.stackId
                ? [...stack.processIds.filter((id) => id !== processId), processId]
                : stack.processIds.filter((id) => id !== processId),
            ),
          });
        }
      } else {
        shared.stackButtons = (shared.stackButtons ?? []).map((stack) => {
          const withoutProcess = (stack.processIds ?? []).filter((id) => id !== processId);
          return stack.id === cmd.stackId
            ? { ...stack, processIds: uniqueProcessIds([...withoutProcess, processId]) }
            : { ...stack, processIds: withoutProcess };
        });
      }
    } else if (targetLocal) {
      for (const stack of config.effective.stackButtons.filter((entry) => entry.processIds.includes(processId))) {
        local.stackButtons = upsertStackButton(local.stackButtons, {
          ...stack,
          processIds: stack.processIds.filter((id) => id !== processId),
        });
      }
    } else {
      shared.stackButtons = (shared.stackButtons ?? []).map((stack) => ({
        ...stack,
        processIds: (stack.processIds ?? []).filter((id) => id !== processId),
      }));
    }

    await window.ade.projectConfig.save({ shared, local });
    await Promise.all([refreshDefinitions(), refreshRuntime()]);
  }, [config, projectRoot, refreshDefinitions, refreshRuntime]);

  const handleDeleteProcess = useCallback(async (processId: string) => {
    if (!config) return;
    const shared = { ...config.shared };
    const local = { ...config.local };
    shared.processes = (shared.processes ?? []).filter((processEntry) => processEntry.id !== processId);
    local.processes = (local.processes ?? []).filter((processEntry) => processEntry.id !== processId);
    shared.stackButtons = (shared.stackButtons ?? []).map((stack) => ({
      ...stack,
      processIds: (stack.processIds ?? []).filter((id) => id !== processId),
    }));
    local.stackButtons = (local.stackButtons ?? []).map((stack) => ({
      ...stack,
      processIds: (stack.processIds ?? []).filter((id) => id !== processId),
    }));
    await window.ade.projectConfig.save({ shared, local });
    await Promise.all([refreshDefinitions(), refreshRuntime()]);
  }, [config, refreshDefinitions, refreshRuntime]);

  const handleCreateStack = useCallback(async (name: string) => {
    if (!config) return;
    const shared = { ...config.shared };
    const newStack: ConfigStackButtonDefinition = { id: generateId(), name, processIds: [] };
    shared.stackButtons = [...(shared.stackButtons ?? []), newStack];
    await window.ade.projectConfig.save({ shared, local: config.local });
    await refreshDefinitions();
  }, [config, refreshDefinitions]);

  const handleRenameStack = useCallback(async (stackId: string, name: string) => {
    if (!config) return;
    const shared = { ...config.shared };
    shared.stackButtons = (shared.stackButtons ?? []).map((stack) => (stack.id === stackId ? { ...stack, name } : stack));
    await window.ade.projectConfig.save({ shared, local: config.local });
    await refreshDefinitions();
  }, [config, refreshDefinitions]);

  const handleDeleteStack = useCallback(async (stackId: string) => {
    if (!config) return;
    const shared = { ...config.shared };
    shared.stackButtons = (shared.stackButtons ?? []).filter((stack) => stack.id !== stackId);
    await window.ade.projectConfig.save({ shared, local: config.local });
    if (selectedStackId === stackId) setSelectedStackId(null);
    await refreshDefinitions();
  }, [config, refreshDefinitions, selectedStackId]);

  const handleUpdateStackStartOrder = useCallback(async (stackId: string, startOrder: "parallel" | "dependency") => {
    if (!config) return;
    const shared = { ...config.shared };
    shared.stackButtons = (shared.stackButtons ?? []).map((stack) =>
      stack.id === stackId ? { ...stack, startOrder } : stack,
    );
    await window.ade.projectConfig.save({ shared, local: config.local });
    await refreshDefinitions();
  }, [config, refreshDefinitions]);

  const handleEditProcess = useCallback((processId: string) => {
    const definition = definitions.find((entry) => entry.id === processId);
    if (!definition) return;
    const currentStack = stacks.find((stack) => stack.processIds.includes(processId));
    setEditingProcess({
      id: processId,
      values: {
        name: definition.name,
        command: commandArrayToLine(definition.command),
        stackId: currentStack?.id ?? null,
        cwd: definition.cwd || ".",
        env: envToText(definition.env),
        autostart: definition.autostart,
        restart: definition.restart,
        gracefulShutdownMs: String(definition.gracefulShutdownMs ?? 7000),
        dependsOn: (definition.dependsOn ?? []).join(", "),
        readinessType: definition.readiness.type,
        readinessPort: definition.readiness.type === "port" ? String(definition.readiness.port ?? "") : "",
        readinessPattern: definition.readiness.type === "logRegex" ? definition.readiness.pattern ?? "" : "",
        groupIds: definition.groupIds ?? [],
      },
    });
  }, [definitions, stacks]);

  const filteredDefinitions = useMemo(() => {
    let next = definitions;
    if (selectedStackId) {
      const ids = new Set(stacks.find((stack) => stack.id === selectedStackId)?.processIds ?? []);
      next = next.filter((definition) => ids.has(definition.id));
    }
    if (selectedGroupId) {
      next = next.filter((definition) => (definition.groupIds ?? []).includes(selectedGroupId));
    }
    return next;
  }, [definitions, selectedGroupId, selectedStackId, stacks]);

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const definition of definitions) {
      for (const groupId of definition.groupIds ?? []) {
        counts[groupId] = (counts[groupId] ?? 0) + 1;
      }
    }
    return counts;
  }, [definitions]);

  if (showWelcome) {
    return <WelcomeScreen />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: COLORS.pageBg }}>
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

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={LABEL_STYLE}>Default lane</span>
          <select
            value={defaultLaneId ?? ""}
            onChange={(event) => selectDefaultLane(event.target.value || null)}
            style={{
              height: 28,
              minWidth: 140,
              padding: "0 8px",
              appearance: "none",
              fontFamily: MONO_FONT,
              fontSize: 11,
              color: COLORS.textPrimary,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.outlineBorder}`,
              outline: "none",
              cursor: "pointer",
            }}
          >
            <option value="">No lane</option>
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </div>

        {filteredDefinitions.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 700, color: COLORS.textPrimary }}>
              {selectedStack?.name ?? selectedGroup?.name ?? "All commands"}
            </span>
            <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
              ({filteredDefinitions.length})
            </span>
          </div>
        ) : null}

        <div style={{ flex: 1 }} />

        {filteredDefinitions.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => {
                if (selectedStackId) {
                  void startStackById(selectedStackId);
                  return;
                }
                void runDefinitions(filteredDefinitions);
              }}
              style={primaryButton({ height: 28, fontSize: 10 })}
            >
              <Play size={12} weight="fill" />
              {selectedStack ? "Run stack" : "Run view"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedStackId) {
                  void stopStackById(selectedStackId);
                  return;
                }
                void stopDefinitions(filteredDefinitions);
              }}
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
                cursor: "pointer",
              }}
            >
              <Stop size={12} weight="fill" />
              {selectedStack ? "Stop stack" : "Stop view"}
            </button>
          </>
        ) : null}

        <button
          type="button"
          onClick={() => void handleLaunchShell()}
          disabled={!defaultLaneId || shellBusy}
          style={{
            ...outlineButton(),
            opacity: defaultLaneId && !shellBusy ? 1 : 0.45,
            cursor: defaultLaneId && !shellBusy ? "pointer" : "default",
          }}
        >
          <Terminal size={14} weight="bold" />
          {shellBusy ? "Opening shell..." : "New shell"}
        </button>

        <button type="button" onClick={() => setAddDialogOpen(true)} style={outlineButton()}>
          <Plus size={14} weight="bold" />
          Add command
        </button>
      </div>

      <LaneRuntimeBar laneId={defaultLaneId} onOpenPreviewRouting={() => setNetworkDrawerOpen(true)} />

      <RunStackTabs
        stacks={stacks}
        selectedStackId={selectedStackId}
        onSelectStack={setSelectedStackId}
        onCreateStack={handleCreateStack}
        onRenameStack={handleRenameStack}
        onDeleteStack={handleDeleteStack}
        onStartStack={(stackId) => {
          void startStackById(stackId);
        }}
        onStopStack={(stackId) => {
          void stopStackById(stackId);
        }}
        onRestartStack={(stackId) => {
          void restartStackById(stackId);
        }}
        onUpdateStackStartOrder={handleUpdateStackStartOrder}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 20px",
          borderBottom: `1px solid ${COLORS.border}`,
          overflowX: "auto",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setSelectedGroupId(null)}
          style={{
            height: 28,
            padding: "0 10px",
            background: selectedGroupId === null ? COLORS.accentSubtle : COLORS.recessedBg,
            border: `1px solid ${selectedGroupId === null ? COLORS.accentBorder : COLORS.outlineBorder}`,
            color: selectedGroupId === null ? COLORS.textPrimary : COLORS.textSecondary,
            cursor: "pointer",
            fontFamily: MONO_FONT,
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
          }}
        >
          All groups
        </button>
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={() => setSelectedGroupId((current) => (current === group.id ? null : group.id))}
            style={{
              height: 28,
              padding: "0 10px",
              background: selectedGroupId === group.id ? COLORS.accentSubtle : COLORS.recessedBg,
              border: `1px solid ${selectedGroupId === group.id ? COLORS.accentBorder : COLORS.outlineBorder}`,
              color: selectedGroupId === group.id ? COLORS.textPrimary : COLORS.textSecondary,
              cursor: "pointer",
              fontFamily: MONO_FONT,
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              whiteSpace: "nowrap",
            }}
          >
            {group.name}
            <span style={{ marginLeft: 6, color: COLORS.textDim }}>{groupCounts[group.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
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

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {loading && filteredDefinitions.length === 0 ? (
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim, textAlign: "center", padding: "40px 0" }}>
              Loading...
            </div>
          ) : filteredDefinitions.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: "60px 20px" }}>
              <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textMuted, textAlign: "center" }}>
                No commands in this view
              </div>
              <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim, textAlign: "center", maxWidth: 340 }}>
                Add a command, group it, or switch stacks. Every Run click opens a fresh terminal session.
              </div>
              <button type="button" onClick={() => setAddDialogOpen(true)} style={primaryButton()}>
                <Plus size={14} weight="bold" />
                Add command
              </button>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
              {filteredDefinitions.map((definition) => {
                const laneId = resolveProcessLaneId(definition.id);
                const laneRuntimes = runtime.filter(
                  (runtimeItem) => runtimeItem.processId === definition.id && runtimeItem.laneId === laneId,
                );
                return (
                  <CommandCard
                    key={definition.id}
                    definition={definition}
                    lanes={lanes}
                    groups={groups}
                    selectedLaneId={laneId}
                    runtimes={laneRuntimes}
                    onSelectLane={selectProcessLane}
                    onRun={handleRun}
                    onStop={handleStop}
                    onEdit={handleEditProcess}
                    onDelete={handleDeleteProcess}
                  />
                );
              })}
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
            <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, zIndex: 91 }}>
              <RunNetworkPanel onClose={() => setNetworkDrawerOpen(false)} />
            </div>
          </>
        ) : null}
      </div>

      <ProcessMonitor
        runtimes={runtime}
        processDefinitions={processDefinitions}
        processNames={processNames}
        lanes={lanes}
        shellSessions={runShellSessions}
        focusTarget={monitorFocusTarget}
        focusSequence={monitorFocusSequence}
        onKill={handleKillRuntime}
        onCloseShell={(sessionId) => {
          void handleCloseRunShell(sessionId);
        }}
      />

      <AddCommandDialog
        stacks={stacks}
        groups={groups}
        lanes={lanes}
        defaultLaneId={defaultLaneId}
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSubmit={saveProcessToConfig}
      />

      <AddCommandDialog
        stacks={stacks}
        groups={groups}
        lanes={lanes}
        defaultLaneId={defaultLaneId}
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
      />
    </div>
  );
}
