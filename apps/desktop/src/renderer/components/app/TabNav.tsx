import React, { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  GitBranch,
  FileCode,
  Terminal,
  Graph,
  GitPullRequest,
  MagnifyingGlass,
  ClockCounterClockwise,
  Robot,
  Brain,
  ChatCircleDots,
  GearSix,
} from "@phosphor-icons/react";
import { UserCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { useAppStore } from "../../state/appStore";
import { revealLabel } from "../../lib/platform";
import { isWebClientMode, WEB_CLIENT_TAB_PATHS } from "../../lib/webClientMode";
import {
  accountAvatarImage,
  accountInitials,
  accountSessionState,
  accountSessionShortLabel,
  providerTint,
  useAccountStatus,
} from "../../lib/account";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { docs } from "../../onboarding/docsLinks";
import { SmartTooltip, type SmartTooltipContent } from "../ui/SmartTooltip";
import type { GitHubStatus } from "../../../shared/types";
import { readStoredPrsRoute } from "../prs/prsRouteState";
import { readStoredProjectSettingsRoute } from "./projectRouteStorage";

type TabNavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
  description: string;
  docUrl?: string;
  requiresProject?: boolean;
  idleEffect?: string;
  activeEffect?: string;
};

const mainItems: TabNavItem[] = [
  {
    to: "/work",
    label: "Work",
    icon: Terminal,
    description: "Chat with agents, launch CLI sessions, inspect shells, and use the right-side tool drawers.",
    docUrl: docs.chatOverview,
  },
  {
    to: "/lanes",
    label: "Lanes",
    icon: GitBranch,
    description: "Create, inspect, stack, rebase, and clean up isolated worktrees for parallel work.",
    docUrl: docs.lanesOverview,
  },
  {
    to: "/files",
    label: "Files",
    icon: FileCode,
    description: "Browse lane workspaces, inspect file changes, and open project files without leaving ADE.",
    docUrl: docs.filesEditor,
  },
  {
    to: "/prs",
    label: "PRs",
    icon: GitPullRequest,
    description: "Review ADE and GitHub pull requests, queues, integration proposals, checks, and merge readiness.",
    docUrl: docs.prsOverview,
  },
  {
    to: "/review",
    label: "Review",
    icon: MagnifyingGlass,
    description: "Run and inspect AI review passes for the current project and PR workflow.",
    docUrl: docs.prsOverview,
  },
  {
    to: "/cto",
    label: "CTO",
    icon: Brain,
    description: "Chat with the persistent project CTO and manage its identity and settings.",
    docUrl: docs.ctoOverview,
  },
  {
    to: "/graph",
    label: "Graph",
    icon: Graph,
    description: "See lane topology, conflict risk, PR overlays, sync presence, and integration proposals on one canvas.",
    docUrl: docs.workspaceGraph,
  },
  {
    to: "/history",
    label: "History",
    icon: ClockCounterClockwise,
    description: "Explore commit history, lane operations, branch links, and recent project movement.",
    docUrl: docs.historyOverview,
  },
  {
    to: "/automations",
    label: "Automations",
    icon: Robot,
    description: "Manage automation rules that trigger ADE work from events, schedules, and guarded actions.",
    docUrl: docs.automationsOverview,
  },
];

const settingsItem: TabNavItem = {
  to: "/settings",
  label: "Settings",
  icon: GearSix,
  description: "Configure AI providers, GitHub, Linear, voice, lane behavior, templates, keybindings, and local project settings.",
  docUrl: docs.settingsGeneral,
};

const chatsItem: TabNavItem = {
  to: "/chats",
  label: "Chats",
  icon: ChatCircleDots,
  description: "Chat with ADE agents without opening or linking a project.",
  requiresProject: false,
  idleEffect: "Opens projectless chats.",
  activeEffect: "Already viewing chats.",
};
const SIDEBAR_ICON_SIZE = 20;
const SIDEBAR_AVATAR_SIZE_CLASS = "h-5 w-5";

function tabNavTooltipEffect(args: {
  hasActiveProject: boolean;
  showWelcome: boolean;
  isActive: boolean;
  label: string;
}): string {
  if (!args.hasActiveProject) return "Open or create a project first.";
  if (args.showWelcome) return "Finish choosing a project before navigating.";
  if (args.isActive) return "Already viewing this tab.";
  return `Opens ${args.label}.`;
}

function tabItemEffect(
  it: TabNavItem,
  args: {
    hasActiveProject: boolean;
    showWelcome: boolean;
    isActive: boolean;
    label: string;
  },
): string {
  if (it.activeEffect && it.idleEffect) {
    return args.isActive ? it.activeEffect : it.idleEffect;
  }
  return tabNavTooltipEffect(args);
}

function tabNavTarget(to: string, prsRoute: string | null, settingsRoute: string | null): string {
  if (to === "/prs") return prsRoute ?? to;
  if (to === "/settings") return settingsRoute ?? to;
  return to;
}

function primaryTabPath(pathname: string): string {
  if (pathname === "/chats" || pathname.startsWith("/chats/")) return "/chats";
  const match = mainItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  if (match) return match.to;
  return pathname === settingsItem.to || pathname.startsWith(`${settingsItem.to}/`) ? settingsItem.to : pathname;
}

export function TabNav({ githubStatus }: { githubStatus?: GitHubStatus | null }) {
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const ctoAttention = useAppStore((s) => s.ctoAttention);
  const ctoWaitingLabel = ctoAttention.since
    ? `The CTO is waiting on you — since ${new Date(ctoAttention.since).toLocaleTimeString()}`
    : "The CTO is waiting on you";
  const location = useLocation();
  const { status: accountStatus } = useAccountStatus();
  const activeProjectRoot =
    projectBinding?.kind === "remote" ? projectBinding.rootPath : (project?.rootPath ?? null);
  const activeProjectBindingKey = projectBinding?.key ?? (activeProjectRoot ? `local:${activeProjectRoot}` : null);
  // Read this on each render because the sidebar stays mounted while the
  // settings tab changes and the route memory is updated by the app shell.
  const storedSettingsRoute = activeProjectBindingKey
    ? readStoredProjectSettingsRoute(activeProjectBindingKey)
      ?? (activeProjectRoot && activeProjectRoot !== activeProjectBindingKey
        ? readStoredProjectSettingsRoute(activeProjectRoot)
        : null)
    : null;
  const hasActiveProject = Boolean(activeProjectRoot);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const { ref: sidebarMenuRef, position: sidebarMenuPosition } = useClampedFixedPosition(contextMenu);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const githubLogin = githubStatus?.userLogin || null;
  const githubConnected = Boolean(githubStatus?.connected);
  const avatarImage = accountAvatarImage(accountStatus, githubLogin);
  const accountRingTint = providerTint(accountStatus, githubConnected);
  // "Signed out" is only true for a real sign-out. An expired or unreadable
  // session says something different, and the sidebar should not flatten them.
  const accountSession = accountSessionState(accountStatus);
  // A signed-in account always resolves to the "active" state, so the label for
  // the current state is the right fallback in both branches — no literal.
  const accountIdentityLabel = accountStatus.signedIn
    ? accountStatus.name?.trim() || accountStatus.email?.trim() || githubLogin
    : null;
  const accountLabel = accountIdentityLabel || accountSessionShortLabel(accountSession);
  const accountRouteActive =
    location.pathname === "/account" || location.pathname.startsWith("/account/");
  const accountReturnTo = accountRouteActive
    ? "/work"
    : `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    setAvatarBroken(false);
  }, [githubLogin, avatarImage]);

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

  const renderItem = (it: TabNavItem) => {
    const onWelcomeLanding = showWelcome || !hasActiveProject;
    const requiresProject = it.requiresProject !== false;
    const isActive = requiresProject
      ? !onWelcomeLanding && primaryTabPath(location.pathname) === it.to
      : primaryTabPath(location.pathname) === it.to;
    const isActiveAllowed = !requiresProject || (!showWelcome && hasActiveProject);
    const navTarget = tabNavTarget(it.to, readStoredPrsRoute(activeProjectRoot), storedSettingsRoute);
    const tooltip: SmartTooltipContent = {
      label: it.label,
      description: it.description,
      effect: tabItemEffect(it, {
        hasActiveProject,
        showWelcome,
        isActive,
        label: it.label,
      }),
      docUrl: it.docUrl,
    };

    const icon = (
      <span className="ade-shell-sidebar-icon-slot flex items-center justify-center shrink-0">
        <span className="relative inline-flex items-center">
          <it.icon
            size={SIDEBAR_ICON_SIZE}
            weight="regular"
            className="ade-shell-sidebar-icon shrink-0 transition-colors duration-150"
          />
          {isActiveAllowed && it.to === "/work" && terminalAttention.indicator !== "none" ? (
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
          {isActiveAllowed && it.to === "/cto" && ctoAttention.awaitingInput ? (
            <span
              title={ctoWaitingLabel}
              className="absolute -right-1 -top-1 ade-status-dot ade-status-dot-warning"
            />
          ) : null}
        </span>
      </span>
    );

    const row = isActiveAllowed ? (
      <NavLink
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
        className="ade-shell-sidebar-item group relative flex w-full items-center transition-colors duration-100"
      >
        {isActive ? <div className="absolute inset-0 bg-white/[0.08]" /> : null}
        {icon}
        <span className="ade-tab-label whitespace-nowrap">{it.label}</span>
      </NavLink>
    ) : (
      <div
        role="link"
        aria-disabled="true"
        tabIndex={0}
        className="ade-shell-sidebar-item group relative flex w-full cursor-not-allowed items-center transition-colors duration-100 opacity-40"
      >
        {icon}
        <span className="ade-tab-label whitespace-nowrap">{it.label}</span>
      </div>
    );

    return (
      <SmartTooltip
        key={it.to}
        side="right"
        content={tooltip}
        wrapperClassName="w-full"
        wrapperStyle={{ display: "flex" }}
      >
        {row}
      </SmartTooltip>
    );
  };

  // The hosted web client surfaces the tabs listed in `WEB_CLIENT_TAB_PATHS` —
  // one authoritative list rather than an index into `mainItems`. Review and
  // Automations stay hidden there: neither has host-side actions, so both would
  // be dead nav entries.
  const webMode = isWebClientMode();
  const toolItems = webMode
    ? mainItems.slice(4).filter((it) => WEB_CLIENT_TAB_PATHS.has(it.to))
    : mainItems.slice(4);
  const showSettings = !webMode || WEB_CLIENT_TAB_PATHS.has(settingsItem.to);

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

        {toolItems.length > 0 ? (
          <>
            {/* Group separator */}
            <div className="ade-shell-sidebar-separator mx-3 my-1 border-t" />

            {/* Tool navigation items */}
            <div className="flex flex-col gap-px">
              {toolItems.map((it) => renderItem(it))}
            </div>
          </>
        ) : null}

        {/* Spacer pushes settings to bottom */}
        <div className="mt-auto" />

        {renderItem(chatsItem)}

        {/* Account avatar — provider-aware image → monogram, routes to /account.
            Always present so account access stays discoverable from the sidebar. */}
        <NavLink
          to="/account"
          state={{ returnTo: accountReturnTo }}
          data-active={accountRouteActive ? "true" : undefined}
          className="ade-shell-sidebar-item group relative flex w-full cursor-pointer items-center transition-colors duration-100"
          aria-label={
            accountStatus.signedIn
              ? `ADE account — ${accountLabel}`
              : `ADE account — ${accountLabel.toLowerCase()}`
          }
          title={accountLabel}
        >
          {accountRouteActive ? <div className="absolute inset-0 bg-white/[0.08]" /> : null}
          <span className="ade-shell-sidebar-icon-slot flex items-center justify-center shrink-0">
            {avatarImage && !avatarBroken ? (
              <img
                src={avatarImage}
                alt=""
                onError={() => setAvatarBroken(true)}
                className={cn(SIDEBAR_AVATAR_SIZE_CLASS, "rounded-full object-cover")}
                draggable={false}
                style={{ boxShadow: `0 0 0 1.5px color-mix(in srgb, ${accountRingTint} 55%, transparent)` }}
              />
            ) : accountStatus.signedIn ? (
              <span
                className={cn(
                  SIDEBAR_AVATAR_SIZE_CLASS,
                  "inline-flex items-center justify-center rounded-full text-[9px] font-semibold uppercase tracking-tight text-fg/90",
                )}
                style={{
                  background: `color-mix(in srgb, ${accountRingTint} 22%, transparent)`,
                  boxShadow: `0 0 0 1.5px color-mix(in srgb, ${accountRingTint} 55%, transparent)`,
                }}
                aria-hidden
              >
                {accountInitials(accountStatus)}
              </span>
            ) : (
              <UserCircle
                size={SIDEBAR_ICON_SIZE}
                weight="regular"
                className="ade-shell-sidebar-icon shrink-0"
              />
            )}
          </span>
          <span className="ade-tab-label whitespace-nowrap">{accountLabel}</span>
        </NavLink>

        {showSettings ? (
          <>
            {/* Divider line before settings */}
            <div className="ade-shell-sidebar-separator mx-2 mb-1 border-t" />

            {/* Settings pinned to bottom */}
            {renderItem(settingsItem)}
          </>
        ) : null}
      </nav>

      {/* Context menu */}
      {/* Revealing a path is a native-shell action: the web adapter's
          `app.revealPath` resolves to nothing, so the browser gets no menu. */}
      {contextMenu && activeProjectRoot && !webMode ? (
        <div
          ref={sidebarMenuRef}
          className="ade-shell-sidebar-menu fixed z-40 min-w-[170px] p-1 shadow-float"
          style={{
            left: sidebarMenuPosition?.left ?? contextMenu.x,
            top: sidebarMenuPosition?.top ?? contextMenu.y,
            visibility: sidebarMenuPosition ? "visible" : "hidden",
          }}
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
