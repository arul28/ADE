import React, { useState, useCallback, useEffect } from "react";
import { useSearchParams, useLocation, useNavigate } from "react-router-dom";
import { Brain, ChartLineUp, GearSix, Stack, Plugs, Palette, DeviceMobile, Robot } from "@phosphor-icons/react";
import { GeneralSection } from "../settings/GeneralSection";
import { AppearanceSection } from "../settings/AppearanceSection";
import { LaneTemplatesSection } from "../settings/LaneTemplatesSection";
import { LaneBehaviorSection } from "../settings/LaneBehaviorSection";
import { ProvidersSection } from "../settings/ProvidersSection";
import { AiFeaturesSection } from "../settings/AiFeaturesSection";
import { IntegrationsSettingsSection } from "../settings/IntegrationsSettingsSection";
import { MobilePushPanel } from "../settings/MobilePushPanel";
import { AdeUsageSection } from "../settings/AdeUsageSection";
import { RemoteSettingsBanner } from "../settings/RemoteContextBadge";
import { COLORS, SANS_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

const SECTIONS = [
  { id: "general", label: "General", icon: GearSix },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "ai", label: "AI Connections", icon: Brain },
  { id: "background-jobs", label: "Background Jobs", icon: Robot },
  { id: "mobile-push", label: "Mobile Push", icon: DeviceMobile },
  { id: "integrations", label: "Integrations", icon: Plugs },
  { id: "lane-templates", label: "Lane Templates", icon: Stack },
  { id: "ade-usage", label: "Stats", icon: ChartLineUp },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const TAB_ALIASES: Record<string, SectionId> = {
  workspace: "general",
  project: "general",
  context: "general",
  providers: "ai",
  automations: "background-jobs",
  sync: "mobile-push",
  devices: "mobile-push",
  "multi-device": "mobile-push",
  github: "integrations",
  linear: "integrations",
  "computer-use": "integrations",
  keybindings: "general",
  onboarding: "general",
  help: "general",
  tours: "general",
  usage: "ade-usage",
  stats: "ade-usage",
  "ade-usage": "ade-usage",
};

const HASH_TARGET_SECTIONS: Partial<Record<string, SectionId>> = {
  "ai-providers": "ai",
  "chat-launch-clipboard": "appearance",
  "voice-input": "general",
};

function padIndex(i: number): string {
  return String(i + 1).padStart(2, "0");
}

/* ──────────────── Main Settings Page ──────────────── */

export function SettingsPage({ active = true }: { active?: boolean } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const canonicalTab = tabParam && SECTIONS.some((s) => s.id === tabParam)
    ? (tabParam as SectionId)
    : tabParam && TAB_ALIASES[tabParam]
      ? TAB_ALIASES[tabParam]
      : null;
  const validTab = canonicalTab;
  const [section, setSection] = useState<SectionId>(validTab ?? "general");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Sync from URL when ?tab= changes
  useEffect(() => {
    if (!active) return;
    if (validTab && validTab !== section) {
      setSection(validTab);
    }
  }, [active, validTab, section]);

  useEffect(() => {
    if (!active) return;
    if (!tabParam || !canonicalTab || tabParam === canonicalTab) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", canonicalTab);
    setSearchParams(nextParams, { replace: true });
  }, [active, canonicalTab, searchParams, setSearchParams, tabParam]);

  const navigateToSection = useCallback((next: SectionId) => {
    setSection(next);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    navigate({ pathname: location.pathname, search: `?${nextParams.toString()}`, hash: "" }, { replace: true });
  }, [location.pathname, navigate, searchParams]);

  useEffect(() => {
    if (!active) return;
    if (!location.hash) return;
    let targetId = location.hash.slice(1);
    try {
      targetId = decodeURIComponent(targetId);
    } catch {
      // A malformed hash should not break the settings page.
    }
    if (!targetId) return;
    if (HASH_TARGET_SECTIONS[targetId] !== section) return;
    const id = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [active, section, location.hash]);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Left sidebar */}
      <nav
        style={{
          width: 200,
          flexShrink: 0,
          background: "var(--shell-sidebar-bg)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderRight: "1px solid var(--shell-sidebar-border)",
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 8,
          paddingRight: 8,
        }}
      >
        <div style={{ ...LABEL_STYLE, fontFamily: SANS_FONT, paddingLeft: 10, marginBottom: 12 }}>
          SETTINGS
        </div>

        {SECTIONS.map((s, i) => {
          const isActive = section === s.id;
          const isHovered = hoveredId === s.id;

          const itemStyle: React.CSSProperties = {
            display: "flex",
            width: "100%",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            border: "none",
            borderLeft: isActive ? "3px solid var(--shell-sidebar-item-active-rail)" : "3px solid transparent",
            background: isActive
              ? "var(--shell-sidebar-item-active-bg)"
              : isHovered
                ? "var(--shell-sidebar-item-hover-bg)"
                : "transparent",
            color: isActive ? "var(--shell-sidebar-item-active-fg)" : isHovered ? "var(--shell-sidebar-item-hover-fg)" : "var(--shell-sidebar-item-fg)",
            fontFamily: SANS_FONT,
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "1px",
            cursor: "pointer",
            borderRadius: 8,
            transition: "background 120ms ease, color 120ms ease",
          };

          return (
            <button
              key={s.id}
              type="button"
              data-tour={`settings.${s.id === "lane-templates" ? "laneTemplates" : s.id === "mobile-push" ? "mobilePush" : s.id === "background-jobs" ? "backgroundJobs" : s.id}`}
              onClick={() => navigateToSection(s.id)}
              onMouseEnter={() => setHoveredId(s.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={itemStyle}
            >
              <s.icon size={14} weight="regular" style={{ flexShrink: 0 }} />
              <span>{padIndex(i)} {s.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Right content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: COLORS.pageBg,
          padding: 24,
        }}
      >
        <RemoteSettingsBanner />
        {section === "general" && <GeneralSection />}
        {section === "appearance" && <AppearanceSection />}
        {section === "ai" && <ProvidersSection />}
        {section === "background-jobs" && <AiFeaturesSection />}
        {section === "ade-usage" && <AdeUsageSection />}
        {section === "mobile-push" && <MobilePushPanel />}
        {section === "integrations" && <IntegrationsSettingsSection />}
        {section === "lane-templates" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <LaneTemplatesSection />
            <LaneBehaviorSection />
          </div>
        )}
      </div>
    </div>
  );
}
