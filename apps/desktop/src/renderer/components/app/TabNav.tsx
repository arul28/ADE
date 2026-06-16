import React, { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  PlayCircle,
  GitBranch,
  FileCode,
  Terminal,
  Graph,
  GitPullRequest,
  MagnifyingGlass,
  ClockCounterClockwise,
  Robot,
  Brain,
  GearSix,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import { revealLabel } from "../../lib/platform";
import { openExternalUrl } from "../../lib/openExternal";
import { logRendererDebugEvent } from "../../lib/debugLog";
import type { GitHubStatus } from "../../../shared/types";
import { readStoredPrsRoute } from "../prs/prsRouteState";

const mainItems = [
  { to: "/work", label: "Work", icon: Terminal },
  { to: "/lanes", label: "Lanes", icon: GitBranch },
  { to: "/files", label: "Files", icon: FileCode },
  { to: "/prs", label: "PRs", icon: GitPullRequest },
  { to: "/project", label: "Run", icon: PlayCircle },
  { to: "/review", label: "Review", icon: MagnifyingGlass },
  { to: "/cto", label: "CTO", icon: Brain },
  { to: "/graph", label: "Graph", icon: Graph },
  { to: "/history", label: "History", icon: ClockCounterClockwise },
  { to: "/automations", label: "Automations", icon: Robot },
] as const;

const settingsItem = { to: "/settings", label: "Settings", icon: GearSix } as const;
const SIDEBAR_ICON_SIZE = 20;
const SIDEBAR_AVATAR_SIZE_CLASS = "h-5 w-5";

function primaryTabPath(pathname: string): string {
  const match = mainItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  if (match) return match.to;
  return pathname === settingsItem.to || pathname.startsWith(`${settingsItem.to}/`) ? settingsItem.to : pathname;
}

function githubProfileUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

export function TabNav({ githubStatus }: { githubStatus?: GitHubStatus | null }) {
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const location = useLocation();
  const activeProjectRoot =
    projectBinding?.kind === "remote" ? projectBinding.rootPath : (project?.rootPath ?? null);
  const hasActiveProject = Boolean(activeProjectRoot);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const [isPackaged, setIsPackaged] = useState(false);
  const githubLogin = githubStatus?.userLogin || null;

  useEffect(() => {
    let cancelled = false;
    window.ade.app.getInfo().then(
      (info) => {
        if (!cancelled) setIsPackaged(Boolean(info.isPackaged));
      },
      () => {
        if (!cancelled) setIsPackaged(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setAvatarBroken(false);
  }, [githubLogin]);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = () => setContextMenu(null);
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [contextMenu]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const renderItem = (
    it: { to: string; label: string; icon: React.ElementType },
  ) => {
    const onWelcomeLanding = showWelcome || !hasActiveProject;
    const isActive = !onWelcomeLanding && primaryTabPath(location.pathname) === it.to;
    const isActiveAllowed = !showWelcome && hasActiveProject;
    const navTarget = it.to === "/prs" ? readStoredPrsRoute(activeProjectRoot) ?? it.to : it.to;

    if (!isActiveAllowed) {
      return (
        <div
          key={it.to}
          className={cn(
            "ade-shell-sidebar-item group relative flex w-full cursor-not-allowed items-center transition-colors duration-100 opacity-40",
          )}
        >
          <span className="ade-shell-sidebar-icon-slot flex items-center justify-center shrink-0">
            <span className="relative inline-flex items-center">
              <it.icon
                size={SIDEBAR_ICON_SIZE}
                weight="regular"
                className={cn("ade-shell-sidebar-icon shrink-0 transition-colors duration-150")}
              />
            </span>
          </span>
          <span className="ade-tab-label whitespace-nowrap">{it.label}</span>
        </div>
      );
    }

    return (
      <NavLink
        key={it.to}
        to={navTarget}
        data-active={isActive ? "true" : undefined}
        onClick={() => {
          logRendererDebugEvent("renderer.tab_nav.click", {
            projectRoot: activeProjectRoot,
            from: location.pathname,
            to: navTarget,
            showWelcome,
            hasActiveProject,
          });
        }}
        className={cn(
          "ade-shell-sidebar-item group relative flex w-full items-center transition-colors duration-100",
        )}
      >
        {/* Active indicator bar */}
        {isActive && (
          <div
            className="absolute inset-0 bg-white/[0.08]"
          />
        )}

        {/* Fixed-width icon container - never moves during collapse */}
        <span className="ade-shell-sidebar-icon-slot flex items-center justify-center shrink-0">
          <span className="relative inline-flex items-center">
            <it.icon
              size={SIDEBAR_ICON_SIZE}
              weight="regular"
              className={cn(
                "ade-shell-sidebar-icon shrink-0 transition-colors duration-150",
              )}
            />
            {/* Terminal attention dot */}
            {it.to === "/work" && terminalAttention.indicator !== "none" ? (
              <span
                title={
                  terminalAttention.indicator === "running-needs-attention"
                    ? `${terminalAttention.needsAttentionCount} terminal${terminalAttention.needsAttentionCount === 1 ? " needs" : "s need"} input`
                    : "All active terminals running"
                }
                className={cn(
                  "absolute -right-1 -top-1 ade-status-dot",
                  terminalAttention.indicator === "running-needs-attention"
                    ? "ade-status-dot-warning"
                    : "ade-status-dot-active",
                )}
              />
            ) : null}
            {it.to === "/automations" && isPackaged ? (
              <span
                title={`${it.label} is coming soon in production builds`}
                className="absolute -right-2 -top-1 rounded border border-emerald-300/40 bg-emerald-400 px-1 font-mono text-[7px] font-bold uppercase leading-[10px] text-[#07110B]"
              >
                Soon
              </span>
            ) : null}
          </span>
        </span>

        {/* Label - opacity-animated separately from width transition */}
        <span
          className={cn(
            "ade-tab-label whitespace-nowrap",
          )}
        >
          {it.label}
        </span>
      </NavLink>
    );
  };

  return (
    <>
      <nav
        className="flex flex-col gap-px w-full h-full"
        onContextMenu={handleContextMenu}
      >
        {/* Core navigation items */}
        <div className="flex flex-col gap-px">
          {mainItems.slice(0, 4).map((it) => renderItem(it))}
        </div>

        {/* Group separator */}
        <div className="ade-shell-sidebar-separator mx-3 my-1 border-t" />

        {/* Tool navigation items */}
        <div className="flex flex-col gap-px">
          {mainItems.slice(4).map((it) => renderItem(it))}
        </div>

        {/* Spacer pushes settings to bottom */}
        <div className="mt-auto" />

        {/* GitHub profile avatar — only shows when token is stored, a login is known, and the image loads */}
        {githubLogin && !avatarBroken ? (
          <button
            type="button"
            className="ade-shell-sidebar-item group relative flex w-full cursor-pointer items-center border-none text-left transition-colors duration-100"
            onClick={() => openExternalUrl(githubProfileUrl(githubLogin))}
            aria-label={`Open GitHub profile for ${githubLogin}`}
            title={`@${githubLogin} on GitHub`}
          >
            <span className="ade-shell-sidebar-icon-slot flex items-center justify-center shrink-0">
              <img
                src={`https://github.com/${encodeURIComponent(githubLogin)}.png?size=64`}
                alt=""
                onError={() => setAvatarBroken(true)}
                className={cn(SIDEBAR_AVATAR_SIZE_CLASS, "rounded-full object-cover")}
                draggable={false}
              />
            </span>
            <span className="ade-tab-label whitespace-nowrap">{githubLogin}</span>
          </button>
        ) : null}

        {/* Divider line before settings */}
        <div className="ade-shell-sidebar-separator mx-2 mb-1 border-t" />

        {/* Settings pinned to bottom */}
        {renderItem(settingsItem)}
      </nav>

      {/* Context menu */}
      {contextMenu && activeProjectRoot ? (
        <div
          className="ade-shell-sidebar-menu fixed z-40 min-w-[170px] p-1 shadow-float"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="ade-shell-sidebar-menu-item block w-full rounded-md px-2 py-1 text-left"
            onClick={() => {
              setContextMenu(null);
              window.ade.app.revealPath(activeProjectRoot).catch(() => {});
            }}
          >
            {revealLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}
