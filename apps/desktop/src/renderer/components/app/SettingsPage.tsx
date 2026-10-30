import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Brain,
  ChartLineUp,
  ChatCircle,
  DeviceMobile,
  Desktop,
  GearSix,
  GitBranch,
  Wrench,
  HardDrives,
  Key,
  MagnifyingGlass,
  MapPin,
  Palette,
  Plugs,
  PlugsConnected,
  Robot,
  ShareNetwork,
  SlidersHorizontal,
  UserCircle,
} from "@phosphor-icons/react";
import { RemoteSettingsBanner } from "../settings/RemoteContextBadge";
import { SettingsMachineScopeProvider } from "../settings/SettingsMachineScope";
import { SettingsSearchAnchorsContext } from "../settings/settingsSearchContext";
import { useSettingsMachinePage } from "../settings/SettingsMachinesNav";
import { SettingsMachinesContext, type SettingsMachinesValue } from "../settings/machines/settingsMachinesContext";
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
  settingsTabLabel,
  type SettingEntry,
  type SettingsTabId,
  DEFAULT_SETTINGS_TAB,
  type SettingsTab,
  SETTINGS_GROUPS,
  groupScopeHint,
  isAccountOnlyTab,
  isMachineSelectableSettingsTab,
  isMachineSettingsTab,
  isProjectSettingsTab,
  isThisComputerOnlyTab,
  legacyTabAnchor,
} from "../settings/settingsManifest";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { COLORS, SANS_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { ProjectSidebarSlot, useHasProjectSidebar } from "./projectSidebar/ProjectSidebarSlot";
import {
  BOUND_MACHINE_ENTRY_IDS,
  STANDALONE_TAB_IDS,
  TabContent,
  decodeSettingsHash,
  integrationIdForAnchor,
  openIntegrationFromUrl,
} from "../settings/settingsTabContent";
import { isIntegrationId } from "../settings/integrations/integrationBrand";

/**
 * The settings shell. Tabs, ordering, deep links, and search all resolve
 * through `settingsManifest.ts` — this file renders, it does not decide.
 *
 * Sections mount per tab; a section that isn't on the active tab isn't
 * rendered. Several of them (Providers, Storage, Usage) open IPC on mount, so
 * rendering every tab at once would make opening settings expensive.
 */

const TAB_ICONS: Record<SettingsTabId, PhosphorIcon> = {
  general: GearSix,
  machines: Desktop,
  advanced: Wrench,
  account: UserCircle,
  chat: ChatCircle,
  notifications: Bell,
  mcp: Plugs,
  stats: ChartLineUp,
  "lanes-git": GitBranch,
  "project-agents": Robot,
  storage: HardDrives,
  location: MapPin,
  secrets: Key,
  integrations: PlugsConnected,
  agents: Brain,
  apple: DeviceMobile,
  appearance: Palette,
  behaviour: SlidersHorizontal,
  "ade-mcp": ShareNetwork,
};

/** Tabs whose content sits in the centred `SettingsColumn`. */
const CENTERED_COLUMN_TABS: ReadonlySet<SettingsTabId> = new Set<SettingsTabId>([
  "general",
  "machines",
  "advanced",
  "appearance",
  "chat",
  "apple",
  "notifications",
  "mcp",
  "stats",
  "secrets",
  "behaviour",
  "ade-mcp",
  "agents",
  "lanes-git",
  "project-agents",
  "storage",
  "location",
  "integrations",
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
  alsoHere,
}: {
  results: SettingEntry[];
  onPick: (entry: SettingEntry) => void;
  /** This page has matches too, so the list is "also" rather than "only". */
  alsoHere: boolean;
}) {
  if (results.length === 0) return null;
  return (
    <div className="ade-settings-xresults">
      <div className="ade-settings-xresults__head">{alsoHere ? "Also on other pages" : "On other pages"}</div>
      {results.slice(0, 8).map((entry) => (
        <button key={entry.id} type="button" className="ade-settings-xresults__row" onClick={() => onPick(entry)}>
          <span className="ade-settings-xresults__label">{entry.label}</span>
          <span className="ade-settings-xresults__tab">{settingsTabLabel(entry.tab)}</span>
          <ArrowRight size={12} className="ade-settings-xresults__arrow" />
        </button>
      ))}
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
  const { machines, thisMachineDeviceName } = useProjectMachines(active && machinesEnabled);
  // With no `?machine=`, a link to a setting about the tab's own machine
  // (GitHub, Linear, link opening) lands on that machine; anything else lands
  // on This computer. For a tab open on this computer the two agree.
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
      // With no project open there is no Project group at all.
      return standalone ? all.filter((tab) => STANDALONE_TAB_IDS.has(tab.id) && tab.group !== "project") : all;
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
  // The machine the open page is about. Providers and Machines follow
  // `?machine=`; This computer's own pages (General, Appearance, Behaviour,
  // Apple devices, Advanced) are always This computer, whatever it says.
  const thisMachine = machines.find((machine) => machine.machineId === THIS_MACHINE_ID) ?? null;
  const pageMachine: ProjectMachine | null = isThisComputerOnlyTab(section)
    ? (thisMachine ?? selectedMachine)
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
    // A legacy tab that was one card's page (`?tab=archive`) lands on that
    // card on its new page, unless the link already names a card.
    const legacyAnchor = location.hash ? null : legacyTabAnchor(tabParam);
    // Navigate rather than setSearchParams: the latter drops the hash, which
    // would throw away the very anchor that selected this tab and leave the
    // scroll effect below with nothing to scroll to.
    navigate(
      { pathname: location.pathname, search: `?${nextParams.toString()}`, hash: legacyAnchor ? `#${legacyAnchor}` : location.hash },
      { replace: true },
    );
  }, [active, location.hash, location.pathname, navigate, resolvedTab, searchParams, tabParam]);

  // `?integration=github|linear|jira|cli` with no tab predates the manifest.
  // GitHub, Linear and Jira are the Integrations tab's own sub-pages now, so
  // their links only gain the tab; the CLI moved to its own setting.
  useEffect(() => {
    if (!active || tabParam) return;
    const integration = searchParams.get("integration")?.trim().toLowerCase() ?? "";
    if (isIntegrationId(integration)) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("tab", "integrations");
      navigate({ pathname: location.pathname, search: `?${nextParams.toString()}`, hash: location.hash }, { replace: true });
      return;
    }
    if (integration !== "cli") return;
    const entry = resolveSettingsHash("ade-cli");
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
  }, [active, location.hash, location.pathname, navigate, searchParams, tabParam]);

  // `machineId`: a machine for Providers or Machines; null clears it (the
  // sidebar opens Providers on This computer and Machines on its list);
  // undefined keeps whatever the URL has.
  const navigateToTab = useCallback((next: SettingsTabId, hash?: string, machineId?: string | null) => {
    setSection(next);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    // One integration's page belongs to the Integrations tab only.
    if (next !== "integrations") nextParams.delete("integration");
    // The machine travels with Machines pages only. Account and Project pages
    // have no machine, and a stale one in the URL would mislead the next link.
    // Appearance describes this computer's own screen, so it never carries one.
    const targetMachine = isMachineSelectableSettingsTab(next)
      ? (machineId === undefined ? nextParams.get("machine") : machineId)
      : null;
    // On Machines, This computer's own page needs its id; elsewhere it is the
    // default and stays out of the URL.
    if (targetMachine && (next === "machines" || targetMachine !== THIS_MACHINE_ID)) nextParams.set("machine", targetMachine);
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
    // Integrations mount one integration's page at a time (or the grid), so a
    // match on another integration's page is a link, like another tab's.
    const openIntegration = section === "integrations" ? openIntegrationFromUrl(searchParams, location.hash) : null;
    const elsewhere = (entry: SettingEntry) =>
      entry.tab !== section
      || (section === "integrations" && integrationIdForAnchor(entry.anchor) !== openIntegration);
    return {
      matchesThisTab: all.filter((entry) => !elsewhere(entry)),
      matchesOtherTabs: all.filter(elsewhere),
    };
  }, [trimmedQuery, section, searchParams, location.hash]);

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
    // A `ModernSection` is both a group and a card: when it matched itself,
    // it stays.
    groups.forEach((group) => {
      const matchedItself = group.hasAttribute("data-settings-anchor") && group.style.display !== "none";
      const hasVisibleCard = matchedItself || [...group.querySelectorAll<HTMLElement>("[data-settings-anchor]")]
        .some((card) => card.style.display !== "none");
      group.style.display = hasVisibleCard ? "" : "none";
    });
    // `location.search` and `location.hash`: a sub-page (one provider or
    // integration, opened by its param or a deeplink) mounts new cards without
    // changing the tab, and they need the filter too.
  }, [trimmedQuery, matchesThisTab, section, location.search, location.hash]);

  const projectDisplayName = useAppStore((state) => state.project?.displayName);
  const hasOpenProject = Boolean(projectDisplayName);
  const repoGroupLabel = projectDisplayName ?? "This repository";
  const hasProjectSidebar = useHasProjectSidebar();

  const renderTabButton = (tab: SettingsTab) => {
    const Icon = TAB_ICONS[tab.id];
    const isActive = section === tab.id;
    const isHovered = hoveredId === tab.id;
    return (
      <button
        key={tab.id}
        type="button"
        data-tour={`settings.${TOUR_IDS[tab.id] ?? tab.id}`}
        aria-current={isActive ? "page" : undefined}
        // A machine-picked page opens on This computer from the sidebar.
        onClick={() => navigateToTab(tab.id, undefined, isMachineSettingsTab(tab.id) ? null : undefined)}
        onMouseEnter={() => setHoveredId(tab.id)}
        onMouseLeave={() => setHoveredId(null)}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 9,
          padding: "6px 10px",
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

  // The machine a page acts on, as the section components see it: the picked
  // machine for Providers and a machine's own page, This computer for its own
  // pages, and the machine that owns the open project (the tab's binding) for
  // a Project page. The rest (Account, Chat…) have none.
  const projectMachine = machines.find((machine) => machine.isActiveBinding) ?? null;
  const scopeMachine = isMachineSettingsTab(section) || isThisComputerOnlyTab(section)
    ? pageMachine
    : isProjectSettingsTab(section) ? projectMachine : null;
  const pageScope = useSettingsMachinePage(scopeMachine);
  // These pages name their machine themselves (the Providers picker, a
  // machine's page, This computer's pages), so the remote banner stands down.
  const namesOwnMachine = isMachineSettingsTab(section) || isThisComputerOnlyTab(section);

  const activeTab = tabs.find((tab) => tab.id === section)
    ?? tabs.find((tab) => tab.id === defaultTab)
    ?? tabs[0];
  // A provider detail (or Harnesses) is a sub-view of the Providers tab. The
  // shell header owns the back affordance so it sits on the title row rather
  // than floating below it.
  // One machine's page on Machines is a sub-view too: Back returns to the list.
  const machineDetailOpen = section === "machines" && Boolean(machineParam);
  const subViewOpen = Boolean(searchParams.get("provider")?.trim())
    || searchParams.get("harnesses") === "1"
    || machineDetailOpen;
  const closeSubView = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("provider");
    next.delete("harnesses");
    if (section === "machines") next.delete("machine");
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: "" }, { replace: true });
  };
  // General and Machines list the machines this page already reads.
  const machinesValue = useMemo<SettingsMachinesValue>(() => ({
    machines,
    thisMachineName: thisMachineDeviceName,
    openMachine: (machineId, tab = "machines") => navigateToTab(tab, undefined, machineId),
    openTab: (tab, anchor) => {
      const resolved = resolveSettingsTab(tab);
      if (resolved) navigateToTab(resolved, anchor);
    },
  }), [machines, thisMachineDeviceName, navigateToTab]);
  const totalMatches = (matchesThisTab?.length ?? 0) + matchesOtherTabs.length;
  const noMatchesHere = trimmedQuery.length > 0 && (matchesThisTab?.length ?? 0) === 0;
  const searchAnchors = useMemo(
    () => (matchesThisTab ? matchesThisTab.map((entry) => entry.anchor) : null),
    [matchesThisTab],
  );

  // Inside a project the section list lives in the project sidebar. Outside
  // one (the hosted web client, tests) the page keeps its own column.
  const sectionList = (
    <>
      {SETTINGS_GROUPS.map((group) => {
        const groupTabs = tabs.filter((tab) => tab.group === group.id);
        // A group with nothing reachable in it is not rendered (the hosted web
        // client drops whole pages whose writes have nowhere to land).
        if (!groupTabs.length) return null;
        // General is one row on its own, above the groups.
        if (group.id === "overview") {
          return (
            <div key={group.id} style={{ marginBottom: 14 }}>
              {groupTabs.map((tab) => renderTabButton(tab))}
            </div>
          );
        }
        const label = group.id === "project"
          ? (hasOpenProject ? `Project: ${repoGroupLabel}` : "Project")
          : group.label ?? THIS_MACHINE_NAME;
        const hint = group.id === "project" && hasOpenProject
          ? `${repoGroupLabel}. ${groupScopeHint(group.id)}`
          : groupScopeHint(group.id);
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
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
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
        {/* Computer pages name their own machine below; the remote banner is
            for You and Project pages, which follow the tab's binding. Account-
            only pages follow no binding, so they get none. */}
        {isWebClientMode() || namesOwnMachine || isAccountOnlyTab(section) ? null : <RemoteSettingsBanner />}
        {webMachineSectionsHidden && tabHasMachineSettings(section) ? <WebNoMachineNotice /> : null}

        {/* Pages built on the centred settings column get a page wrapper of the
            same measure, so the title and search line up with the content. */}
        <div className={CENTERED_COLUMN_TABS.has(section) ? "ade-settings-page--column" : undefined}>
        <header className="ade-settings-page-header" style={{ marginBottom: 20 }}>
          {/* One fixed title row on every page: back, machine breadcrumb,
              title and search share a 32px line, so the title and the search
              box sit at the same height whichever page is open. The page's
              one-line description goes under it. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              minHeight: 32,
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
              <h1
                style={{
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 20,
                  lineHeight: "32px",
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  color: COLORS.textPrimary,
                  whiteSpace: "nowrap",
                }}
              >
                {activeTab.label}
              </h1>
            </div>

            <label className="ade-settings-search">
              <MagnifyingGlass size={14} style={{ color: COLORS.textDim, flexShrink: 0 }} />
              <input
                type="search"
                value={query}
                placeholder="Search all settings"
                aria-label="Search all settings"
                onChange={(event) => setQuery(event.target.value)}
                // Inline so it beats the global input focus ring; the label
                // draws the one ring this field has.
                style={{ border: "none", outline: "none", boxShadow: "none", background: "transparent" }}
              />
              {trimmedQuery ? (
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, whiteSpace: "nowrap" }}>
                  {totalMatches === 1 ? "1 match" : `${totalMatches} matches`}
                </span>
              ) : null}
            </label>
          </div>
          {/* No scope badge. The sidebar already files each page under where
              it saves; the description is the page's one hint. */}
          {activeTab.description ? (
            <p style={{ margin: "2px 0 0", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {activeTab.description}
            </p>
          ) : null}
        </header>

        {trimmedQuery ? (
          <CrossTabResults
            results={matchesOtherTabs}
            alsoHere={(matchesThisTab?.length ?? 0) > 0}
            onPick={(entry) => {
              setQuery("");
              navigateToTab(entry.tab, entry.anchor);
            }}
          />
        ) : null}

        {/* Only say "nothing" when nothing anywhere matches; when other pages
            match, the result list above already answers the search. */}
        {noMatchesHere && matchesOtherTabs.length === 0 ? (
          <div
            style={{
              padding: "12px 16px",
              marginBottom: 16,
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textMuted,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: 10,
            }}
          >
            No setting matches “{trimmedQuery}”.
          </div>
        ) : null}

        <SettingsMachinesContext.Provider value={machinesValue}>
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {pageScope ? (
            // Keyed by machine so nothing one machine loaded can linger into,
            // or be saved onto, the next machine's page.
            <SettingsMachineScopeProvider key={pageScope.machineId} scope={pageScope}>
              <SettingsSearchAnchorsContext.Provider value={searchAnchors}>
                <TabContent tab={section} machine={pageScope} standalone={standalone} />
              </SettingsSearchAnchorsContext.Provider>
            </SettingsMachineScopeProvider>
          ) : (
            <SettingsSearchAnchorsContext.Provider value={searchAnchors}>
              <TabContent tab={section} machine={null} standalone={standalone} />
            </SettingsSearchAnchorsContext.Provider>
          )}
        </div>
        </SettingsMachinesContext.Provider>
        </div>
      </div>
    </div>
  );
}
