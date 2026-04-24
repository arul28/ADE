import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AutomationRuleDraft } from "../../../shared/types";
import { RulesTab } from "./RulesTab";

export function AutomationsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [pendingDraft, setPendingDraft] = useState<AutomationRuleDraft | null>(null);
  const [missionsEnabled, setMissionsEnabled] = useState(true);

  useEffect(() => {
    console.info(`renderer.page ${JSON.stringify({ page: "automations" })}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.ade.app.getInfo().then(
      (info) => {
        if (!cancelled) setMissionsEnabled(!info.isPackaged);
      },
      () => {
        if (!cancelled) setMissionsEnabled(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Templates screen navigates here with { draft } in location state to seed a new rule.
  useEffect(() => {
    const state = location.state as { draft?: AutomationRuleDraft } | null;
    if (state?.draft) {
      setPendingDraft(state.draft);
      // Clear state so refresh doesn't re-seed.
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg" data-testid="automations-page">
      <div className="flex-1 min-h-0 overflow-hidden">
        <RulesTab
          pendingDraft={pendingDraft}
          onDraftConsumed={() => setPendingDraft(null)}
          missionsEnabled={missionsEnabled}
          onOpenTemplates={() => navigate("/automations/templates")}
        />
      </div>
    </div>
  );
}
