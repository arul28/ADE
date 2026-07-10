import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  ChatCircleDots,
  DesktopTower,
  Folder,
  Play,
  Plus,
  PushPin,
  Stop,
  Terminal,
  X,
} from "@phosphor-icons/react";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { useLaneListInvalidation } from "../../hooks/useLaneListInvalidation";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { CommandCard } from "./CommandCard";
import { CommandPalette } from "../app/CommandPalette";
import { deriveIconAccentColor } from "../../lib/iconAccent";
import { LaneRuntimeBar } from "./LaneRuntimeBar";
import {
  AddCommandDialog,
  type AddCommandInitialValues,
  type AddCommandSubmitPayload,
} from "./AddCommandDialog";
import { RunNetworkPanel } from "./RunNetworkPanel";
import { commandArrayToLine, parseCommandLine } from "../../lib/shell";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { toRelativeTime } from "../graph/graphHelpers";
import { isActiveProcessStatus } from "./processUtils";
import {
  ChatTerminalDrawer,
  ChatTerminalToggle,
} from "../chat/ChatTerminalDrawer";
import type {
  ConfigProcessDefinition,
  ProcessDefinition,
  ProcessEvent,
  ProcessGroupDefinition,
  ProcessRestartPolicy,
  ProcessRuntime,
  ProjectConfigSnapshot,
  ConfigProcessGroupDefinition,
  ProjectIcon,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
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
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
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
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized))
    return normalized || ".";
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

function projectRelativeFromAbsolute(
  projectRoot: string | null,
  value: string,
): string | null {
  if (!projectRoot || !isAbsoluteConfigPath(value)) return null;
  const root = trimTrailingSlash(projectRoot);
  const candidate = trimTrailingSlash(value);
  const windowsPath =
    /^[A-Za-z]:\//.test(root) || /^[A-Za-z]:\//.test(candidate);
  const rootKey = windowsPath ? root.toLowerCase() : root;
  const candidateKey = windowsPath ? candidate.toLowerCase() : candidate;
  if (candidateKey === rootKey) return ".";
  if (!candidateKey.startsWith(`${rootKey}/`)) return null;
  return candidate.slice(root.length + 1) || ".";
}

function relativePathFromProjectDir(fromDir: string, toPath: string): string {
  const fromParts = normalizeRelativePath(fromDir)
    .split("/")
    .filter((part) => part && part !== ".");
  const toParts = normalizeRelativePath(toPath)
    .split("/")
    .filter((part) => part && part !== ".");
  let idx = 0;
  while (
    idx < fromParts.length &&
    idx < toParts.length &&
    fromParts[idx] === toParts[idx]
  )
    idx += 1;
  const up = fromParts.slice(idx).map(() => "..");
  const down = toParts.slice(idx);
  const relative = [...up, ...down].join("/");
  return relative || ".";
}

function normalizeCwdForConfig(
  cwd: string,
  projectRoot: string | null,
): string | undefined {
  const normalized = normalizeRelativePath(cwd);
  return projectRelativeFromAbsolute(projectRoot, normalized) ?? normalized;
}

function normalizeCommandForConfig(
  commandLine: string,
  cwd: string | undefined,
  projectRoot: string | null,
): {
  command: string[];
  localOnly: boolean;
} {
  const command = parseCommandLine(commandLine);
  const normalizedCwd = cwd ?? ".";
  const hasOutsideProjectAbsolutePath = command.some(
    (part) =>
      isAbsoluteConfigPath(part) &&
      projectRelativeFromAbsolute(projectRoot, part) == null,
  );
  if (!command[0]) return { command, localOnly: hasOutsideProjectAbsolutePath };

  const executableProjectPath = projectRelativeFromAbsolute(
    projectRoot,
    command[0],
  );
  if (executableProjectPath == null) {
    return { command, localOnly: hasOutsideProjectAbsolutePath };
  }

  const executableFromCwd = relativePathFromProjectDir(
    normalizedCwd,
    executableProjectPath,
  );
  const executable =
    executableFromCwd.includes("/") || executableFromCwd.startsWith(".")
      ? executableFromCwd
      : `./${executableFromCwd}`;
  return {
    command: [executable, ...command.slice(1)],
    localOnly: hasOutsideProjectAbsolutePath,
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
  const cwdLocalOnly =
    isAbsoluteConfigPath(cmd.cwd) &&
    projectRelativeFromAbsolute(projectRoot, cmd.cwd) == null;
  return {
    process: {
      id: processId,
      name: cmd.name,
      command: command.command,
      cwd,
      env: parseEnvText(cmd.env),
      autostart: cmd.autostart ? true : undefined,
      restart:
        cmd.restart == null || cmd.restart === "never"
          ? undefined
          : cmd.restart,
      gracefulShutdownMs: parseGracefulShutdownMs(cmd.gracefulShutdownMs),
      dependsOn: parseDependsOnCsv(cmd.dependsOn),
      readiness: { type: "none" },
      groupIds: allGroupIds.length > 0 ? allGroupIds : undefined,
    },
    localOnly: command.localOnly || cwdLocalOnly,
  };
}

function upsertProcess(
  processes: ConfigProcessDefinition[] | undefined,
  processEntry: ConfigProcessDefinition,
): ConfigProcessDefinition[] {
  const existing = processes ?? [];
  return existing.some((entry) => entry.id === processEntry.id)
    ? existing.map((entry) =>
        entry.id === processEntry.id ? processEntry : entry,
      )
    : [...existing, processEntry];
}

function removeProcess(
  processes: ConfigProcessDefinition[] | undefined,
  processId: string,
): ConfigProcessDefinition[] {
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
    window.localStorage.setItem(
      LANE_RUNTIME_BAR_OPEN_KEY,
      open ? "true" : "false",
    );
  } catch {
    // ignore persistence failures
  }
}

type PersistedRunPageLaneState = {
  commandLaneIds: Record<string, string>;
};

type PendingRunLaunch = {
  targets: Array<{
    laneId: string;
    processId: string;
  }>;
};

function readRunPageLaneState(
  projectRoot: string | null,
): PersistedRunPageLaneState {
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
        Object.entries(
          (record.commandLaneIds as Record<string, unknown>) ?? {},
        ).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
  } catch {
    return { commandLaneIds: {} };
  }
}

function writeRunPageLaneState(
  projectRoot: string | null,
  state: PersistedRunPageLaneState,
) {
  if (!projectRoot) return;
  try {
    const raw = window.localStorage.getItem(RUN_PAGE_LANE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    parsed[projectRoot] = { commandLaneIds: state.commandLaneIds };
    window.localStorage.setItem(
      RUN_PAGE_LANE_STORAGE_KEY,
      JSON.stringify(parsed),
    );
  } catch {
    // ignore persistence failures
  }
}

function runPageLaneStateEqual(
  left: PersistedRunPageLaneState,
  right: PersistedRunPageLaneState,
): boolean {
  const leftEntries = Object.entries(left.commandLaneIds);
  const rightEntries = Object.entries(right.commandLaneIds);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(
    ([processId, laneId]) => right.commandLaneIds[processId] === laneId,
  );
}

function ProjectIconArtwork({
  dataUrl,
  fallback,
  onAccentColor,
}: {
  dataUrl: string | null | undefined;
  fallback: ReactNode;
  // Reports the icon's sampled accent color (or null) so the row can tint its
  // tile to match the logo. Fires null until an icon resolves.
  onAccentColor?: (color: string | null) => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [dataUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!dataUrl || failed) {
      onAccentColor?.(null);
      return () => {
        cancelled = true;
      };
    }
    deriveIconAccentColor(dataUrl)
      .then((color) => {
        if (!cancelled) onAccentColor?.(color);
      })
      .catch(() => {
        if (!cancelled) onAccentColor?.(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dataUrl, failed, onAccentColor]);

  if (dataUrl && !failed) {
    return (
      <img
        src={dataUrl}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          objectFit: "contain",
        }}
      />
    );
  }

  return <>{fallback}</>;
}

function RecentProjectIcon({
  rootPath,
  onAccentColor,
}: {
  rootPath: string;
  onAccentColor?: (color: string | null) => void;
}) {
  const [icon, setIcon] = useState<ProjectIcon | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIcon(null);
    window.ade.project
      .resolveIcon(rootPath)
      .then((nextIcon) => {
        if (!cancelled) setIcon(nextIcon);
      })
      .catch(() => {
        if (!cancelled) setIcon(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  return (
    <ProjectIconArtwork
      dataUrl={icon?.dataUrl}
      fallback={<Folder size={16} weight="regular" />}
      onAccentColor={onAccentColor}
    />
  );
}

const REMOTE_ACCENT = "#F59E0B";

function recentKey(rp: RecentProjectSummary): string {
  return rp.kind === "remote" && rp.remote
    ? `remote:${rp.remote.targetId}:${rp.remote.projectId}`
    : rp.rootPath;
}

// Abbreviate the user's home directory to `~` for compact local paths.
function abbreviateHome(path: string): string {
  const home =
    typeof process !== "undefined" ? (process.env?.HOME ?? "") : "";
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

// A single recents row. Local rows resolve a project icon (and tint their tile
// with the sampled accent); remote rows use a host-resolved icon when present,
// plus the amber machine badge and connection dot. Offline remote rows are
// dimmed with a Reconnect affordance.
function RecentProjectRow({
  rp,
  connectionState,
  isOpen,
  isForgetting,
  onOpen,
  onTogglePin,
  onForget,
}: {
  rp: RecentProjectSummary;
  connectionState: RemoteRuntimeConnectionState | null;
  isOpen: boolean;
  isForgetting: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onForget: () => void;
}) {
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const isRemote = rp.kind === "remote" && Boolean(rp.remote);
  const connected = connectionState === "connected";
  const connecting = connectionState === "connecting";
  // Remote rows are "offline" until their target reports a live connection.
  const offline = isRemote && !connected;
  const remoteIconDataUrl = isRemote ? rp.remote?.iconDataUrl : null;
  const hasRemoteIcon = Boolean(remoteIconDataUrl);
  let tileAccent = accentColor;
  if (isRemote) {
    tileAccent = hasRemoteIcon ? (accentColor ?? REMOTE_ACCENT) : REMOTE_ACCENT;
  }
  const tileBg = tileAccent
    ? `color-mix(in srgb, ${tileAccent} 18%, transparent)`
    : "color-mix(in srgb, var(--color-accent) 15%, transparent)";
  const tileColor = tileAccent ?? COLORS.accent;
  const edgeColor = isRemote ? REMOTE_ACCENT : (tileAccent ?? COLORS.accent);
  const showRowActions = !connecting;

  const dotColor = connected
    ? "#34D399"
    : connecting
      ? REMOTE_ACCENT
      : "rgba(148,163,184,0.7)";

  return (
    <div className="group" style={{ position: "relative" }}>
      <button
        type="button"
        data-tour="project.recentProject"
        onClick={onOpen}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          paddingRight: showRowActions ? 64 : 16,
          width: "100%",
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${COLORS.border}`,
          borderLeft: `3px solid color-mix(in srgb, ${edgeColor} 60%, transparent)`,
          borderRadius: 12,
          color: COLORS.textPrimary,
          fontFamily: MONO_FONT,
          fontSize: 12,
          cursor: "pointer",
          textAlign: "left",
          transition: "all 0.2s ease",
          backdropFilter: "blur(10px)",
          opacity: offline ? 0.6 : 1,
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
            background: tileBg,
            color: tileColor,
            flexShrink: 0,
            position: "relative",
          }}
        >
          {isRemote ? (
            <>
              <ProjectIconArtwork
                dataUrl={remoteIconDataUrl}
                fallback={<DesktopTower size={18} weight="duotone" />}
                onAccentColor={setAccentColor}
              />
              {hasRemoteIcon ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    right: -3,
                    bottom: -3,
                    width: 14,
                    height: 14,
                    borderRadius: 5,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(18,13,6,0.94)",
                    border: "1px solid color-mix(in srgb, #F59E0B 62%, transparent)",
                    color: "#FBBF24",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                  }}
                >
                  <DesktopTower size={9} weight="duotone" />
                </span>
              ) : null}
            </>
          ) : (
            <RecentProjectIcon
              rootPath={rp.rootPath}
              onAccentColor={setAccentColor}
            />
          )}
        </div>
        <div style={{ overflow: "hidden", flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 2,
            }}
          >
            <span
              style={{
                fontWeight: 600,
                fontSize: 13,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {rp.displayName}
            </span>
            {isRemote && rp.remote ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  padding: "2px 7px",
                  borderRadius: 8,
                  background: "color-mix(in srgb, #F59E0B 16%, transparent)",
                  color: "#FBBF24",
                  border: "1px solid color-mix(in srgb, #F59E0B 30%, transparent)",
                  flexShrink: 0,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: dotColor,
                    animation: connecting
                      ? "ade-recent-dot-pulse 1.1s ease-in-out infinite"
                      : undefined,
                  }}
                />
                {rp.remote.runtimeName}
              </span>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 10,
              color: COLORS.textDim,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {isRemote ? rp.rootPath : abbreviateHome(rp.rootPath)}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
            flexShrink: 0,
            minWidth: connecting ? 96 : 68,
            maxWidth: connecting ? 116 : 96,
          }}
        >
          {offline ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: connecting ? "#FBBF24" : COLORS.textMuted,
              }}
            >
              <ArrowsClockwise
                size={11}
                weight="bold"
                style={
                  connecting
                    ? { animation: "ade-recent-spin 0.9s linear infinite" }
                    : undefined
                }
              />
              {connecting ? "Reconnecting" : "Reconnect"}
            </span>
          ) : rp.laneCount !== undefined ? (
            <span
              style={{
                fontSize: 10,
                background:
                  "color-mix(in srgb, var(--color-accent) 20%, transparent)",
                color: COLORS.accent,
                padding: "2px 6px",
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              {rp.laneCount} lane{rp.laneCount !== 1 ? "s" : ""}
            </span>
          ) : null}
          {rp.lastOpenedAt && !connecting ? (
            <span style={{ fontSize: 9, color: COLORS.textDim }}>
              {toRelativeTime(rp.lastOpenedAt)}
            </span>
          ) : null}
        </div>
      </button>
      {showRowActions ? (
        <div
          className={
            rp.pinned ? undefined : "opacity-0 group-hover:opacity-100"
          }
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            display: "flex",
            gap: 4,
            transition: "opacity 0.15s ease",
            zIndex: 2,
          }}
        >
          <button
            type="button"
            aria-label={
              rp.pinned
                ? `Unpin ${rp.displayName}`
                : `Pin ${rp.displayName} to top`
            }
            aria-pressed={rp.pinned ? true : false}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: rp.pinned
                ? "color-mix(in srgb, var(--color-accent) 26%, transparent)"
                : "rgba(255,255,255,0.06)",
              border: rp.pinned
                ? "1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)"
                : "1px solid rgba(255,255,255,0.08)",
              color: rp.pinned ? COLORS.accent : COLORS.textDim,
              cursor: "pointer",
              transition: "background 0.15s ease, color 0.15s ease",
              padding: 0,
            }}
            title={rp.pinned ? "Unpin" : "Pin to top"}
          >
            <PushPin size={12} weight={rp.pinned ? "fill" : "regular"} />
          </button>
          <button
            type="button"
            aria-label={`Remove ${rp.displayName} from recents`}
            onClick={(e) => {
              e.stopPropagation();
              onForget();
            }}
            disabled={isForgetting}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: COLORS.textDim,
              cursor: "pointer",
              transition: "background 0.15s ease, color 0.15s ease",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(239,68,68,0.18)";
              e.currentTarget.style.color = "#EF4444";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.06)";
              e.currentTarget.style.color = COLORS.textDim;
            }}
            title="Remove from recents"
          >
            <X size={12} weight="bold" />
          </button>
        </div>
      ) : null}
      {isOpen ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 6,
            left: 10,
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: COLORS.accent,
            pointerEvents: "none",
          }}
        >
          Open
        </span>
      ) : null}
    </div>
  );
}

// How long the "Removed — Undo" toast stays before the forget is committed.
const FORGET_UNDO_WINDOW_MS = 5_000;

function WelcomeScreen() {
  const navigate = useNavigate();
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const switchRemoteProject = useAppStore((s) => s.switchRemoteProject);
  const project = useAppStore((s) => s.project);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>(
    [],
  );
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
  const [remoteSnapshot, setRemoteSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  // Keys hidden by a pending deferred forget (committed only after the undo
  // window expires). Reconnect/open state is keyed the same way.
  const [pendingForgetKeys, setPendingForgetKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [forgetToast, setForgetToast] = useState<{
    key: string;
    name: string;
  } | null>(null);
  const [connectingKeys, setConnectingKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [rowError, setRowError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const forgetTimerRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    window.ade.project
      .listRecent()
      .then(setRecentProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const remoteRuntime = window.ade.remoteRuntime;
    if (!remoteRuntime?.getConnectionSnapshot) return;
    let cancelled = false;
    void remoteRuntime
      .getConnectionSnapshot()
      .then((snapshot) => {
        if (!cancelled) setRemoteSnapshot(snapshot);
      })
      .catch(() => {
        if (!cancelled) setRemoteSnapshot(null);
      });
    const unsubscribe =
      remoteRuntime.onConnectionSnapshotChanged?.((snapshot) => {
        if (!cancelled) setRemoteSnapshot(snapshot);
      }) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(
    () => () => {
      if (forgetTimerRef.current != null) {
        window.clearTimeout(forgetTimerRef.current);
      }
    },
    [],
  );

  // Live connection state per remote target, used to pick the dot color and
  // decide whether a remote row needs a reconnect before opening.
  const connectionByTarget = useMemo(() => {
    const map = new Map<string, RemoteRuntimeConnectionState>();
    for (const connection of remoteSnapshot?.connections ?? []) {
      map.set(connection.target.id, connection.state);
    }
    return map;
  }, [remoteSnapshot]);

  const visibleProjects = useMemo(() => {
    const kept = recentProjects.filter((rp) => {
      if (pendingForgetKeys.has(recentKey(rp))) return false;
      if (rp.kind === "remote") return true;
      return rp.exists && !rp.rootPath.includes("ade-project");
    });
    // Pinned rows float to the top while preserving the recency order within
    // each group (stable sort).
    return kept
      .map((rp, index) => ({ rp, index }))
      .sort((a, b) => {
        const pinnedDelta =
          (b.rp.pinned ? 1 : 0) - (a.rp.pinned ? 1 : 0);
        return pinnedDelta !== 0 ? pinnedDelta : a.index - b.index;
      })
      .map((entry) => entry.rp);
  }, [recentProjects, pendingForgetKeys]);

  const connectedRemoteCount = remoteSnapshot?.connectedCount ?? 0;

  const handleOpen = useCallback(
    (rp: RecentProjectSummary) => {
      setRowError(null);
      if (rp.kind === "remote" && rp.remote) {
        const key = recentKey(rp);
        const targetId = rp.remote.targetId;
        const projectId = rp.remote.projectId;
        const state = connectionByTarget.get(targetId) ?? null;
        if (state === "connected") {
          void switchRemoteProject(targetId, projectId).catch((error) => {
            setRowError(
              error instanceof Error ? error.message : String(error),
            );
          });
          return;
        }
        // Offline: establish the SSH connection first, then bind the project.
        setConnectingKeys((prev) => new Set(prev).add(key));
        void (async () => {
          try {
            await window.ade.remoteRuntime.connect(targetId);
            await switchRemoteProject(targetId, projectId);
          } catch (error) {
            setRowError(
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            setConnectingKeys((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          }
        })();
        return;
      }
      if (project?.rootPath === rp.rootPath) {
        cancelNewTab();
        return;
      }
      void switchProjectToPath(rp.rootPath);
    },
    [
      cancelNewTab,
      connectionByTarget,
      project?.rootPath,
      switchProjectToPath,
      switchRemoteProject,
    ],
  );

  const handleTogglePin = useCallback(async (rp: RecentProjectSummary) => {
    try {
      const next = await window.ade.project.setRecentPinned(
        recentKey(rp),
        !rp.pinned,
      );
      setRecentProjects(next);
    } catch (error) {
      setRowError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // Deferred-commit forget: hide the row immediately and show an undo toast.
  // Only after the window elapses do we call the backend forget. Undo cancels
  // the timer and unhides the row, with no backend call.
  const commitForget = useCallback((key: string) => {
    if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    window.ade.project
      .forgetRecent(key)
      .then((next) => setRecentProjects(next))
      .catch(() => {});
    setPendingForgetKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setForgetToast(null);
  }, []);

  const handleForget = useCallback(
    (rp: RecentProjectSummary) => {
      const key = recentKey(rp);
      // Flush any prior pending forget so we never stack timers.
      const previousKey = forgetToast?.key ?? null;
      if (previousKey && previousKey !== key) {
        commitForget(previousKey);
      } else if (forgetTimerRef.current != null) {
        window.clearTimeout(forgetTimerRef.current);
        forgetTimerRef.current = null;
      }
      setForgetToast({ key, name: rp.displayName });
      setPendingForgetKeys((prev) => new Set(prev).add(key));
      forgetTimerRef.current = window.setTimeout(() => {
        forgetTimerRef.current = null;
        commitForget(key);
      }, FORGET_UNDO_WINDOW_MS);
    },
    [commitForget, forgetToast?.key],
  );

  const handleUndoForget = useCallback(() => {
    if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    setForgetToast((current) => {
      if (current) {
        setPendingForgetKeys((prev) => {
          const next = new Set(prev);
          next.delete(current.key);
          return next;
        });
      }
      return null;
    });
  }, []);

  const handleDropFolder = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      try {
        const path = window.ade.project.getDroppedPath(file);
        if (path) {
          setRowError(null);
          void switchProjectToPath(path);
        }
      } catch (error) {
        setRowError(error instanceof Error ? error.message : String(error));
      }
    },
    [switchProjectToPath],
  );

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragOver(false);
      }}
      onDrop={handleDropFolder}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        height: "100%",
        background: `radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--color-accent) 15%, transparent) 0%, ${COLORS.pageBg} 40%)`,
        overflow: "hidden",
        outline: isDragOver
          ? "2px dashed color-mix(in srgb, var(--color-accent) 70%, transparent)"
          : "none",
        outlineOffset: -8,
        transition: "outline-color 0.15s ease",
      }}
    >
      <style>
        {`@keyframes ade-recent-dot-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.7); }
          }
          @keyframes ade-recent-spin {
            to { transform: rotate(360deg); }
          }`}
      </style>
      {isDragOver ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 16,
            borderRadius: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "color-mix(in srgb, var(--color-accent) 10%, transparent)",
            color: COLORS.accent,
            fontFamily: MONO_FONT,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            zIndex: 30,
            pointerEvents: "none",
          }}
        >
          Drop a folder to open
        </div>
      ) : null}
      {/* Top spacer: pushes the logo title down to ~1/3 of the screen height.
          Paired with the 2x bottom region below so free space splits 1:2. */}
      <div aria-hidden style={{ flex: "1 1 0%", minHeight: 32 }} />

      {/* Pinned header: logo + add button */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 32, paddingBottom: 16 }}>
        <div style={{ textAlign: "center", maxWidth: 520 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 16,
              filter:
                "drop-shadow(0 0 22px color-mix(in srgb, var(--color-accent) 45%, transparent))",
            }}
          >
            <img
              src="./logo.png"
              alt="ADE Logo"
              style={{
                width: 420,
                height: 240,
                objectFit: "contain",
                maxWidth: "72vw",
              }}
            />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap", marginTop: -16 }}>
        <button
          type="button"
          data-tour="project.welcomeAddButton"
          onClick={() => setProjectBrowserOpen(true)}
          style={{
            ...primaryButton({ height: 48, padding: "0 32px", fontSize: 14 }),
            gap: 12,
            border:
              connectedRemoteCount > 0
                ? "1px solid rgba(245,158,11,0.72)"
                : undefined,
            boxShadow:
              connectedRemoteCount > 0
                ? "0 0 0 1px rgba(245,158,11,0.24), 0 6px 28px rgba(245,158,11,0.24)"
                : `0 4px 20px color-mix(in srgb, var(--color-accent) 40%, transparent)`,
            transition: "transform 0.2s ease, box-shadow 0.2s ease",
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.transform = "translateY(-2px)";
            event.currentTarget.style.boxShadow =
              connectedRemoteCount > 0
                ? "0 0 0 1px rgba(245,158,11,0.38), 0 8px 34px rgba(245,158,11,0.34)"
                : `0 6px 24px color-mix(in srgb, var(--color-accent) 60%, transparent)`;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.transform = "none";
            event.currentTarget.style.boxShadow =
              connectedRemoteCount > 0
                ? "0 0 0 1px rgba(245,158,11,0.24), 0 6px 28px rgba(245,158,11,0.24)"
                : `0 4px 20px color-mix(in srgb, var(--color-accent) 40%, transparent)`;
          }}
        >
          <Plus size={20} weight="bold" />
          ADD PROJECT
        </button>
        <button
          type="button"
          onClick={() => navigate("/chats")}
          style={{
            ...outlineButton({ height: 48, padding: "0 22px", fontSize: 12 }),
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
            color: COLORS.textPrimary,
            border: `1px solid ${COLORS.border}`,
            background: "color-mix(in srgb, var(--color-surface-raised) 88%, transparent)",
            boxShadow: `0 4px 20px color-mix(in srgb, var(--color-accent) 40%, transparent)`,
            transition: "transform 0.2s ease, box-shadow 0.2s ease",
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
          <ChatCircleDots size={18} weight="duotone" />
          CHAT WITHOUT A PROJECT
        </button>
        </div>
        {connectedRemoteCount > 0 ? (
          <div
            style={{
              marginTop: -22,
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#FBBF24",
            }}
          >
            {connectedRemoteCount} remote device
            {connectedRemoteCount === 1 ? "" : "s"} available
          </div>
        ) : null}
      </div>

      {/* Scrollable recent projects list (takes ~2/3 of the free space) */}
      {visibleProjects.length > 0 ? (
        <div style={{ flex: "2 1 0%", minHeight: 0, width: "100%", display: "flex", justifyContent: "center", overflow: "hidden" }}>
          <div style={{ width: "100%", maxWidth: 440, overflowY: "auto", paddingLeft: 16, paddingRight: 16, paddingBottom: 48 }}>
            <div
              style={{
                ...LABEL_STYLE,
                marginBottom: 12,
                textAlign: "center",
                color: COLORS.textMuted,
              }}
            >
              RECENT PROJECTS
            </div>
            {rowError ? (
              <div
                role="alert"
                style={{
                  marginBottom: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border:
                    "1px solid color-mix(in srgb, var(--color-error) 40%, transparent)",
                  background:
                    "color-mix(in srgb, var(--color-error) 12%, transparent)",
                  color: COLORS.textPrimary,
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  whiteSpace: "pre-wrap",
                }}
              >
                {rowError}
              </div>
            ) : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visibleProjects.map((rp) => {
                const key = recentKey(rp);
                const isRemote = rp.kind === "remote" && Boolean(rp.remote);
                const targetId = rp.remote?.targetId;
                const baseState = isRemote && targetId
                  ? (connectionByTarget.get(targetId) ?? "idle")
                  : null;
                const connectionState: RemoteRuntimeConnectionState | null =
                  connectingKeys.has(key) ? "connecting" : baseState;
                const isOpenLocal =
                  !isRemote && project?.rootPath === rp.rootPath;
                return (
                  <RecentProjectRow
                    key={key}
                    rp={rp}
                    connectionState={connectionState}
                    isOpen={isOpenLocal}
                    isForgetting={pendingForgetKeys.has(key)}
                    onOpen={() => handleOpen(rp)}
                    onTogglePin={() => void handleTogglePin(rp)}
                    onForget={() => handleForget(rp)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div aria-hidden style={{ flex: "2 1 0%" }} />
      )}

      {forgetToast ? (
        <div
          role="status"
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            borderRadius: 12,
            background: "rgba(20,18,28,0.96)",
            border: `1px solid ${COLORS.border}`,
            boxShadow: "0 10px 32px rgba(0,0,0,0.45)",
            color: COLORS.textPrimary,
            fontFamily: MONO_FONT,
            fontSize: 12,
            zIndex: 40,
          }}
        >
          <span>
            Removed{" "}
            <span style={{ fontWeight: 700 }}>{forgetToast.name}</span>
          </span>
          <button
            type="button"
            onClick={handleUndoForget}
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: COLORS.accent,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Undo
          </button>
        </div>
      ) : null}

      <CommandPalette
        open={projectBrowserOpen}
        onOpenChange={setProjectBrowserOpen}
        intent="project-add"
      />
    </div>
  );
}

export function RunPage() {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  useLaneListInvalidation({ active: Boolean(projectRoot), refreshLanes, freshnessKey: lanes });
  const [persistedLaneState, setPersistedLaneState] =
    useState<PersistedRunPageLaneState>(() =>
      readRunPageLaneState(projectRoot),
    );
  const [config, setConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [definitions, setDefinitions] = useState<ProcessDefinition[]>([]);
  const [runtime, setRuntime] = useState<ProcessRuntime[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const newGroupInputRef = useRef<HTMLInputElement>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingProcess, setEditingProcess] = useState<{
    id: string;
    values: AddCommandInitialValues;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [networkDrawerOpen, setNetworkDrawerOpen] = useState(false);
  const [laneRuntimeBarOpen, setLaneRuntimeBarOpen] = useState(
    readLaneRuntimeBarOpenFromStorage,
  );
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);
  const [terminalCreateRequestNonce, setTerminalCreateRequestNonce] =
    useState(0);
  const [terminalRevealRequest, setTerminalRevealRequest] = useState<{
    terminalId: string;
    ptyId: string;
    label: string;
    nonce: number;
  } | null>(null);
  const runtimeRefreshTimerRef = useRef<number | null>(null);
  const pendingRunLaunchRef = useRef<PendingRunLaunch | null>(null);
  const terminalRevealNonceRef = useRef(0);

  const fallbackRunLaneId = useMemo(
    () =>
      lanes.find((lane) => lane.laneType === "primary")?.id ??
      lanes[0]?.id ??
      null,
    [lanes],
  );
  const groups = useMemo<ProcessGroupDefinition[]>(
    () => config?.effective.processGroups ?? [],
    [config?.effective.processGroups],
  );

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );

  const commandLaneMap = useMemo(() => {
    const allowed = new Set(lanes.map((lane) => lane.id));
    const map: Record<string, string> = {};
    for (const definition of definitions) {
      const persistedLaneId = persistedLaneState.commandLaneIds[definition.id];
      const laneId =
        persistedLaneId && allowed.has(persistedLaneId)
          ? persistedLaneId
          : fallbackRunLaneId;
      if (laneId) map[definition.id] = laneId;
    }
    return map;
  }, [
    definitions,
    fallbackRunLaneId,
    lanes,
    persistedLaneState.commandLaneIds,
  ]);

  const refreshLanePersistence = useCallback(
    (
      updater: (
        current: PersistedRunPageLaneState,
      ) => PersistedRunPageLaneState,
    ) => {
      setPersistedLaneState((current) => {
        const next = updater(current);
        if (runPageLaneStateEqual(current, next)) return current;
        writeRunPageLaneState(projectRoot, next);
        return next;
      });
    },
    [projectRoot],
  );

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

  useEffect(() => {
    logRendererDebugEvent("renderer.run.page_mount");
    return () => {
      logRendererDebugEvent("renderer.run.page_unmount");
    };
  }, []);

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
      new Set(
        [...Object.values(commandLaneMap)].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    );
    if (laneIds.length === 0) {
      setRuntime([]);
      return;
    }
    try {
      const snapshots = await Promise.all(
        laneIds.map((laneId) =>
          window.ade.processes
            .listRuntime(laneId)
            .catch(() => [] as ProcessRuntime[]),
        ),
      );
      const next = snapshots.flat();
      setRuntime(next);
    } catch (error) {
      console.error("RunPage.refreshRuntime", error);
    }
  }, [commandLaneMap, showWelcome]);

  useEffect(() => {
    if (showWelcome) return;
    void refreshDefinitions();
  }, [refreshDefinitions, showWelcome]);

  useEffect(() => {
    if (groups.length === 0) {
      if (selectedGroupId !== null) setSelectedGroupId(null);
      return;
    }
    if (
      selectedGroupId &&
      !groups.some((group) => group.id === selectedGroupId)
    ) {
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

  const upsertRuntime = useCallback((nextRuntime: ProcessRuntime) => {
    setRuntime((current) => {
      const next = [...current];
      const index = next.findIndex(
        (runtimeItem) => runtimeItem.runId === nextRuntime.runId,
      );
      if (index >= 0) {
        next[index] = nextRuntime;
      } else {
        next.unshift(nextRuntime);
      }
      return next;
    });
  }, []);

  const revealRuntimeTerminal = useCallback(
    (runtimeItem: ProcessRuntime): boolean => {
      if (!runtimeItem.sessionId || !runtimeItem.ptyId) return false;
      const definition = definitions.find(
        (item) => item.id === runtimeItem.processId,
      );
      const lane = lanes.find((item) => item.id === runtimeItem.laneId);
      terminalRevealNonceRef.current += 1;
      setTerminalDrawerOpen(true);
      setTerminalRevealRequest({
        terminalId: runtimeItem.sessionId,
        ptyId: runtimeItem.ptyId,
        label: definition?.name ?? lane?.name ?? "Run command",
        nonce: terminalRevealNonceRef.current,
      });
      return true;
    },
    [definitions, lanes],
  );

  useEffect(() => {
    const unsubscribe = window.ade.processes.onEvent((event: ProcessEvent) => {
      if (event.type !== "runtime") return;
      upsertRuntime(event.runtime);
      const pending = pendingRunLaunchRef.current;
      if (!pending) return;
      const targetIndex = pending.targets.findIndex(
        (target) =>
          target.laneId === event.runtime.laneId &&
          target.processId === event.runtime.processId,
      );
      if (targetIndex < 0) return;
      if (revealRuntimeTerminal(event.runtime)) {
        pendingRunLaunchRef.current = null;
        return;
      }
      if (!isActiveProcessStatus(event.runtime.status)) {
        const nextTargets = pending.targets.filter(
          (_, index) => index !== targetIndex,
        );
        pendingRunLaunchRef.current =
          nextTargets.length > 0 ? { targets: nextTargets } : null;
      }
    });
    return unsubscribe;
  }, [revealRuntimeTerminal, upsertRuntime]);

  const clearPendingRunLaunchTarget = useCallback(
    (laneId: string, processId: string) => {
      const pending = pendingRunLaunchRef.current;
      if (!pending) return;
      const nextTargets = pending.targets.filter(
        (target) => target.laneId !== laneId || target.processId !== processId,
      );
      pendingRunLaunchRef.current =
        nextTargets.length > 0 ? { targets: nextTargets } : null;
    },
    [],
  );

  const clearPendingRunLaunchTargets = useCallback(
    (targets: PendingRunLaunch["targets"]) => {
      const pending = pendingRunLaunchRef.current;
      if (!pending) return;
      const keys = new Set(
        targets.map((target) => `${target.laneId}\u0000${target.processId}`),
      );
      const nextTargets = pending.targets.filter(
        (target) => !keys.has(`${target.laneId}\u0000${target.processId}`),
      );
      pendingRunLaunchRef.current =
        nextTargets.length > 0 ? { targets: nextTargets } : null;
    },
    [],
  );

  const resolveProcessLaneId = useCallback(
    (processId: string): string | null => {
      return commandLaneMap[processId] ?? fallbackRunLaneId ?? null;
    },
    [commandLaneMap, fallbackRunLaneId],
  );

  const selectProcessLane = useCallback(
    (processId: string, laneId: string) => {
      refreshLanePersistence((current) => ({
        commandLaneIds: {
          ...current.commandLaneIds,
          [processId]: laneId,
        },
      }));
    },
    [refreshLanePersistence],
  );

  const startProcess = useCallback(
    async (
      processId: string,
      laneId: string,
      allowTrustRetry = true,
    ): Promise<ProcessRuntime> => {
      try {
        return await window.ade.processes.start({ laneId, processId });
      } catch (error) {
        if (
          allowTrustRetry &&
          error instanceof Error &&
          error.message.includes("ADE_TRUST_REQUIRED")
        ) {
          await window.ade.projectConfig.confirmTrust();
          return await window.ade.processes.start({ laneId, processId });
        }
        throw error;
      }
    },
    [],
  );

  const handleRun = useCallback(
    async (processId: string) => {
      const laneId = resolveProcessLaneId(processId);
      if (!laneId) return;
      pendingRunLaunchRef.current = { targets: [{ laneId, processId }] };
      try {
        setActionError(null);
        const started = await startProcess(processId, laneId);
        upsertRuntime(started);
        if (revealRuntimeTerminal(started)) {
          pendingRunLaunchRef.current = null;
        }
      } catch (error) {
        clearPendingRunLaunchTarget(laneId, processId);
        setActionError(error instanceof Error ? error.message : String(error));
        console.error("[RunPage] handleRun failed:", error);
      }
    },
    [clearPendingRunLaunchTarget, resolveProcessLaneId, revealRuntimeTerminal, startProcess, upsertRuntime],
  );

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

  const handleOpenRuntimeTerminal = useCallback(
    (runtimeItem: ProcessRuntime) => {
      setActionError(null);
      if (revealRuntimeTerminal(runtimeItem)) return;
      setActionError("This run no longer has a live terminal attached.");
    },
    [revealRuntimeTerminal],
  );

  const buildLaneMapForSelectedGroup = useCallback((): Record<
    string,
    string
  > | null => {
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
    const launchTargets = definitions
      .filter((definition) =>
        (definition.groupIds ?? []).includes(selectedGroupId),
      )
      .map((definition) => {
        const laneId = laneByProcessId[definition.id];
        return laneId ? { laneId, processId: definition.id } : null;
      })
      .filter((target): target is PendingRunLaunch["targets"][number] => target != null);
    if (launchTargets.length === 0) return;
    const args = { groupId: selectedGroupId, laneByProcessId };
    pendingRunLaunchRef.current = { targets: launchTargets };
    try {
      setActionError(null);
      await window.ade.processes.startGroup(args);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("ADE_TRUST_REQUIRED")
      ) {
        try {
          await window.ade.projectConfig.confirmTrust();
          await window.ade.processes.startGroup(args);
          return;
        } catch (retryError) {
          clearPendingRunLaunchTargets(launchTargets);
          setActionError(
            retryError instanceof Error
              ? retryError.message
              : String(retryError),
          );
          return;
        }
      }
      clearPendingRunLaunchTargets(launchTargets);
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [
    buildLaneMapForSelectedGroup,
    clearPendingRunLaunchTargets,
    definitions,
    selectedGroupId,
  ]);

  const handleStopGroupAll = useCallback(async () => {
    if (!selectedGroupId) return;
    const laneByProcessId = buildLaneMapForSelectedGroup();
    if (!laneByProcessId || Object.keys(laneByProcessId).length === 0) return;
    try {
      setActionError(null);
      await window.ade.processes.stopGroup({
        groupId: selectedGroupId,
        laneByProcessId,
      });
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
      const newGroup: ConfigProcessGroupDefinition = {
        id: generateId(),
        name: trimmed,
      };
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

  const handleLaunchShell = useCallback(() => {
    if (!fallbackRunLaneId) return;
    setActionError(null);
    setTerminalCreateRequestNonce((nonce) => nonce + 1);
    setTerminalDrawerOpen(true);
  }, [fallbackRunLaneId]);

  const saveProcessToConfig = useCallback(
    async (cmd: AddCommandSubmitPayload) => {
      if (!config) {
        throw new Error(
          "Run configuration is still loading. Try again in a moment.",
        );
      }
      const processId = generateId();
      const createdGroups: ConfigProcessGroupDefinition[] =
        cmd.newGroupNames.map((name) => ({
          id: generateId(),
          name,
        }));
      const allGroupIds = [
        ...cmd.groupIds,
        ...createdGroups.map((group) => group.id),
      ];
      const { process: newProcess, localOnly } = buildProcessConfigDefinition(
        processId,
        cmd,
        allGroupIds,
        projectRoot,
      );

      const shared = { ...config.shared };
      const local = { ...config.local };
      if (localOnly) {
        local.processes = upsertProcess(local.processes, newProcess);
        local.processGroups = [
          ...(local.processGroups ?? []),
          ...createdGroups,
        ];
      } else {
        shared.processes = upsertProcess(shared.processes, newProcess);
        shared.processGroups = [
          ...(shared.processGroups ?? []),
          ...createdGroups,
        ];
      }

      await window.ade.projectConfig.save({ shared, local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, projectRoot, refreshDefinitions, refreshRuntime],
  );

  const updateProcessInConfig = useCallback(
    async (
      processId: string,
      cmd: AddCommandSubmitPayload & { restart?: ProcessRestartPolicy },
    ) => {
      if (!config) {
        throw new Error(
          "Run configuration is still loading. Try again in a moment.",
        );
      }
      const shared = { ...config.shared };
      const local = { ...config.local };
      const createdGroups: ConfigProcessGroupDefinition[] =
        cmd.newGroupNames.map((name) => ({
          id: generateId(),
          name,
        }));
      const allGroupIds = [
        ...cmd.groupIds,
        ...createdGroups.map((group) => group.id),
      ];
      const existingProcess =
        (config.local.processes ?? []).find(
          (entry) => entry.id === processId,
        ) ??
        (config.shared.processes ?? []).find((entry) => entry.id === processId);
      const cmdForBuild = {
        ...cmd,
        restart: cmd.restart ?? existingProcess?.restart,
      };
      const { process: nextProcess, localOnly } = buildProcessConfigDefinition(
        processId,
        cmdForBuild,
        allGroupIds,
        projectRoot,
      );
      const existingLocal = (config.local.processes ?? []).some(
        (entry) => entry.id === processId,
      );
      const targetLocal = existingLocal || localOnly;

      if (targetLocal) {
        local.processes = upsertProcess(local.processes, nextProcess);
        local.processGroups = [
          ...(local.processGroups ?? []),
          ...createdGroups,
        ];
        if (localOnly) {
          shared.processes = removeProcess(shared.processes, processId);
        }
      } else {
        shared.processes = upsertProcess(shared.processes, nextProcess);
        shared.processGroups = [
          ...(shared.processGroups ?? []),
          ...createdGroups,
        ];
        local.processes = removeProcess(local.processes, processId);
      }

      await window.ade.projectConfig.save({ shared, local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, projectRoot, refreshDefinitions, refreshRuntime],
  );

  const handleAddProcessToGroup = useCallback(
    async (processId: string, groupId: string) => {
      const definition = definitions.find((entry) => entry.id === processId);
      if (!definition || (definition.groupIds ?? []).includes(groupId)) return;
      const nextGroupIds = [
        ...new Set([...(definition.groupIds ?? []), groupId]),
      ];
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
    },
    [definitions, updateProcessInConfig],
  );

  const handleDeleteProcess = useCallback(
    async (processId: string) => {
      if (!config) return;
      const shared = { ...config.shared };
      const local = { ...config.local };
      shared.processes = (shared.processes ?? []).filter(
        (processEntry) => processEntry.id !== processId,
      );
      local.processes = (local.processes ?? []).filter(
        (processEntry) => processEntry.id !== processId,
      );
      await window.ade.projectConfig.save({ shared, local });
      await Promise.all([refreshDefinitions(), refreshRuntime()]);
    },
    [config, refreshDefinitions, refreshRuntime],
  );

  const handleEditProcess = useCallback(
    (processId: string) => {
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
    },
    [definitions],
  );

  const filteredDefinitions = useMemo(() => {
    if (!selectedGroupId) return definitions;
    return definitions.filter((definition) =>
      (definition.groupIds ?? []).includes(selectedGroupId),
    );
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: COLORS.pageBg,
      }}
    >
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
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                fontWeight: 700,
                color: COLORS.textPrimary,
              }}
            >
              {selectedGroup?.name ?? "All commands"}
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
          {laneRuntimeBarOpen ? (
            <CaretUp size={14} weight="bold" />
          ) : (
            <CaretDown size={14} weight="bold" />
          )}
          Advanced
        </button>

        {fallbackRunLaneId ? (
          <ChatTerminalToggle
            open={terminalDrawerOpen}
            onToggle={() => setTerminalDrawerOpen((open) => !open)}
          />
        ) : null}

        <button
          type="button"
          data-tour="run.newShell"
          onClick={handleLaunchShell}
          disabled={!fallbackRunLaneId}
          style={{
            ...outlineButton(),
            opacity: fallbackRunLaneId ? 1 : 0.45,
            cursor: fallbackRunLaneId ? "pointer" : "default",
          }}
        >
          <Terminal size={14} weight="bold" />
          New shell
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

        <button
          type="button"
          data-tour="run.addCommand"
          onClick={() => setAddDialogOpen(true)}
          style={outlineButton()}
        >
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
          <LaneRuntimeBar
            laneId={fallbackRunLaneId}
            onOpenPreviewRouting={() => setNetworkDrawerOpen(true)}
          />
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
            background:
              selectedGroupId === null
                ? COLORS.accentSubtle
                : COLORS.recessedBg,
            border: `1px solid ${selectedGroupId === null ? COLORS.accentBorder : COLORS.outlineBorder}`,
            color:
              selectedGroupId === null
                ? COLORS.textPrimary
                : COLORS.textSecondary,
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
            onClick={() =>
              setSelectedGroupId((current) =>
                current === group.id ? null : group.id,
              )
            }
            style={{
              height: 28,
              padding: "0 10px",
              background:
                selectedGroupId === group.id
                  ? COLORS.accentSubtle
                  : COLORS.recessedBg,
              border: `1px solid ${selectedGroupId === group.id ? COLORS.accentBorder : COLORS.outlineBorder}`,
              color:
                selectedGroupId === group.id
                  ? COLORS.textPrimary
                  : COLORS.textSecondary,
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
            <span style={{ marginLeft: 6, color: COLORS.textDim }}>
              {groupCounts[group.id] ?? 0}
            </span>
          </button>
        ))}
        {creatingGroup ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
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
                ...outlineButton({
                  height: 28,
                  padding: "0 10px",
                  fontSize: 10,
                }),
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
              style={outlineButton({
                height: 28,
                padding: "0 10px",
                fontSize: 10,
              })}
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
              border:
                "1px solid color-mix(in srgb, var(--color-error) 40%, transparent)",
              borderLeft: `3px solid ${COLORS.danger}`,
              background:
                "color-mix(in srgb, var(--color-error) 12%, transparent)",
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
                Add a command or assign groups. Every Run click opens a fresh
                terminal session.
              </div>
              <button
                type="button"
                onClick={() => setAddDialogOpen(true)}
                style={primaryButton()}
              >
                <Plus size={14} weight="bold" />
                Add command
              </button>
            </div>
          ) : (
            <div
              data-tour="run.commandCards"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: 12,
              }}
            >
              {filteredDefinitions.map((definition) => {
                const laneId = resolveProcessLaneId(definition.id);
                const laneRuntimes = runtime.filter(
                  (runtimeItem) =>
                    runtimeItem.processId === definition.id &&
                    runtimeItem.laneId === laneId,
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
                    onOpenRuntime={handleOpenRuntimeTerminal}
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

      {fallbackRunLaneId ? (
        <ChatTerminalDrawer
          open={terminalDrawerOpen}
          onToggle={() => setTerminalDrawerOpen((open) => !open)}
          laneId={fallbackRunLaneId}
          autoCreateOnOpen={false}
          revealRequest={terminalRevealRequest}
          createRequestNonce={terminalCreateRequestNonce}
          disposeTabsOnUnmount
          emptyMessage="Open a shell or run a command to attach a terminal."
          onCreateError={setActionError}
        />
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
