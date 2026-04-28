import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretUp, Folder, FolderOpen, Play, Plus, Stop, Terminal, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { CommandCard } from "./CommandCard";
import { CommandPalette } from "../app/CommandPalette";
import { LaneRuntimeBar } from "./LaneRuntimeBar";
import { AddCommandDialog, type AddCommandInitialValues, type AddCommandSubmitPayload } from "./AddCommandDialog";
import { RunNetworkPanel } from "./RunNetworkPanel";
import { commandArrayToLine, parseCommandLine } from "../../lib/shell";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { toRelativeTime } from "../graph/graphHelpers";
import type {
  ConfigProcessDefinition,
  ProcessDefinition,
  ProcessEvent,
  ProcessGroupDefinition,
  ProcessRestartPolicy,
  ProcessRuntime,
  ProjectConfigSnapshot,
  ConfigProcessGroupDefinition,
} from "../../../shared/types";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

type RunShellSession = {
  sessionId: string;
  ptyId: string;
  title: string;
  laneId: string;
};

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
  cmd: AddCommandSubmitPayload & { restart?: ProcessRestartPolicy },
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
      restart: cmd.restart == null || cmd.restart === "never" ? undefined : cmd.restart,
      gracefulShutdownMs: parseGracefulShutdownMs(cmd.gracefulShutdownMs),
      dependsOn: parseDependsOnCsv(cmd.dependsOn),
      readiness: { type: "none" },
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

const RUN_PAGE_LANE_STORAGE_KEY = "ade.runPageLaneSelections.v1";
const LANE_RUNTIME_BAR_OPEN_KEY = "ade.run.laneRuntimeBarOpen";

function readLaneRuntimeBarOpenFromStorage(): boolean {
  try {
    return window.localStorage.getItem(LANE_RUNTIME_BAR_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function writeLaneRuntimeBarOpenToStorage(open: boolean) {
  try {
    window.localStorage.setItem(LANE_RUNTIME_BAR_OPEN_KEY, open ? "true" : "false");
  } catch {
    // ignore persistence failures
  }
}

type PersistedRunPageLaneState = {
  commandLaneIds: Record<string, string>;
};

function readRunPageLaneState(projectRoot: string | null): PersistedRunPageLaneState {
  if (!projectRoot) return { commandLaneIds: {} };
  try {
    const raw = window.localStorage.getItem(RUN_PAGE_LANE_STORAGE_KEY);
    if (!raw) return { commandLaneIds: {} };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = parsed[projectRoot];
    if (!state || typeof state !== "object") return { commandLaneIds: {} };
    const record = state as Record<string, unknown>;
    return {
      commandLaneIds: Object.fromEntries(
        Object.entries((record.commandLaneIds as Record<string, unknown>) ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
  } catch {
    return { commandLaneIds: {} };
  }
}

function writeRunPageLaneState(projectRoot: string | null, state: PersistedRunPageLaneState) {
  if (!projectRoot) return;
  try {
    const raw = window.localStorage.getItem(RUN_PAGE_LANE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    parsed[projectRoot] = { commandLaneIds: state.commandLaneIds };
    window.localStorage.setItem(RUN_PAGE_LANE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore persistence failures
  }
}

function runPageLaneStateEqual(left: PersistedRunPageLaneState, right: PersistedRunPageLaneState): boolean {
  const leftEntries = Object.entries(left.commandLaneIds);
  const rightEntries = Object.entries(right.commandLaneIds);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([processId, laneId]) => right.commandLaneIds[processId] === laneId);
}

function WelcomeScreen() {
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const project = useAppStore((s) => s.project);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
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
        background: `radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--color-accent) 15%, transparent) 0%, ${COLORS.pageBg} 40%)`,
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
          <img src="./logo.png" alt="ADE Logo" style={{ width: 420, height: 240, objectFit: "contain", maxWidth: "72vw" }} />
        </div>
      </div>

      <button
        type="button"
        data-tour="project.welcomeOpenButton"
        onClick={() => setProjectBrowserOpen(true)}
        style={{
          ...primaryButton({ height: 48, padding: "0 32px", fontSize: 14 }),
          gap: 12,
          boxShadow: `0 4px 20px color-mix(in srgb, var(--color-accent) 40%, transparent)`,
          transition: "transform 0.2s ease, box-shadow 0.2s ease",
          marginTop: -16,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.transform = "translateY(-2px)";
          event.currentTarget.style.boxShadow = `0 6px 24px color-mix(in srgb, var(--color-accent) 60%, transparent)`;
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.transform = "none";
          event.currentTarget.style.boxShadow = `0 4px 20px color-mix(in srgb, var(--color-accent) 40%, transparent)`;
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
                data-tour="project.recentProject"
                onClick={() => {
                  if (project?.rootPath === rp.rootPath) {
                    cancelNewTab();
                    return;
                  }
                  void switchProjectToPath(rp.rootPath);
                }}
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
                    background: "color-mix(in srgb, var(--color-accent) 15%, transparent)",
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
                        background: "color-mix(in srgb, var(--color-accent) 20%, transparent)",
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
  const showWelcome = useAppStore((s) => s.showWelcome);

  const projectRoot = project?.rootPath ?? null;
  const [persistedLaneState, setPersistedLaneState] = useState<PersistedRunPageLaneState>(() => readRunPageLaneState(projectRoot));
  const [config, setConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [definitions, setDefinitions] = useState<ProcessDefinition[]>([]);
  const [runtime, setRuntime] = useState<ProcessRuntime[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const newGroupInputRef = useRef<HTMLInputElement>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingProcess, setEditingProcess] = useState<{ id: string; values: AddCommandInitialValues } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runShellSessions, setRunShellSessions] = useState<RunShellSession[]>([]);
  const [shellBusy, setShellBusy] = useState(false);
  const [networkDrawerOpen, setNetworkDrawerOpen] = useState(false);
  const [laneRuntimeBarOpen, setLaneRuntimeBarOpen] = useState(readLaneRuntimeBarOpenFromStorage);
  const runtimeRefreshTimerRef = useRef<number | null>(null);
  const runShellSessionsRef = useRef<RunShellSession[]>([]);

  const fallbackRunLaneId = useMemo(
    () => lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null,
    [lanes],
  );
  const groups = useMemo<ProcessGroupDefinition[]>(() => config?.effective.processGroups ?? [], [config?.effective.processGroups]);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );

  const commandLaneMap = useMemo(() => {
    const allowed = new Set(lanes.map((lane) => lane.id));
    const map: Record<string, string> = {};
    for (const definition of definitions) {
      const persistedLaneId = persistedLaneState.commandLaneIds[definition.id];
      const laneId = persistedLaneId && allowed.has(persistedLaneId)
        ? persistedLaneId
        : fallbackRunLaneId;
      if (laneId) map[definition.id] = laneId;
    }
    return map;
  }, [definitions, fallbackRunLaneId, lanes, persistedLaneState.commandLaneIds]);

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
    const defIds = new Set(definitions.map((definition) => definition.id));
    refreshLanePersistence((current) => {
      const next: Record<string, string> = { ...current.commandLaneIds };
      let changed = false;
      for (const [processId, laneId] of Object.entries(next)) {
        if (!defIds.has(processId) || !allowed.has(laneId)) {
          delete next[processId];
          changed = true;
        }
      }
      if (!changed) return current;
      return { commandLaneIds: next };
    });
  }, [definitions, lanes, projectRoot, refreshLanePersistence]);

  runShellSessionsRef.current = runShellSessions;

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
    setActionError(null);
  }, [fallbackRunLaneId]);

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
    return commandLaneMap[processId] ?? fallbackRunLaneId ?? null;
  }, [commandLaneMap, fallbackRunLaneId]);

  const selectProcessLane = useCallback((processId: string, laneId: string) => {
    refreshLanePersistence((current) => ({
      commandLaneIds: {
        ...current.commandLaneIds,
        [processId]: laneId,
      },
    }));
  }, [refreshLanePersistence]);

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
      await startProcess(processId, laneId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      console.error("[RunPage] handleRun failed:", error);
    }
  }, [resolveProcessLaneId, startProcess]);

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

  const buildLaneMapForSelectedGroup = useCallback((): Record<string, string> | null => {
    if (!selectedGroupId) return null;
    const laneByProcessId: Record<string, string> = {};
    for (const definition of definitions) {
      if (!(definition.groupIds ?? []).includes(selectedGroupId)) continue;
      const laneId = resolveProcessLaneId(definition.id);
      if (laneId) laneByProcessId[definition.id] = laneId;
    }
    return laneByProcessId;
  }, [definitions, resolveProcessLaneId, selectedGroupId]);

  const handleRunGroupAll = useCallback(async () => {
    if (!selectedGroupId) return;
    const laneByProcessId = buildLaneMapForSelectedGroup();
    if (!laneByProcessId || Object.keys(laneByProcessId).length === 0) return;
    const args = { groupId: selectedGroupId, laneByProcessId };
    try {
      setActionError(null);
      await window.ade.processes.startGroup(args);
    } catch (error) {
      if (error instanceof Error && error.message.includes("ADE_TRUST_REQUIRED")) {
        try {
          await window.ade.projectConfig.confirmTrust();
          await window.ade.processes.startGroup(args);
          return;
        } catch (retryError) {
          setActionError(retryError instanceof Error ? retryError.message : String(retryError));
          return;
        }
      }
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [buildLaneMapForSelectedGroup, selectedGroupId]);

  const handleStopGroupAll = useCallback(async () => {
    if (!selectedGroupId) return;
    const laneByProcessId = buildLaneMapForSelectedGroup();
    if (!laneByProcessId || Object.keys(laneByProcessId).length === 0) return;
    try {
      setActionError(null);
      await window.ade.processes.stopGroup({ groupId: selectedGroupId, laneByProcessId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [buildLaneMapForSelectedGroup, selectedGroupId]);

  useEffect(() => {
    if (creatingGroup) newGroupInputRef.current?.focus();
  }, [creatingGroup]);

  const handleCreateGroup = useCallback(async () => {
    const trimmed = newGroupName.trim();
    if (!trimmed || !config) return;
    try {
      setActionError(null);
      const newGroup: ConfigProcessGroupDefinition = { id: generateId(), name: trimmed };
      const shared = { ...config.shared };
      shared.processGroups = [...(shared.processGroups ?? []), newGroup];
      await window.ade.projectConfig.save({ shared, local: config.local });
      await refreshDefinitions();
      setSelectedGroupId(newGroup.id);
      setCreatingGroup(false);
      setNewGroupName("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [config, newGroupName, refreshDefinitions]);

  const handleLaunchShell = useCallback(async () => {
    const laneId = fallbackRunLaneId;
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
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setShellBusy(false);
    }
  }, [fallbackRunLaneId, shellBusy]);

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

  const saveProcessToConfig = useCallback(async (cmd: AddCommandSubmitPayload) => {
    if (!config) {
      throw new Error("Run configuration is still loading. Try again in a moment.");
    }
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

    await window.ade.projectConfig.save({ shared, local });
    await Promise.all([refreshDefinitions(), refreshRuntime()]);
  }, [config, projectRoot, refreshDefinitions, refreshRuntime]);

  const updateProcessInConfig = useCallback(async (processId: string, cmd: AddCommandSubmitPayload & { restart?: ProcessRestartPolicy }) => {
    if (!config) {
      throw new Error("Run configuration is still loading. Try again in a moment.");
    }
    const shared = { ...config.shared };
    const local = { ...config.local };
    const createdGroups: ConfigProcessGroupDefinition[] = cmd.newGroupNames.map((name) => ({
      id: generateId(),
      name,
    }));
    const allGroupIds = [...cmd.groupIds, ...createdGroups.map((group) => group.id)];
    const existingProcess =
      (config.local.processes ?? []).find((entry) => entry.id === processId) ??
      (config.shared.processes ?? []).find((entry) => entry.id === processId);
    const cmdForBuild = { ...cmd, restart: cmd.restart ?? existingProcess?.restart };
    const { process: nextProcess, localOnly } = buildProcessConfigDefinition(processId, cmdForBuild, allGroupIds, projectRoot);
    const existingLocal = (config.local.processes ?? []).some((entry) => entry.id === processId);
    const targetLocal = existingLocal || localOnly;

    if (targetLocal) {
      local.processes = upsertProcess(local.processes, nextProcess);
      local.processGroups = [...(local.processGroups ?? []), ...createdGroups];
      if (localOnly) {
        shared.processes = removeProcess(shared.processes, processId);
      }
    } else {
      shared.processes = upsertProcess(shared.processes, nextProcess);
      shared.processGroups = [...(shared.processGroups ?? []), ...createdGroups];
      local.processes = removeProcess(local.processes, processId);
    }

    await window.ade.projectConfig.save({ shared, local });
    await Promise.all([refreshDefinitions(), refreshRuntime()]);
  }, [config, projectRoot, refreshDefinitions, refreshRuntime]);

  const handleAddProcessToGroup = useCallback(async (processId: string, groupId: string) => {
    const definition = definitions.find((entry) => entry.id === processId);
    if (!definition || (definition.groupIds ?? []).includes(groupId)) return;
    const nextGroupIds = [...new Set([...(definition.groupIds ?? []), groupId])];
    await updateProcessInConfig(processId, {
      name: definition.name,
      command: commandArrayToLine(definition.command),
      cwd: definition.cwd || ".",
      env: envToText(definition.env),
      autostart: definition.autostart,
      restart: definition.restart,
      gracefulShutdownMs: String(definition.gracefulShutdownMs ?? 7000),
      dependsOn: (definition.dependsOn ?? []).join(", "),
      groupIds: nextGroupIds,
      newGroupNames: [],
    });
  }, [definitions, updateProcessInConfig]);

  const handleDeleteProcess = useCallback(async (processId: string) => {
    if (!config) return;
    const shared = { ...config.shared };
    const local = { ...config.local };
    shared.processes = (shared.processes ?? []).filter((processEntry) => processEntry.id !== processId);
    local.processes = (local.processes ?? []).filter((processEntry) => processEntry.id !== processId);
    await window.ade.projectConfig.save({ shared, local });
    await Promise.all([refreshDefinitions(), refreshRuntime()]);
  }, [config, refreshDefinitions, refreshRuntime]);

  const handleEditProcess = useCallback((processId: string) => {
    const definition = definitions.find((entry) => entry.id === processId);
    if (!definition) return;
    setEditingProcess({
      id: processId,
      values: {
        name: definition.name,
        command: commandArrayToLine(definition.command),
        cwd: definition.cwd || ".",
        env: envToText(definition.env),
        autostart: definition.autostart,
        gracefulShutdownMs: String(definition.gracefulShutdownMs ?? 7000),
        dependsOn: (definition.dependsOn ?? []).join(", "),
        groupIds: definition.groupIds ?? [],
      },
    });
  }, [definitions]);

  const filteredDefinitions = useMemo(() => {
    if (!selectedGroupId) return definitions;
    return definitions.filter((definition) => (definition.groupIds ?? []).includes(selectedGroupId));
  }, [definitions, selectedGroupId]);

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
        data-tour="run.header"
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

        {filteredDefinitions.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 700, color: COLORS.textPrimary }}>
              {selectedGroup?.name ?? "All commands"}
            </span>
            <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
              ({filteredDefinitions.length})
            </span>
          </div>
        ) : null}

        <div style={{ flex: 1 }} />

        <button
          type="button"
          id="run-lane-runtime-toggle"
          data-tour="run.runtimeBar"
          aria-expanded={laneRuntimeBarOpen}
          aria-controls="run-lane-runtime-panel"
          onClick={() => {
            setLaneRuntimeBarOpen((prev) => {
              const next = !prev;
              writeLaneRuntimeBarOpenToStorage(next);
              return next;
            });
          }}
          style={{
            ...outlineButton(),
            gap: 6,
          }}
        >
          {laneRuntimeBarOpen ? <CaretUp size={14} weight="bold" /> : <CaretDown size={14} weight="bold" />}
          Advanced
        </button>

        <button
          type="button"
          data-tour="run.newShell"
          onClick={() => void handleLaunchShell()}
          disabled={!fallbackRunLaneId || shellBusy}
          style={{
            ...outlineButton(),
            opacity: fallbackRunLaneId && !shellBusy ? 1 : 0.45,
            cursor: fallbackRunLaneId && !shellBusy ? "pointer" : "default",
          }}
        >
          <Terminal size={14} weight="bold" />
          {shellBusy ? "Opening shell..." : "New shell"}
        </button>

        {selectedGroupId ? (
          <>
            <button
              type="button"
              data-tour="run.groupRunAll"
              onClick={() => void handleRunGroupAll()}
              disabled={!fallbackRunLaneId}
              style={{
                ...outlineButton(),
                opacity: fallbackRunLaneId ? 1 : 0.45,
                cursor: fallbackRunLaneId ? "pointer" : "default",
              }}
            >
              <Play size={14} weight="fill" />
              Run all
            </button>
            <button
              type="button"
              data-tour="run.groupStopAll"
              onClick={() => void handleStopGroupAll()}
              disabled={!fallbackRunLaneId}
              style={{
                ...outlineButton(),
                opacity: fallbackRunLaneId ? 1 : 0.45,
                cursor: fallbackRunLaneId ? "pointer" : "default",
              }}
            >
              <Stop size={14} weight="fill" />
              Stop all
            </button>
          </>
        ) : null}

        <button type="button" data-tour="run.addCommand" onClick={() => setAddDialogOpen(true)} style={outlineButton()}>
          <Plus size={14} weight="bold" />
          Add command
        </button>
      </div>

      <div
        id="run-lane-runtime-panel"
        role="region"
        aria-labelledby="run-lane-runtime-toggle"
        hidden={!laneRuntimeBarOpen}
        style={{ flexShrink: 0 }}
      >
        {laneRuntimeBarOpen ? (
          <LaneRuntimeBar laneId={fallbackRunLaneId} onOpenPreviewRouting={() => setNetworkDrawerOpen(true)} />
        ) : null}
      </div>

      <div
        data-tour="run.groupFilter"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 20px",
          borderBottom: `1px solid ${COLORS.border}`,
          flexShrink: 0,
          overflowX: "auto",
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
            flexShrink: 0,
          }}
        >
          All commands
        </button>
        <div
          role="separator"
          aria-hidden="true"
          style={{
            width: 2,
            height: 28,
            background: "#FFFFFF",
            flexShrink: 0,
          }}
        />
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
              flexShrink: 0,
            }}
          >
            {group.name}
            <span style={{ marginLeft: 6, color: COLORS.textDim }}>{groupCounts[group.id] ?? 0}</span>
          </button>
        ))}
        {creatingGroup ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <input
              ref={newGroupInputRef}
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreateGroup();
                if (event.key === "Escape") {
                  setCreatingGroup(false);
                  setNewGroupName("");
                }
              }}
              placeholder="Group name"
              style={{
                width: 160,
                height: 28,
                padding: "0 10px",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
                fontSize: 11,
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => void handleCreateGroup()}
              disabled={!newGroupName.trim()}
              style={{
                ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }),
                opacity: newGroupName.trim() ? 1 : 0.45,
              }}
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setCreatingGroup(false);
                setNewGroupName("");
              }}
              style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-tour="run.newGroup"
            onClick={() => setCreatingGroup(true)}
            disabled={!config}
            style={{
              ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }),
              opacity: config ? 1 : 0.45,
              flexShrink: 0,
            }}
          >
            <Plus size={12} weight="bold" />
            New group
          </button>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
        {actionError ? (
          <div
            style={{
              margin: "20px 20px 0",
              padding: "10px 12px",
              border: "1px solid color-mix(in srgb, var(--color-error) 40%, transparent)",
              borderLeft: `3px solid ${COLORS.danger}`,
              background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
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
                Add a command or assign groups. Every Run click opens a fresh terminal session.
              </div>
              <button type="button" onClick={() => setAddDialogOpen(true)} style={primaryButton()}>
                <Plus size={14} weight="bold" />
                Add command
              </button>
            </div>
          ) : (
            <div data-tour="run.commandCards" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
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
                    onEdit={handleEditProcess}
                    onDelete={handleDeleteProcess}
                    onAddToGroup={handleAddProcessToGroup}
                    onKillRuntime={handleKillRuntime}
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

      {runShellSessions.length > 0 ? (
        <div
          data-tour="run.shellSessions"
          style={{
            flexShrink: 0,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            padding: "10px 20px",
            borderTop: `1px solid ${COLORS.border}`,
            background: COLORS.recessedBg,
          }}
        >
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              fontWeight: 700,
              color: COLORS.textDim,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Shells
          </span>
          {runShellSessions.map((session) => {
            const shellLaneName = lanes.find((item) => item.id === session.laneId)?.name ?? session.laneId;
            return (
              <div
                key={session.sessionId}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 10px",
                  background: COLORS.pageBg,
                  border: `1px solid ${COLORS.border}`,
                }}
              >
                <Terminal size={14} weight="bold" style={{ color: COLORS.textMuted, flexShrink: 0 }} />
                <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>{session.title}</span>
                <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>{shellLaneName}</span>
                <button
                  type="button"
                  onClick={() => {
                    void handleCloseRunShell(session.sessionId);
                  }}
                  aria-label={`Close ${session.title}`}
                  style={{
                    width: 26,
                    height: 26,
                    background: "transparent",
                    border: "none",
                    color: COLORS.textMuted,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <X size={14} weight="bold" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <AddCommandDialog
        groups={groups}
        lanes={lanes}
        defaultLaneId={fallbackRunLaneId}
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSubmit={saveProcessToConfig}
      />

      <AddCommandDialog
        groups={groups}
        lanes={lanes}
        defaultLaneId={fallbackRunLaneId}
        open={editingProcess !== null}
        onClose={() => setEditingProcess(null)}
        onSubmit={async (cmd) => {
          if (!editingProcess) {
            throw new Error("No command is selected for editing.");
          }
          await updateProcessInConfig(editingProcess.id, cmd);
        }}
        initialValues={editingProcess?.values ?? null}
        title="Edit command"
        submitLabel="Save changes"
      />
    </div>
  );
}
