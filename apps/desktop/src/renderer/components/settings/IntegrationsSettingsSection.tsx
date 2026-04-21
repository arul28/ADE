import React, { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { ComputerUseSection } from "./ComputerUseSection";
import { GitHubSection } from "./GitHubSection";
import { LinearSection } from "./LinearSection";

type IntegrationTab = "github" | "linear" | "computer-use";

const TABS: { id: IntegrationTab; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "linear", label: "Linear" },
  { id: "computer-use", label: "Computer Use" },
];

function resolveIntegrationTab(param: string): IntegrationTab | null {
  if (TABS.some((tab) => tab.id === param)) return param as IntegrationTab;
  return null;
}

export function IntegrationsSettingsSection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const integrationParam = searchParams.get("integration")?.trim().toLowerCase() ?? "";
  const canonicalIntegration = resolveIntegrationTab(integrationParam);
  const activeTab = canonicalIntegration ?? "github";

  useEffect(() => {
    if (!integrationParam || !canonicalIntegration || integrationParam === canonicalIntegration) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("integration", canonicalIntegration);
    setSearchParams(nextParams, { replace: true });
  }, [canonicalIntegration, integrationParam, searchParams, setSearchParams]);

  const activateTab = useCallback((tab: IntegrationTab) => {
    const nextParams = new URLSearchParams(searchParams);
    if (tab === "github") {
      nextParams.delete("integration");
    } else {
      nextParams.set("integration", tab);
    }
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* ---- tab bar ---- */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          marginBottom: 24,
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => activateTab(tab.id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeTab === tab.id
                ? "2px solid rgba(56,189,248,0.7)"
                : "2px solid transparent",
              cursor: "pointer",
              padding: "8px 16px",
              fontSize: 12,
              fontFamily: "var(--font-sans, system-ui, sans-serif)",
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id
                ? "rgba(255,255,255,0.88)"
                : "rgba(255,255,255,0.45)",
              transition: "color 0.15s, border-color 0.15s",
              letterSpacing: "0.01em",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- tab content ---- */}
      <div id={`settings-${activeTab}`}>
        {activeTab === "github" && <GitHubSection />}
        {activeTab === "linear" && <LinearSection />}
        {activeTab === "computer-use" && <ComputerUseSection />}
      </div>
    </div>
  );
}
