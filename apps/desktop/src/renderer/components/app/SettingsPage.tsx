import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  Bell,
  Brain,
  ChartLineUp,
  GearSix,
  GitBranch,
  HardDrives,
  Key,
  MagnifyingGlass,
  Palette,
  PlugsConnected,
  Pulse as PulseIcon,
} from "@phosphor-icons/react";
import { ActivitySection } from "../settings/ActivitySection";
import { AppearanceSection } from "../settings/AppearanceSection";
import { AboutSection } from "../settings/AboutSection";
import { AdeCliSection } from "../settings/AdeCliSection";
import { AiFeaturesSection } from "../settings/AiFeaturesSection";
import { AdeUsageSection } from "../settings/AdeUsageSection";
import { AutoUpdatesSection } from "../settings/AutoUpdatesSection";
import { DictationSection } from "../settings/DictationSection";
import { GitHubIntegrationSection } from "../settings/GitHubIntegrationSection";
import { LaneBehaviorSection } from "../settings/LaneBehaviorSection";
import { LaneTemplatesSection } from "../settings/LaneTemplatesSection";
import { LaunchPromptSection } from "../settings/LaunchPromptSection";
import { LinearIntegrationSection } from "../settings/LinearIntegrationSection";
import { NotificationsSection } from "../settings/NotificationsSection";
import { PrChatTranscriptsSection } from "../settings/PrChatTranscriptsSection";
import { ProductAnalyticsSection } from "../settings/ProductAnalyticsSection";
import { ProjectSection } from "../settings/ProjectSection";
import { ProvidersSection } from "../settings/ProvidersSection";
import { SecretsSection } from "../settings/SecretsSection";
import { SessionLifecycleSection } from "../settings/SessionLifecycleSection";
import { StorageSection } from "../settings/StorageSection";
import { RemoteSettingsBanner } from "../settings/RemoteContextBadge";
import { WebSettingsSection } from "../settings/WebScopeBanner";
import {
  SETTINGS_ENTRIES,
  availableSettingsTabs,
  resolveSettingsHash,
  resolveSettingsTab,
  searchSettingsEntries,
  clearWebMachineBindingResolver,
  setWebMachineBindingResolver,
  settingsEntriesForTab,
  settingsTabLabel,
  type SettingEntry,
  type SettingsTabId,
} from "../settings/settingsManifest";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

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
  appearance: Palette,
  agents: Brain,
  "lanes-git": GitBranch,
  integrations: PlugsConnected,
  notifications: Bell,
  activity: PulseIcon,
  secrets: Key,
  storage: HardDrives,
  stats: ChartLineUp,
};

/** Tour targets kept stable across the nine-tab split. */
const TOUR_IDS: Partial<Record<SettingsTabId, string>> = {
  agents: "backgroundJobs",
  "lanes-git": "laneTemplates",
};

/**
 * Every setting on a tab, unreachable ones included. `WebSettingsSection` needs
 * the full list to tell "this section has nowhere to write" apart from "this
 * section was handed no ids".
 */
function settingsEntryIdsForTab(tab: SettingsTabId): string[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab).map((entry) => entry.id);
}

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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        marginBottom: 20,
        borderRadius: 8,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textSecondary,
      }}
    >
      <HardDrives size={16} weight="regular" style={{ flexShrink: 0, color: COLORS.textDim }} />
      <span>Connect to a project to edit machine settings.</span>
    </div>
  );
}

/**
 * Sections, each declaring which manifest settings it holds. On the desktop
 * `WebSettingsSection` is a passthrough and this renders exactly as it always
 * has; in the browser it drops the sections the manifest marks unreachable and
 * heads the rest with their scope.
 */
function TabContent({ tab }: { tab: SettingsTabId }) {
  switch (tab) {
    case "general":
      return (
        <>
          <WebSettingsSection entryIds={["general.project"]}>
            <ProjectSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["general.ade-cli"]}>
            <div id="ade-cli">
              <AdeCliSection />
            </div>
          </WebSettingsSection>
          <WebSettingsSection entryIds={["general.launch-prompt"]}>
            <LaunchPromptSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["general.auto-updates"]}>
            <AutoUpdatesSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["general.analytics"]}>
            <ProductAnalyticsSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["general.about"]}>
            <div id="about">
              <AboutSection />
            </div>
          </WebSettingsSection>
        </>
      );
    case "appearance":
      return (
        <WebSettingsSection entryIds={settingsEntryIdsForTab("appearance")}>
          <AppearanceSection />
        </WebSettingsSection>
      );
    case "agents":
      return (
        <>
          <WebSettingsSection entryIds={["agents.providers"]}>
            <ProvidersSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["agents.background-jobs", "agents.scheduled-work", "agents.budget"]}>
            <AiFeaturesSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["agents.dictation"]}>
            <DictationSection />
          </WebSettingsSection>
        </>
      );
    case "lanes-git":
      return (
        <>
          <WebSettingsSection
            entryIds={[
              "lanes-git.new-lane-base",
              "lanes-git.auto-rebase",
              "lanes-git.rebase-suggestions",
              "lanes-git.rebase-min-behind",
            ]}
          >
            <LaneBehaviorSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["lanes-git.lane-templates"]}>
            <LaneTemplatesSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["lanes-git.pr-chat-transcripts"]}>
            <PrChatTranscriptsSection />
          </WebSettingsSection>
        </>
      );
    case "integrations":
      return (
        <>
          <WebSettingsSection entryIds={["integrations.github"]}>
            <GitHubIntegrationSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["integrations.linear"]}>
            <LinearIntegrationSection />
          </WebSettingsSection>
        </>
      );
    case "notifications":
      return (
        <WebSettingsSection entryIds={settingsEntryIdsForTab("notifications")}>
          <NotificationsSection />
        </WebSettingsSection>
      );
    case "activity":
      return (
        <WebSettingsSection entryIds={settingsEntryIdsForTab("activity")}>
          <ActivitySection />
        </WebSettingsSection>
      );
    case "secrets":
      return (
        <WebSettingsSection entryIds={["secrets.secrets"]}>
          <SecretsSection />
        </WebSettingsSection>
      );
    case "storage":
      return (
        <>
          <WebSettingsSection entryIds={["storage.usage", "storage.lane-rules", "storage.diagnostics"]}>
            <StorageSection />
          </WebSettingsSection>
          <WebSettingsSection entryIds={["storage.session-lifecycle"]}>
            <SessionLifecycleSection />
          </WebSettingsSection>
        </>
      );
    case "stats":
      return (
        <WebSettingsSection entryIds={["stats.usage"]}>
          <AdeUsageSection />
        </WebSettingsSection>
      );
    default:
      return null;
  }
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
              background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
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

export function SettingsPage({ active = true }: { active?: boolean } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  // Read-only: every write to the settings URL goes through `navigate` so the
  // hash survives alongside the search params.
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
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
  // Tabs the web client cannot serve still resolve — a deeplink or palette
  // entry naming one should land somewhere real rather than on an empty page,
  // so it falls through to the first tab this renderer does serve.
  const tabs = useMemo(() => availableSettingsTabs(), [machineBound]);
  const defaultTab = tabs[0]?.id ?? "general";
  // A `#hash` names one specific setting, so it is strictly more precise than
  // the `?tab=` next to it. When the two disagree — an older link that still
  // says `?tab=general#github-connection` after GitHub moved to Integrations —
  // follow the hash, which is the tab that actually contains the card we were
  // asked to show. Without this the URL lands on the named tab and the scroll
  // effect below silently no-ops, which is exactly how the GitHub App banner
  // used to dump people on General.
  const hashEntryTab = useMemo(() => {
    if (!location.hash) return null;
    let raw = location.hash.slice(1);
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // A malformed hash should never break tab resolution.
    }
    return resolveSettingsHash(raw)?.tab ?? null;
  }, [location.hash]);
  const requestedTab = hashEntryTab ?? resolveSettingsTab(tabParam);
  const resolvedTab = requestedTab && tabs.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : requestedTab
      ? defaultTab
      : null;

  const [section, setSection] = useState<SettingsTabId>(resolvedTab ?? defaultTab);
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

  const navigateToTab = useCallback((next: SettingsTabId, hash?: string) => {
    setSection(next);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    navigate(
      { pathname: location.pathname, search: `?${nextParams.toString()}`, hash: hash ? `#${hash}` : "" },
      { replace: true },
    );
  }, [location.pathname, navigate, searchParams]);

  // Scroll a hash target into view once its tab is mounted. Resolving through
  // the manifest means a hash whose anchor has since moved still lands.
  useEffect(() => {
    if (!active || !location.hash) return;
    let raw = location.hash.slice(1);
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // A malformed hash should never break the settings page.
    }
    const entry = resolveSettingsHash(raw);
    if (!entry || entry.tab !== section) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(entry.anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
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
    // A group whose cards all filtered out would otherwise leave a heading
    // hanging over nothing.
    groups.forEach((group) => {
      const hasVisibleCard = [...group.querySelectorAll<HTMLElement>("[data-settings-anchor]")]
        .some((card) => card.style.display !== "none");
      group.style.display = hasVisibleCard ? "" : "none";
    });
  }, [trimmedQuery, matchesThisTab, section]);

  const activeTab = tabs.find((tab) => tab.id === section) ?? tabs[0];
  const tabEntryCount = settingsEntriesForTab(section).length;
  const noMatchesHere = trimmedQuery.length > 0 && (matchesThisTab?.length ?? 0) === 0;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <nav
        style={{
          width: 200,
          flexShrink: 0,
          background: "var(--shell-sidebar-bg)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderRight: "1px solid var(--shell-sidebar-border)",
          padding: "16px 8px",
          overflowY: "auto",
        }}
      >
        <div style={{ ...LABEL_STYLE, fontFamily: SANS_FONT, paddingLeft: 10, marginBottom: 12 }}>
          SETTINGS
        </div>

        {tabs.map((tab) => {
          const Icon = TAB_ICONS[tab.id];
          const isActive = section === tab.id;
          const isHovered = hoveredId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              data-tour={`settings.${TOUR_IDS[tab.id] ?? tab.id}`}
              onClick={() => navigateToTab(tab.id)}
              onMouseEnter={() => setHoveredId(tab.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
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
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "1px",
                cursor: "pointer",
                borderRadius: 8,
                textAlign: "left",
                transition: "background 120ms ease, color 120ms ease",
              }}
            >
              <Icon size={14} weight="regular" style={{ flexShrink: 0 }} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <div ref={contentRef} style={{ flex: 1, overflow: "auto", background: COLORS.pageBg, padding: 24 }}>
        {/* The remote banner contrasts a remote machine against this desktop.
            A browser has no "this one", and every section already states its
            own scope, so web gets the per-section lines instead. */}
        {isWebClientMode() ? null : <RemoteSettingsBanner />}
        {webMachineSectionsHidden && tabHasMachineSettings(section) ? <WebNoMachineNotice /> : null}

        <header style={{ marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
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
              <p style={{ margin: "4px 0 0", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                {activeTab.description}
              </p>
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
          <TabContent tab={section} />
        </div>
      </div>
    </div>
  );
}
