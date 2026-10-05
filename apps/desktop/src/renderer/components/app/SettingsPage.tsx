import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  Archive,
  ArrowLeft,
  Bell,
  Brain,
  ChartLineUp,
  ChatCircle,
  DeviceMobile,
  GearSix,
  GitBranch,
  HardDrives,
  Key,
  MagnifyingGlass,
  Palette,
  PlugsConnected,
  UserCircle,
} from "@phosphor-icons/react";
import { RemoteSettingsBanner } from "../settings/RemoteContextBadge";
import { SettingsMachineScopeProvider } from "../settings/SettingsMachineScope";
import {
  SettingsMachineEyebrow,
  SettingsMachineNavRow,
  useSettingsMachinePage,
} from "../settings/SettingsMachinesNav";
import { useProjectMachines, type ProjectMachine } from "../../state/projectMachines";
import { Banner } from "../ui/notice";
import { SettingsSidebarHeader } from "../settings/SettingsSidebarHeader";
import {
  SETTINGS_ENTRIES,
  availableSettingsTabs,
  resolveSettingsHash,
  resolveSettingsTab,
  searchSettingsEntries,
  clearWebMachineBindingResolver,
  setWebMachineBindingResolver,
  setStandaloneSettingsResolver,
  clearStandaloneSettingsResolver,
  settingsEntriesForTab,
  settingsTabLabel,
  type SettingEntry,
  type SettingsTabId,
  DEFAULT_SETTINGS_TAB,
  type SettingsTab,
  SETTINGS_GROUPS,
  groupScopeHint,
  isMachineSettingsTab,
  isThisComputerOnlyTab,
} from "../settings/settingsManifest";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { COLORS, SANS_FONT, LABEL_STYLE, fgTint } from "../lanes/laneDesignTokens";
import { ProjectSidebarSlot, useHasProjectSidebar } from "./projectSidebar/ProjectSidebarSlot";
import {
  BOUND_MACHINE_ENTRY_IDS,
  STANDALONE_TAB_IDS,
  TabContent,
  decodeSettingsHash,
} from "../settings/settingsTabContent";

/**
 * The settings shell. Tabs, ordering, deep links, and search all resolve
 * through `settingsManifest.ts` — this file renders, it does not decide.
 *
 * Sections mount per tab; a section that isn't on the active tab isn't
 * rendered. Several of them (Providers, Storage, Usage) open IPC on mount, so
 * rendering every tab at once would make opening settings expensive.
 */

const TAB_ICONS: Record<SettingsTabId, PhosphorIcon> = {
  account: UserCircle,
  general: GearSix,
  appearance: Palette,
  chat: ChatCircle,
  apple: DeviceMobile,
  agents: Brain,
  "lanes-git": GitBranch,
  integrations: PlugsConnected,
  notifications: Bell,
  secrets: Key,
  storage: HardDrives,
  archive: Archive,
  stats: ChartLineUp,
};

/** Tabs whose content sits in the centred `SettingsColumn`. */
const CENTERED_COLUMN_TABS: ReadonlySet<SettingsTabId> = new Set<SettingsTabId>([
  "appearance",
  "chat",
  "apple",
  "notifications",
  "stats",
  "secrets",
  "general",
  "agents",
  "lanes-git",
  "integrations",
  "storage",
  "archive",
]);


/** Tour targets kept stable across the nine-tab split. */
const TOUR_IDS: Partial<Record<SettingsTabId, string>> = {
  agents: "backgroundJobs",
  "lanes-git": "laneTemplates",
};

/** Whether anything on this tab needs a machine to write to. */
function tabHasMachineSettings(tab: SettingsTabId): boolean {
  return SETTINGS_ENTRIES.some((entry) => entry.tab === tab && entry.web === "machine");
}

/**
 * What sits where the machine-scoped sections would be when the hosted client
 * has no project tab open. Saying nothing would read as "this tab is just
 * short" — the sections are absent for a reason the user can act on.
 */
function WebNoMachineNotice() {
  return (
    <Banner
      layout="inline"
      style={{ marginBottom: 20 }}
      model={{
        id: "settings-web-no-machine",
        tone: "neutral",
        icon: <HardDrives size={13} weight="regular" />,
        title: "Connect to a project to edit machine settings.",
      }}
    />
  );
}

/** Matches for the current query that live on other tabs. */
function CrossTabResults({
  results,
  onPick,
}: {
  results: SettingEntry[];
  onPick: (entry: SettingEntry) => void;
}) {
  if (results.length === 0) return null;
  return (
    <div
      style={{
        padding: 12,
        marginBottom: 16,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 10,
      }}
    >
      <div style={{ ...LABEL_STYLE, fontFamily: SANS_FONT, marginBottom: 8 }}>ALSO IN OTHER TABS</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {results.slice(0, 8).map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onPick(entry)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              fontFamily: SANS_FONT,
              fontSize: 11,
              background: fgTint(4),
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: 999,
              cursor: "pointer",
            }}
          >
            <span style={{ color: COLORS.textPrimary }}>{entry.label}</span>
            <span style={{ color: COLORS.textDim }}>{settingsTabLabel(entry.tab)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One-shot highlight for the card a search or deep link just landed on.
 *
 * Static, so it lives at module scope rather than being rebuilt per render.
 */
const FLASH_STYLES = (
  <style>{`
    @keyframes ade-settings-flash {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 55%, transparent); }
      100% { box-shadow: 0 0 0 10px transparent; }
    }
    .ade-settings-flash {
      animation: ade-settings-flash 1.2s ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .ade-settings-flash {
        animation: none;
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
      }
    }
  `}</style>
);


export function SettingsPage({
  active = true,
  standalone = false,
  onClose,
}: { active?: boolean; standalone?: boolean; onClose?: () => void } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  // Read-only: every write to the settings URL goes through `navigate` so the
  // hash survives alongside the search params.
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  // Machines pages exist once per machine; `?machine=<id>` picks which. Absent
  // means This computer. The hosted web client has no "This computer", so it
  // keeps the single bound-machine view it always had.
  const machineParam = searchParams.get("machine");
  const machinesEnabled = !isWebClientMode();
  const { machines } = useProjectMachines(active && machinesEnabled);
  // With no `?machine=`, a link to a setting that only works on the tab's own
  // machine (GitHub, Linear, link opening) lands on that machine; anything else
  // lands on This computer. For a tab open on this computer the two agree.
  const linkedEntryId = location.hash ? resolveSettingsHash(decodeSettingsHash(location.hash))?.id ?? null : null;
  const defaultMachineId = linkedEntryId && BOUND_MACHINE_ENTRY_IDS.has(linkedEntryId)
    ? (machines.find((machine) => machine.isActiveBinding)?.machineId ?? THIS_MACHINE_ID)
    : THIS_MACHINE_ID;
  const selectedMachine: ProjectMachine | null = machinesEnabled
    ? (machines.find((machine) => machine.machineId === (machineParam ?? defaultMachineId)) ?? machines[0] ?? null)
    : null;
  // Machine-scoped settings write to the machine the active project tab is
  // bound to, so on web they exist only while one is open. The manifest is what
  // nav, search and the palette all consult, and it has no store of its own —
  // it reads this binding through the resolver, refreshed here because this is
  // the surface that re-renders when the binding changes.
  const machineBound = useAppStore((state) => state.projectBinding) != null;
  // Installed during render because `isSettingAvailable` is consulted mid-render
  // (nav, search, the palette) and an effect would install it a render too late.
  // The effect exists only to take it back down on unmount, and only if it is
  // still ours — the module global outlives this component otherwise.
  const machineBoundRef = useRef(false);
  machineBoundRef.current = machineBound;
  // One stable function identity for this component's whole life, so the
  // unmount cleanup can tell its own resolver from the other surface's.
  const resolverRef = useRef<() => boolean>();
  if (!resolverRef.current) resolverRef.current = () => machineBoundRef.current;
  setWebMachineBindingResolver(resolverRef.current);
  useEffect(() => {
    const installed = resolverRef.current!;
    return () => clearWebMachineBindingResolver(installed);
  }, []);
  const webMachineSectionsHidden = isWebClientMode() && !machineBound;
  // Standalone Settings, opened from the new-project screen. Installed during
  // render like the web resolver, because the manifest answers
  // `isSettingAvailable` mid-render. Only the standalone page installs one, and
  // its unmount clears only its own: the project page's unmount can land in
  // the same commit as the standalone page's first render.
  const standaloneResolverRef = useRef<() => boolean>(() => true);
  if (standalone) setStandaloneSettingsResolver(standaloneResolverRef.current);
  useEffect(() => {
    if (!standalone) return undefined;
    const installed = standaloneResolverRef.current;
    return () => clearStandaloneSettingsResolver(installed);
  }, [standalone]);
  // Tabs the web client cannot serve still resolve — a deeplink or palette
  // entry naming one should land somewhere real rather than on an empty page,
  // so it falls through to the first tab this renderer does serve.
  const tabs = useMemo(
    () => {
      const all = availableSettingsTabs();
      return standalone ? all.filter((tab) => STANDALONE_TAB_IDS.has(tab.id)) : all;
    },
    // `machineBound` is read by the manifest's web resolver, not here: the
    // list has to be recomputed when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [machineBound, standalone],
  );
  // Explicit, so reordering the sidebar cannot move where Settings opens.
  const defaultTab = tabs.some((tab) => tab.id === DEFAULT_SETTINGS_TAB)
    ? DEFAULT_SETTINGS_TAB
    : tabs[0]?.id ?? DEFAULT_SETTINGS_TAB;
  // A `#hash` names one specific setting, so it is strictly more precise than
  // the `?tab=` next to it. When the two disagree — an older link that still
  // says `?tab=general#github-connection` after GitHub moved to Integrations —
  // follow the hash, which is the tab that actually contains the card we were
  // asked to show. Without this the URL lands on the named tab and the scroll
  // effect below silently no-ops, which is exactly how the GitHub App banner
  // used to dump people on General.
  const hashEntryTab = useMemo(() => {
    if (!location.hash) return null;
    return resolveSettingsHash(decodeSettingsHash(location.hash))?.tab ?? null;
  }, [location.hash]);
  const requestedTab = hashEntryTab ?? resolveSettingsTab(tabParam);
  const resolvedTab = requestedTab && tabs.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : requestedTab
      ? defaultTab
      : null;

  const [section, setSection] = useState<SettingsTabId>(resolvedTab ?? defaultTab);
  // The machine the open page is about. A page that describes this computer's
  // own screen (Appearance) is always This computer, whatever `?machine=` says.
  const pageMachine: ProjectMachine | null = isThisComputerOnlyTab(section)
    ? (machines.find((machine) => machine.machineId === THIS_MACHINE_ID) ?? selectedMachine)
    : selectedMachine;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Follow ?tab= when it changes underneath us (deeplinks, palette, tours).
  useEffect(() => {
    if (!active) return;
    if (resolvedTab && resolvedTab !== section) setSection(resolvedTab);
  }, [active, resolvedTab, section]);

  // Rewrite a legacy ?tab= to its canonical id, so the URL a user copies out
  // of the address bar is the one we would have generated.
  useEffect(() => {
    if (!active) return;
    if (!tabParam || !resolvedTab || tabParam === resolvedTab) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", resolvedTab);
    // Navigate rather than setSearchParams: the latter drops the hash, which
    // would throw away the very anchor that selected this tab and leave the
    // scroll effect below with nothing to scroll to.
    navigate(
      { pathname: location.pathname, search: `?${nextParams.toString()}`, hash: location.hash },
      { replace: true },
    );
  }, [active, location.hash, location.pathname, navigate, resolvedTab, searchParams, tabParam]);

  // `?integration=github|linear|cli` predates the manifest.
  useEffect(() => {
    if (!active) return;
    const integration = searchParams.get("integration")?.trim().toLowerCase() ?? "";
    if (!integration) return;
    if (!["github", "linear", "cli"].includes(integration)) return;
    const entry = resolveSettingsHash(integration === "cli" ? "ade-cli" : integration);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", entry?.tab ?? "integrations");
    nextParams.delete("integration");
    navigate(
      {
        pathname: location.pathname,
        search: `?${nextParams.toString()}`,
        hash: entry ? `#${entry.anchor}` : "",
      },
      { replace: true },
    );
  }, [active, location.pathname, navigate, searchParams]);

  const navigateToTab = useCallback((next: SettingsTabId, hash?: string, machineId?: string) => {
    setSection(next);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    // The machine travels with Machines pages only. Account and Project pages
    // have no machine, and a stale one in the URL would mislead the next link.
    // Appearance describes this computer's own screen, so it never carries one.
    const targetMachine = isMachineSettingsTab(next) && !isThisComputerOnlyTab(next)
      ? (machineId ?? nextParams.get("machine"))
      : null;
    if (targetMachine && targetMachine !== THIS_MACHINE_ID) nextParams.set("machine", targetMachine);
    else nextParams.delete("machine");
    navigate(
      { pathname: location.pathname, search: `?${nextParams.toString()}`, hash: hash ? `#${hash}` : "" },
      { replace: true },
    );
  }, [location.pathname, navigate, searchParams]);

  // Scroll a hash target into view once its tab is mounted. Resolving through
  // the manifest means a hash whose anchor has since moved still lands.
  useEffect(() => {
    if (!active || !location.hash) return;
    const entry = resolveSettingsHash(decodeSettingsHash(location.hash));
    if (!entry || entry.tab !== section) return;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(entry.anchor);
      if (!card) return;
      card.scrollIntoView({ block: "start", behavior: "smooth" });
      // Scrolling to a card is not the same as pointing at it. On a page of
      // near-identical rows the user still has to find which one the search
      // meant, and on a short page nothing scrolls at all, so the result looks
      // like it did nothing. One flash answers both.
      card.classList.add("ade-settings-flash");
      flashTimer = setTimeout(() => card.classList.remove("ade-settings-flash"), 1_200);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [active, section, location.hash]);

  // A new tab should open at the top, not wherever the last one was scrolled.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const trimmedQuery = deferredQuery.trim();
  const { matchesThisTab, matchesOtherTabs } = useMemo(() => {
    if (!trimmedQuery) {
      return { matchesThisTab: null as SettingEntry[] | null, matchesOtherTabs: [] as SettingEntry[] };
    }
    const all = searchSettingsEntries(trimmedQuery);
    return {
      matchesThisTab: all.filter((entry) => entry.tab === section),
      matchesOtherTabs: all.filter((entry) => entry.tab !== section),
    };
  }, [trimmedQuery, section]);

  // Searching hides non-matching cards on this tab. Sections own their own
  // markup, so the filter runs over the `data-settings-anchor` ids the
  // manifest guarantees each card carries.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const cards = root.querySelectorAll<HTMLElement>("[data-settings-anchor]");
    const groups = root.querySelectorAll<HTMLElement>("[data-settings-group]");
    if (!trimmedQuery) {
      cards.forEach((card) => { card.style.display = ""; });
      groups.forEach((group) => { group.style.display = ""; });
      return;
    }
    const visible = new Set((matchesThisTab ?? []).map((entry) => entry.anchor));
    cards.forEach((card) => {
      card.style.display = visible.has(card.dataset.settingsAnchor ?? "") ? "" : "none";
    });
    // Some settings are intentionally nested inside a larger card (for
    // example, update preferences inside the ADE status card). Keep that
    // parent mounted when a child is the search result; otherwise the child
    // would be marked visible inside an ancestor that remains display:none.
    cards.forEach((card) => {
      if (card.style.display !== "none") return;
      const hasVisibleChild = [...card.querySelectorAll<HTMLElement>("[data-settings-anchor]")]
        .some((child) => child !== card && visible.has(child.dataset.settingsAnchor ?? ""));
      if (hasVisibleChild) card.style.display = "";
    });
    // A group whose cards all filtered out would otherwise leave a heading
    // hanging over nothing.
    groups.forEach((group) => {
      const hasVisibleCard = [...group.querySelectorAll<HTMLElement>("[data-settings-anchor]")]
        .some((card) => card.style.display !== "none");
      group.style.display = hasVisibleCard ? "" : "none";
    });
  }, [trimmedQuery, matchesThisTab, section]);

  const projectDisplayName = useAppStore((state) => state.project?.displayName);
  const hasOpenProject = Boolean(projectDisplayName);
  const repoGroupLabel = projectDisplayName ?? "This repository";
  const hasProjectSidebar = useHasProjectSidebar();

  const renderTabButton = (tab: SettingsTab, machine?: ProjectMachine) => {
    const Icon = TAB_ICONS[tab.id];
    const isActive = section === tab.id && (!machine || pageMachine?.machineId === machine.machineId);
    const hoverKey = machine ? `${machine.machineId}:${tab.id}` : tab.id;
    const isHovered = hoveredId === hoverKey;
    // Tour anchors stay on This computer's copy of each page.
    const tourId = !machine || machine.isThisMachine ? `settings.${TOUR_IDS[tab.id] ?? tab.id}` : undefined;
    return (
      <button
        key={hoverKey}
        type="button"
        data-tour={tourId}
        onClick={() => navigateToTab(tab.id, undefined, machine?.machineId)}
        onMouseEnter={() => setHoveredId(hoverKey)}
        onMouseLeave={() => setHoveredId(null)}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 9,
          padding: machine ? "5px 10px 5px 30px" : "6px 10px",
          border: "none",
          background: isActive
            ? "var(--shell-sidebar-item-active-bg)"
            : isHovered
              ? "var(--shell-sidebar-item-hover-bg)"
              : "transparent",
          color: isActive
            ? "var(--shell-sidebar-item-active-fg)"
            : isHovered
              ? "var(--shell-sidebar-item-hover-fg)"
              : "var(--shell-sidebar-item-fg)",
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          fontWeight: isActive ? 600 : 500,
          letterSpacing: "-0.01em",
          cursor: "pointer",
          borderRadius: 7,
          textAlign: "left",
          transition: "background 120ms ease, color 120ms ease",
        }}
      >
        <Icon size={14} weight="regular" style={{ flexShrink: 0 }} />
        <span>{tab.label}</span>
      </button>
    );
  };

  const sidebarHeader = (
    <SettingsSidebarHeader onOpenAccount={() => navigateToTab("account")} />
  );

  // The machine a Machines page is about, as the section components see it.
  const machinePageScope = useSettingsMachinePage(
    pageMachine && isMachineSettingsTab(section) ? pageMachine : null,
  );

  const activeTab = tabs.find((tab) => tab.id === section)
    ?? tabs.find((tab) => tab.id === defaultTab)
    ?? tabs[0];
  // A provider detail (or Harnesses) is a sub-view of the Providers tab. The
  // shell header owns the back affordance so it sits on the title row rather
  // than floating below it.
  const subViewOpen = Boolean(searchParams.get("provider")?.trim()) || searchParams.get("harnesses") === "1";
  const closeSubView = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("provider");
    next.delete("harnesses");
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: "" }, { replace: true });
  };
  const tabEntryCount = settingsEntriesForTab(section).length;
  const noMatchesHere = trimmedQuery.length > 0 && (matchesThisTab?.length ?? 0) === 0;

  // Inside a project the section list lives in the project sidebar. Outside
  // one (the hosted web client, tests) the page keeps its own column.
  const renderMachineRow = (machine: ProjectMachine, machineTabs: SettingsTab[]) => {
    const onMachinePage = isMachineSettingsTab(section);
    const selected = pageMachine?.machineId === machine.machineId;
    // A row opens the page you are on when that machine has it, else its first.
    const landingTab = onMachinePage && machineTabs.some((tab) => tab.id === section)
      ? section
      : (machineTabs[0]?.id ?? DEFAULT_SETTINGS_TAB);
    return (
      <SettingsMachineNavRow
        key={machine.machineId}
        machine={machine}
        selected={selected}
        active={selected && onMachinePage}
        onOpen={() => navigateToTab(landingTab, undefined, machine.machineId)}
      >
        {machineTabs.map((tab) => renderTabButton(tab, machine))}
      </SettingsMachineNavRow>
    );
  };

  const sectionList = (
    <>
      {SETTINGS_GROUPS.map((group) => {
        const groupTabs = tabs.filter((tab) => tab.group === group.id);
        // A group with nothing reachable in it is not rendered (the hosted web
        // client drops whole pages whose writes have nowhere to land).
        if (!groupTabs.length) return null;
        const label = group.label ?? THIS_MACHINE_NAME;
        const hint = group.id === "project" && hasOpenProject
          ? `${repoGroupLabel}. ${groupScopeHint(group.id)}`
          : groupScopeHint(group.id);
        if (group.id === "machines" && machinesEnabled && machines.length > 0) {
          return (
            <div key={group.id} style={{ marginBottom: 14 }}>
              <div
                style={{
                  ...LABEL_STYLE,
                  fontFamily: SANS_FONT,
                  paddingLeft: 10,
                  marginBottom: 6,
                  color: "var(--shell-sidebar-item-fg)",
                  opacity: 0.75,
                }}
                title={groupScopeHint(group.id)}
              >
                {group.label}
              </div>
              {machines.map((machine) => renderMachineRow(
                machine,
                // Appearance has one page, under This computer.
                machine.machineId === THIS_MACHINE_ID
                  ? groupTabs
                  : groupTabs.filter((tab) => !isThisComputerOnlyTab(tab.id)),
              ))}
            </div>
          );
        }
        return (
          <div key={group.id} style={{ marginBottom: 14 }}>
            <div
              style={{
                ...LABEL_STYLE,
                fontFamily: SANS_FONT,
                paddingLeft: 10,
                marginBottom: 6,
                // The group name is the scope, so it carries the weight the
                // per-row chips used to; muting it would hide the one thing
                // this reorganisation exists to say.
                color: "var(--shell-sidebar-item-fg)",
                opacity: 0.75,
              }}
              title={hint}
            >
              {label}
            </div>
            {groupTabs.map((tab) => renderTabButton(tab))}
          </div>
        );
      })}
    </>
  );

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {hasProjectSidebar ? (
        <ProjectSidebarSlot active={active}>
          {sidebarHeader}
          <nav
            aria-label="Settings sections"
            style={{ flex: 1, minHeight: 0, padding: "4px 8px 12px", overflowY: "auto" }}
          >
            {sectionList}
          </nav>
        </ProjectSidebarSlot>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 220,
            flexShrink: 0,
            background: "var(--shell-sidebar-bg)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderRight: "1px solid var(--shell-sidebar-border)",
          }}
        >
          {sidebarHeader}
          <nav aria-label="Settings sections" style={{ flex: 1, minHeight: 0, padding: "4px 8px 12px", overflowY: "auto" }}>
            {sectionList}
          </nav>
        </div>
      )}

      <div ref={contentRef} style={{ flex: 1, overflow: "auto", background: COLORS.pageBg, padding: 24 }}>
        {/* The remote banner contrasts a remote machine against this desktop.
            A browser has no "this one", and every section already states its
            own scope, so web gets the per-section lines instead. */}
        {FLASH_STYLES}
        {/* Machines pages name their own machine below; the remote banner is
            for Account and Project pages, which follow the tab's binding. */}
        {isWebClientMode() || machinePageScope ? null : <RemoteSettingsBanner />}
        {webMachineSectionsHidden && tabHasMachineSettings(section) ? <WebNoMachineNotice /> : null}

        {/* Pages built on the centred settings column get a page wrapper of the
            same measure, so the title and search line up with the content. */}
        <div className={CENTERED_COLUMN_TABS.has(section) ? "ade-settings-page--column" : undefined}>
        <header className="ade-settings-page-header" style={{ marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
              {/* Standalone Settings has no project to return to but the
                  new-project screen, so it carries its own Back. */}
              {standalone && onClose ? (
                <button
                  type="button"
                  aria-label="Back to new project"
                  onClick={onClose}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", background: "transparent", color: COLORS.textMuted, cursor: "pointer", flexShrink: 0, marginLeft: -6 }}
                >
                  <ArrowLeft size={18} weight="bold" />
                </button>
              ) : null}
              {subViewOpen ? (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={closeSubView}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", background: "transparent", color: COLORS.textMuted, cursor: "pointer", flexShrink: 0, marginLeft: -6 }}
                >
                  <ArrowLeft size={18} weight="bold" />
                </button>
              ) : null}
              <div style={{ minWidth: 0 }}>
                {machinePageScope ? <SettingsMachineEyebrow page={machinePageScope} /> : null}
              <h1
                style={{
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 20,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  color: COLORS.textPrimary,
                }}
              >
                {activeTab.label}
              </h1>
              {/* No scope badge and no caption. The sidebar already files each
                  page under where it saves, and a one-line restatement of the
                  page's own title is the kind of copy that reads as
                  scaffolding. The search box sits on this same row. */}
              {activeTab.description ? (
                <p style={{ margin: "4px 0 0", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                  {activeTab.description}
                </p>
              ) : null}
              </div>
            </div>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                height: 32,
                padding: "0 10px",
                minWidth: 240,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                borderRadius: 8,
              }}
            >
              <MagnifyingGlass size={14} style={{ color: COLORS.textDim, flexShrink: 0 }} />
              <input
                type="search"
                value={query}
                placeholder="Search all settings"
                aria-label="Search all settings"
                onChange={(event) => setQuery(event.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                  color: COLORS.textPrimary,
                }}
              />
              {trimmedQuery ? (
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, whiteSpace: "nowrap" }}>
                  {matchesThisTab?.length ?? 0}/{tabEntryCount}
                </span>
              ) : null}
            </label>
          </div>
        </header>

        {trimmedQuery ? (
          <CrossTabResults
            results={matchesOtherTabs}
            onPick={(entry) => {
              setQuery("");
              navigateToTab(entry.tab, entry.anchor);
            }}
          />
        ) : null}

        {noMatchesHere ? (
          <div
            style={{
              padding: 16,
              marginBottom: 16,
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textMuted,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: 10,
            }}
          >
            Nothing in {activeTab.label} matches “{trimmedQuery}”.
            {matchesOtherTabs.length > 0 ? " Try one of the results above." : ""}
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {machinePageScope ? (
            // Keyed by machine so nothing one machine loaded can linger into,
            // or be saved onto, the next machine's page.
            <SettingsMachineScopeProvider key={machinePageScope.machineId} scope={machinePageScope}>
              <TabContent tab={section} machine={machinePageScope} standalone={standalone} />
            </SettingsMachineScopeProvider>
          ) : (
            <TabContent tab={section} machine={null} />
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
