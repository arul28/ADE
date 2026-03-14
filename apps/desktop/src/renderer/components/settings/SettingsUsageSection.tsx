import { useEffect, useState } from "react";
import type { AiDetectedAuth } from "../../../shared/types";
import { UsageGuardrailsSection } from "./UsageGuardrailsSection";

function hasApiAuth(entries: AiDetectedAuth[]): boolean {
  return entries.some((entry) => entry.type === "api-key" || entry.type === "openrouter");
}

export function SettingsUsageSection() {
  const [detectedAuth, setDetectedAuth] = useState<AiDetectedAuth[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.ade.ai.getStatus()
      .then((status) => {
        if (!cancelled) setDetectedAuth(status.detectedAuth ?? []);
      })
      .catch(() => {
        if (!cancelled) setDetectedAuth([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apiConfigured = hasApiAuth(detectedAuth);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <UsageGuardrailsSection showApiCost={apiConfigured} />
      {!apiConfigured ? (
        <section className="rounded-lg border border-border/10 bg-card/80 p-4 text-sm text-muted-fg">
          <div className="font-semibold text-fg">API cost tracking is hidden</div>
          <div className="mt-1 text-xs">
            This workspace is using CLI subscriptions, not API keys. Settings → Usage now shows provider quota usage like CodexBar.
            Dollar cost should only appear once API-key providers are configured and ADE can distinguish API-billed runs.
          </div>
        </section>
      ) : null}
    </div>
  );
}
