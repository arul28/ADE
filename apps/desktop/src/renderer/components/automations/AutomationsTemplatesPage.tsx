import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { Button } from "../ui/Button";
import { TemplatesTab } from "./TemplatesTab";

export function AutomationsTemplatesPage() {
  const navigate = useNavigate();
  const [missionsEnabled, setMissionsEnabled] = useState(true);

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

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg" data-testid="automations-templates-page">
      <div
        className="shrink-0 flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4"
        style={{ minHeight: 40 }}
      >
        <Button size="sm" variant="ghost" onClick={() => navigate("/automations")}>
          <ArrowLeft size={12} weight="regular" />
          Back to automations
        </Button>
        <div className="text-sm font-semibold text-[#F5FAFF]">Templates</div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <TemplatesTab
          missionsEnabled={missionsEnabled}
          onUseTemplate={(draft) => {
            navigate("/automations", { state: { draft: draft as AutomationRuleDraft } });
          }}
        />
      </div>
    </div>
  );
}
