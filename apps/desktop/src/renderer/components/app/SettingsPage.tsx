import React, { useState } from "react";
import { GearSix, GitBranch, BookOpenText, Robot, Terminal, Keyboard, Lightning, Plugs, Sparkle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { GeneralSection } from "../settings/GeneralSection";
import { ProvidersSection } from "../settings/ProvidersSection";
import { GitHubSection } from "../settings/GitHubSection";
import { ContextSection } from "../settings/ContextSection";
import { UsageDashboard } from "../missions/UsageDashboard";
import { AiFeaturesSection } from "../settings/AiFeaturesSection";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

const SECTIONS = [
  { id: "general", label: "General", icon: GearSix },
  { id: "providers", label: "Providers", icon: Plugs },
  { id: "github", label: "GitHub", icon: GitBranch },
  { id: "context", label: "Context & Docs", icon: BookOpenText },
  { id: "automations", label: "Automations", icon: Robot },
  { id: "terminals", label: "Terminals", icon: Terminal },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "ai-features", label: "AI Features", icon: Sparkle },
  { id: "usage", label: "Usage", icon: Lightning },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function padIndex(i: number): string {
  return String(i + 1).padStart(2, "0");
}

export function SettingsPage() {
  const [section, setSection] = useState<SectionId>("general");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Left sidebar */}
      <nav
        style={{
          width: 200,
          flexShrink: 0,
          background: COLORS.recessedBg,
          borderRight: `1px solid ${COLORS.border}`,
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 8,
          paddingRight: 8,
        }}
      >
        <div style={{ ...LABEL_STYLE, paddingLeft: 10, marginBottom: 12 }}>
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
            borderLeft: isActive ? `3px solid ${COLORS.accent}` : "3px solid transparent",
            background: isActive
              ? COLORS.accentSubtle
              : isHovered
                ? COLORS.hoverBg
                : "transparent",
            color: isActive ? COLORS.textPrimary : COLORS.textMuted,
            fontFamily: MONO_FONT,
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "1px",
            cursor: "pointer",
            borderRadius: 0,
            transition: "background 120ms ease, color 120ms ease",
          };

          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
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
        {section === "general" && <GeneralSection />}
        {section === "providers" && <ProvidersSection />}
        {section === "github" && <GitHubSection />}
        {section === "context" && <ContextSection />}
        {section === "ai-features" && <AiFeaturesSection />}
        {section === "usage" && <UsageDashboard missionId={null} />}
      </div>
    </div>
  );
}
