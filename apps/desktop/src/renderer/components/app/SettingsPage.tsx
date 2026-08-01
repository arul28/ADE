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
import {
  SETTINGS_TABS,
  resolveSettingsHash,
  resolveSettingsTab,
  searchSettingsEntries,
  settingsEntriesForTab,
  settingsTabLabel,
  type SettingEntry,
  type SettingsTabId,
} from "../settings/settingsManifest";
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

function TabContent({ tab }: { tab: SettingsTabId }) {
  switch (tab) {
    case "general":
      return (
        <>
          <ProjectSection />
          <LaunchPromptSection />
          <AutoUpdatesSection />
          <ProductAnalyticsSection />
          <div id="about">
            <AboutSection />
          </div>
        </>
      );
    case "appearance":
      return <AppearanceSection />;
    case "agents":
      return (
        <>
          <ProvidersSection />
          <AiFeaturesSection />
          <DictationSection />
        </>
      );
    case "lanes-git":
      return (
        <>
          <LaneBehaviorSection />
          <LaneTemplatesSection />
          <PrChatTranscriptsSection />
        </>
      );
    case "integrations":
      return (
        <>
          <GitHubIntegrationSection />
          <LinearIntegrationSection />
          <div id="ade-cli">
            <AdeCliSection />
          </div>
        </>
      );
    case "notifications":
      return <NotificationsSection />;
    case "activity":
      return <ActivitySection />;
    case "secrets":
      return <SecretsSection />;
    case "storage":
      return (
        <>
          <StorageSection />
          <SessionLifecycleSection />
        </>
      );
    case "stats":
      return <AdeUsageSection />;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const resolvedTab = resolveSettingsTab(tabParam);

  const [section, setSection] = useState<SettingsTabId>(resolvedTab ?? "general");
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
    setSearchParams(nextParams, { replace: true });
  }, [active, resolvedTab, searchParams, setSearchParams, tabParam]);

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

  const activeTab = SETTINGS_TABS.find((tab) => tab.id === section) ?? SETTINGS_TABS[0];
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

        {SETTINGS_TABS.map((tab) => {
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
        <RemoteSettingsBanner />

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
