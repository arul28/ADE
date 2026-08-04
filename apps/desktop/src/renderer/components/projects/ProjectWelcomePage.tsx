import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChatCircleDots, Plus } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { CommandPalette } from "../app/CommandPalette";
import {
  groupRecentProjects,
  recentProjectLocationKey,
  type RecentProjectGroup,
} from "../app/projectTabGrouping";
import { isWebClientMode } from "../../lib/webClientMode";
import { useOptionalWebWorkspace, useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import { webRecentProjects } from "../../webclient/workspace/webWorkspaceModel";
import { RecentProjectRow, type WebRowChrome } from "./ProjectWelcomeWebRows";
import {
  WebAddProjectNotice,
  WebZeroMachines,
  webZeroMachinesNotice,
} from "./ProjectWelcomeWebNotices";
import { MergeWorktreeProjectDialog } from "./MergeWorktreeProjectDialog";
import type {
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
} from "../../../shared/types";

function recentKey(rp: RecentProjectSummary): string {
  return recentProjectLocationKey(rp);
}
// How long the "Removed — Undo" toast stays before the forget is committed.
const FORGET_UNDO_WINDOW_MS = 5_000;


export function ProjectWelcomePage() {
  const navigate = useNavigate();
  const workspace = useOptionalWebWorkspace();
  const webMode = isWebClientMode() && workspace != null;
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const switchRemoteProject = useAppStore((s) => s.switchRemoteProject);
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>(
    [],
  );
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
  const [webAddProjectNoticeOpen, setWebAddProjectNoticeOpen] = useState(false);
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
    recentKeys: string[];
  } | null>(null);
  const [connectingKeys, setConnectingKeys] = useState<Set<string>>(
    () => new Set(),
  );
  /**
   * The one recents row being opened on the hosted client, by row key.
   *
   * Not a machine key: every row on a machine shares that machine's connection state,
   * so keying the "Reconnecting…" chrome off the machine lit up every card that
   * happened to live on it. Which repo you clicked is the thing the spinner is
   * reporting, and only the row knows that.
   */
  const [openingRowKey, setOpeningRowKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  // Kept apart from rowError: the recents-list error banner only renders when
  // there are rows, and a directory retry fails precisely when there are none.
  const [directoryRetryError, setDirectoryRetryError] = useState<string | null>(
    null,
  );
  const [mergeTarget, setMergeTarget] = useState<RecentProjectSummary | null>(
    null,
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const forgetTimerRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (webMode) return;
    window.ade.project
      .listRecent()
      .then(setRecentProjects)
      .catch(() => {});
  }, [webMode]);

  useEffect(() => {
    if (webMode) return;
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
  }, [applyRemoteSnapshot, webMode]);

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

  // ---------------------------------------------------------------------
  // Hosted client: recents are the union of every machine's project catalog,
  // live where a session exists and cached everywhere else, so the list paints
  // before the first relay dial and fills in as machines come up.
  // ---------------------------------------------------------------------
  const webMachines = useWebMachines();
  const webMachineByKey = useMemo(
    () => new Map(webMachines.map((machine) => [machine.key, machine])),
    [webMachines],
  );
  const webRecents = useMemo(() => webRecentProjects(webMachines), [webMachines]);
  const activeWebMachine = useMemo(() => (
    webMachines.find((machine) => machine.status === "live")
    ?? webMachines.find((machine) => machine.key === workspace?.snapshot.lastActiveMachineKey)
    ?? webMachines.find((machine) => machine.status === "available")
    ?? webMachines[0]
    ?? null
  ), [webMachines, workspace?.snapshot.lastActiveMachineKey]);

  useEffect(() => {
    if (!webMode || !workspace) return;
    // Point the federated adapter back at its machine-less fallback while the
    // welcome surface is up, unless a project tab is still bound behind it.
    if (!workspace.adapter.getActiveBinding()) workspace.adapter.activateHub();
  }, [webMode, workspace]);

  const visibleProjectGroups = useMemo(() => {
    const kept = (webMode ? webRecents : recentProjects).filter((rp) => {
      if (rp.kind === "remote") return true;
      return rp.exists && !rp.rootPath.includes("ade-project");
    });
    return groupRecentProjects({
      recentProjects: kept,
      remoteSnapshot: webMode ? null : remoteSnapshot,
    }).filter((group) => !pendingForgetKeys.has(group.id));
  }, [pendingForgetKeys, recentProjects, remoteSnapshot, webMode, webRecents]);

  const connectedRemoteCount = remoteSnapshot?.connectedCount ?? 0;

  // Selecting anything on the hosted client connects its machine first — a
  // machine the account can reach is never a dead end (bug-ledger C2d).
  const openWebProject = useCallback(
    (machineKey: string, projectId: string, rowKey: string) => {
      if (!workspace) return;
      const machine = webMachineByKey.get(machineKey);
      if (!machine) return;
      setRowError(null);
      setOpeningRowKey(rowKey);
      void (async () => {
        try {
          const targetId = await workspace.connectMachineEntry(machine);
          await workspace.adapter.openProject(targetId, projectId);
          navigate(workspace.consumePendingProjectPath() ?? "/work");
        } catch (error) {
          setRowError(error instanceof Error ? error.message : String(error));
        } finally {
          setOpeningRowKey((current) => (current === rowKey ? null : current));
        }
      })();
    },
    [navigate, webMachineByKey, workspace],
  );

  // Why the hosted client is showing no machines, in the account's own words.
  // Only computed when there is nothing to list — a populated list speaks for
  // itself even when the last directory read failed.
  const webZeroMachines = useMemo(() => (
    webMode && workspace && webMachines.length === 0
      ? webZeroMachinesNotice({
          account: workspace.account,
          directoryLoading: workspace.directoryLoading,
          retryError: directoryRetryError,
          onRetry: () => {
            setDirectoryRetryError(null);
            void workspace.retryDirectory().catch((error) => {
              setDirectoryRetryError(
                error instanceof Error ? error.message : String(error),
              );
            });
          },
          onSignIn: () => {
            setDirectoryRetryError(null);
            workspace.signIn();
          },
        })
      : null
  ), [directoryRetryError, webMachines.length, webMode, workspace]);

  const openWebChats = useCallback(() => {
    if (!workspace || !activeWebMachine) return;
    setRowError(null);
    // No row chrome to drive: this button is not a recents row, and marking its
    // machine busy is what used to spin every card that machine happened to own.
    void (async () => {
      try {
        const targetId = await workspace.connectMachineEntry(activeWebMachine);
        await workspace.adapter.activateChats(targetId);
        navigate("/chats");
      } catch (error) {
        setRowError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [activeWebMachine, navigate, workspace]);

  const handleOpen = useCallback(
    (rp: RecentProjectSummary) => {
      setRowError(null);
      if (webMode && rp.kind === "remote" && rp.remote) {
        openWebProject(rp.remote.targetId, rp.remote.projectId, recentKey(rp));
        return;
      }
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
      openWebProject,
      project?.rootPath,
      switchProjectToPath,
      switchRemoteProject,
      webMode,
    ],
  );

  const handleTogglePin = useCallback(async (group: RecentProjectGroup) => {
    try {
      let next = recentProjects;
      for (const key of group.recentKeys) {
        next = await window.ade.project.setRecentPinned(key, !group.pinned);
      }
      setRecentProjects(next);
    } catch (error) {
      setRowError(error instanceof Error ? error.message : String(error));
    }
  }, [recentProjects]);

  // Deferred-commit forget: hide the row immediately and show an undo toast.
  // Only after the window elapses do we call the backend forget. Undo cancels
  // the timer and unhides the row, with no backend call.
  const commitForget = useCallback((key: string, recentKeys: string[]) => {
    if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    void (async () => {
      let next = recentProjects;
      for (const recentKey of recentKeys) {
        next = await window.ade.project.forgetRecent(recentKey);
      }
      setRecentProjects(next);
    })().catch(() => {});
    setPendingForgetKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setForgetToast(null);
  }, [recentProjects]);

  const handleForget = useCallback(
    (group: RecentProjectGroup) => {
      const key = group.id;
      // Flush any prior pending forget so we never stack timers.
      const previousKey = forgetToast?.key ?? null;
      if (previousKey && previousKey !== key) {
        commitForget(previousKey, forgetToast?.recentKeys ?? []);
      } else if (forgetTimerRef.current != null) {
        window.clearTimeout(forgetTimerRef.current);
        forgetTimerRef.current = null;
      }
      setForgetToast({
        key,
        name: group.displayName,
        recentKeys: group.recentKeys,
      });
      setPendingForgetKeys((prev) => new Set(prev).add(key));
      forgetTimerRef.current = window.setTimeout(() => {
        forgetTimerRef.current = null;
        commitForget(key, group.recentKeys);
      }, FORGET_UNDO_WINDOW_MS);
    },
    [commitForget, forgetToast],
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
      data-ade-web-welcome={webMode ? "true" : undefined}
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
          }
          @keyframes ade-welcome-mark {
            from { opacity: 0; transform: translateY(8px) scale(0.985); }
            to { opacity: 1; transform: none; }
          }
          @keyframes ade-recent-shimmer {
            from { transform: translateX(-60%); }
            to { transform: translateX(160%); }
          }
          /* A cached row says so by shimmering until live data replaces it. */
          [data-ade-stale="true"] { overflow: hidden; border-radius: 12px; }
          [data-ade-stale="true"]::after {
            content: "";
            position: absolute;
            inset: 0;
            width: 45%;
            pointer-events: none;
            background: linear-gradient(
              90deg,
              transparent,
              color-mix(in srgb, var(--color-accent) 9%, transparent),
              transparent
            );
            animation: ade-recent-shimmer 2.4s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            [data-ade-stale="true"]::after { animation: none; opacity: 0.35; }
            [data-ade-welcome-motion] { animation: none !important; }
          }
          @media (pointer: coarse) {
            [data-ade-web-welcome] [role="menuitem"],
            [data-ade-web-welcome] [role="button"] { min-height: 44px; }
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
          Paired with the 2x bottom region below so free space splits 1:2.
          The hosted client skips it: with no window chrome and no onboarding
          tour anchored to the mark, that third of the screen is better spent on
          the machines' project list, which is the only way in on web. */}
      <div
        aria-hidden
        style={webMode ? { flex: "0 0 auto", height: 16 } : { flex: "1 1 0%", minHeight: 32 }}
      />

      {/* Pinned header: logo + add button */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: webMode ? 16 : 32,
          paddingBottom: webMode ? 8 : 16,
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 520 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: webMode ? 4 : 16,
              filter:
                "drop-shadow(0 0 22px color-mix(in srgb, var(--color-accent) 45%, transparent))",
            }}
          >
            <img
              src="./logo.png"
              alt="ADE Logo"
              data-ade-welcome-motion={webMode ? "true" : undefined}
              style={{
                width: webMode ? 300 : 420,
                height: webMode ? 150 : 240,
                objectFit: "contain",
                maxWidth: "72vw",
                ...(webMode
                  ? { animation: "ade-welcome-mark 620ms cubic-bezier(0.16, 1, 0.3, 1) both" }
                  : {}),
              }}
            />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap", marginTop: webMode ? -6 : -16 }}>
        <button
          type="button"
          data-tour="project.welcomeAddButton"
          disabled={webMode && !activeWebMachine}
          title={
            webMode && !activeWebMachine
              ? "Connect a machine first — projects are added on the machine that hosts them."
              : undefined
          }
          onClick={() => {
            if (!webMode) {
              setProjectBrowserOpen(true);
              return;
            }
            setWebAddProjectNoticeOpen(true);
          }}
          style={{
            ...primaryButton({ height: 48, padding: "0 32px", fontSize: 14 }),
            opacity: webMode && !activeWebMachine ? 0.5 : 1,
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
          disabled={webMode && !activeWebMachine}
          onClick={() => (webMode ? openWebChats() : navigate("/chats"))}
          style={{
            ...outlineButton({ height: 48, padding: "0 22px", fontSize: 12 }),
            opacity: webMode && !activeWebMachine ? 0.5 : 1,
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
          {webMode && activeWebMachine ? (
            <span style={{ color: COLORS.textMuted, fontWeight: 500 }}>
              · {activeWebMachine.name}
            </span>
          ) : null}
        </button>
        </div>
        {webMode && webAddProjectNoticeOpen && activeWebMachine ? (
          <WebAddProjectNotice
            machineName={activeWebMachine.name}
            onDismiss={() => setWebAddProjectNoticeOpen(false)}
          />
        ) : null}
        {/* Above the recents list, not inside it: "Chat without a project"
            reports its failures here too, and that button works with zero
            recents — where a banner scoped to the list rendered nothing. */}
        {rowError ? (
          <div
            role="alert"
            style={{
              maxWidth: 440,
              width: "100%",
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
        {webZeroMachines ? <WebZeroMachines notice={webZeroMachines} /> : null}
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
      {visibleProjectGroups.length > 0 ? (
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
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visibleProjectGroups.map((group) => {
                const primary = group.primary;
                const rp = {
                  ...primary.summary,
                  pinned: group.pinned,
                };
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
                const isOpenRemote =
                  isRemote
                  && projectBinding?.kind === "remote"
                  && projectBinding.targetId === rp.remote?.targetId
                  && projectBinding.projectId === rp.remote?.projectId;
                const canMerge = !isRemote && Boolean(rp.worktreeOf) && rp.exists;
                const machine = webMode && targetId ? webMachineByKey.get(targetId) ?? null : null;
                // The connect/open stages belong to the row that was clicked.
                // Every other row on the same machine sees the same machine-level
                // "connecting", so it has to be suppressed there explicitly —
                // otherwise one click spins the whole list.
                const isOpeningRow = openingRowKey === key;
                const web: WebRowChrome | null = machine
                  ? {
                      machineName: machine.name,
                      status: isOpeningRow
                        ? "connecting"
                        : machine.status === "connecting"
                          ? "available"
                          : machine.status,
                      reachability: machine.reachability,
                      connectStage: isOpeningRow
                        ? machine.connectStage ?? "Dialing relay…"
                        : null,
                      stale: machine.stale,
                      alsoOn: group.locations
                        .filter((location) => location !== primary)
                        .flatMap((location) => {
                          const other = location.summary.remote;
                          if (!other) return [];
                          return [{
                            key: `${other.targetId}:${other.projectId}`,
                            machineName: location.machineName,
                            onSelect: () => openWebProject(other.targetId, other.projectId, key),
                          }];
                        }),
                    }
                  : null;
                return (
                  <RecentProjectRow
                    key={group.id}
                    rp={rp}
                    connectionState={connectionState}
                    isOpen={isOpenLocal || isOpenRemote}
                    isForgetting={pendingForgetKeys.has(group.id)}
                    busy={openingRowKey != null && !isOpeningRow}
                    onOpen={() => handleOpen(rp)}
                    onTogglePin={() => void handleTogglePin(group)}
                    onForget={() => handleForget(group)}
                    onMerge={canMerge ? () => setMergeTarget(rp) : undefined}
                    alsoOn={group.locations.filter(
                      (location) => location !== primary,
                    )}
                    web={web}
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
