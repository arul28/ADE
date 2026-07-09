import { type ReactElement, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AutomationRuleDraft } from "../../../shared/types";
import { RulesTab } from "./RulesTab";
import { ProductionAutomationsComingSoon } from "./AutomationsComingSoon";

type AutomationsAvailabilityState = "checking" | "disabled" | "enabled";

function useAutomationsAvailabilityState(): AutomationsAvailabilityState {
  const [state, setState] = useState<AutomationsAvailabilityState>("checking");

  useEffect(() => {
    let cancelled = false;
    let probe: Promise<{ isPackaged: boolean; automationsEnabled?: boolean }> | null = null;
    try {
      const getInfo = window.ade?.app?.getInfo;
      probe = typeof getInfo === "function" ? getInfo() : null;
    } catch {
      probe = null;
    }
    if (!probe) {
      setState("enabled");
      return () => {
        cancelled = true;
      };
    }
    probe.then(
      (info) => {
        if (cancelled) return;
        // Older runtimes without the flag fall back to the pre-flag rule.
        const enabled = info.automationsEnabled ?? !info.isPackaged;
        setState(enabled ? "enabled" : "disabled");
      },
      () => {
        if (!cancelled) setState("enabled");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function AutomationsProductionGate({ children }: { children: ReactElement }) {
  const state = useAutomationsAvailabilityState();

  if (state === "checking") {
    return (
      <div className="flex h-full min-w-0 flex-col bg-[#0D0F12]">
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-4 w-48 animate-pulse rounded-md bg-white/[0.06]" />
          <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#7D8794]">
            Checking automation availability...
          </div>
        </div>
      </div>
    );
  }

  if (state === "disabled") return <ProductionAutomationsComingSoon />;

  return children;
}

export function AutomationsPage({ active = true }: { active?: boolean } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [pendingDraft, setPendingDraft] = useState<AutomationRuleDraft | null>(null);

  useEffect(() => {
    console.info(`renderer.page ${JSON.stringify({ page: "automations" })}`);
  }, []);

  // Templates screen navigates here with { draft } in location state to seed a new rule.
  useEffect(() => {
    if (!active) return;
    const state = location.state as { draft?: AutomationRuleDraft } | null;
    if (state?.draft) {
      setPendingDraft(state.draft);
      // Clear state so refresh doesn't re-seed.
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [active, location.pathname, location.state, navigate]);

  return (
    <AutomationsProductionGate>
      <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg" data-testid="automations-page">
        <div className="flex-1 min-h-0 overflow-hidden">
          <RulesTab
            active={active}
            pendingDraft={pendingDraft}
            onDraftConsumed={() => setPendingDraft(null)}
            onOpenTemplates={() => navigate("/automations/templates")}
          />
        </div>
      </div>
    </AutomationsProductionGate>
  );
}
