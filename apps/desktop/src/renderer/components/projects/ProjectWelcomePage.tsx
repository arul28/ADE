import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowsClockwise,
  ChatCircleDots,
  DesktopTower,
  Folder,
  GitMerge,
  Plus,
  PushPin,
  X,
} from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { CommandPalette } from "../app/CommandPalette";
import { MergeWorktreeProjectDialog } from "./MergeWorktreeProjectDialog";
import { WorktreeBadge } from "./WorktreeBadge";
import { deriveIconAccentColor } from "../../lib/iconAccent";
import { abbreviateHome } from "../../lib/pathUtils";
import { toRelativeTime } from "../graph/graphHelpers";
import type {
  ProjectIcon,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
} from "../../../shared/types";

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
  onMerge,
}: {
  rp: RecentProjectSummary;
  connectionState: RemoteRuntimeConnectionState | null;
  isOpen: boolean;
  isForgetting: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onForget: () => void;
  onMerge?: () => void;
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
  const showMergeAction = Boolean(onMerge && rp.worktreeOf && showRowActions);

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
          paddingRight: showMergeAction ? 90 : showRowActions ? 64 : 16,
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
            {!isRemote && rp.worktreeOf ? (
              <WorktreeBadge worktreeOf={rp.worktreeOf} />
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
          {onMerge && rp.worktreeOf ? (
            <button
              type="button"
              aria-label={`Merge into ${rp.worktreeOf.displayName} as a lane…`}
              title={`Merge into ${rp.worktreeOf.displayName} as a lane…`}
              onClick={(e) => {
                e.stopPropagation();
                onMerge();
              }}
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
                e.currentTarget.style.background =
                  "color-mix(in srgb, var(--color-accent) 22%, transparent)";
                e.currentTarget.style.color = COLORS.accent;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                e.currentTarget.style.color = COLORS.textDim;
              }}
            >
              <GitMerge size={12} weight="bold" />
            </button>
          ) : null}
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

export function ProjectWelcomePage() {
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
  const applyRemoteSnapshot = useCallback(
    (snapshot: RemoteRuntimeConnectionSnapshot) => {
      setRemoteSnapshot((current) =>
        current && current.updatedAt > snapshot.updatedAt ? current : snapshot,
      );
    },
    [],
  );
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
  const [mergeTarget, setMergeTarget] = useState<RecentProjectSummary | null>(
    null,
  );
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
        if (!cancelled) applyRemoteSnapshot(snapshot);
      })
      .catch(() => {});
    const unsubscribe =
      remoteRuntime.onConnectionSnapshotChanged?.((snapshot) => {
        if (!cancelled) applyRemoteSnapshot(snapshot);
      }) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyRemoteSnapshot]);

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
                const canMerge = !isRemote && Boolean(rp.worktreeOf) && rp.exists;
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
                    onMerge={canMerge ? () => setMergeTarget(rp) : undefined}
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

      {mergeTarget ? (
        <MergeWorktreeProjectDialog
          recent={mergeTarget}
          recentKey={recentKey(mergeTarget)}
          onClose={() => setMergeTarget(null)}
          onRecentsUpdated={(next) => {
            setRecentProjects(next);
            setMergeTarget(null);
          }}
        />
      ) : null}

      <CommandPalette
        open={projectBrowserOpen}
        onOpenChange={setProjectBrowserOpen}
        intent="project-add"
      />
    </div>
  );
}
