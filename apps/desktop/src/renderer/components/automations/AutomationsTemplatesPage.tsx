import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { Button } from "../ui/Button";
import { AutomationsProductionGate } from "./AutomationsPage";
import { TemplateGallery } from "./templates/TemplateGallery";

export function AutomationsTemplatesPage({ active = true }: { active?: boolean } = {}) {
  const navigate = useNavigate();
  void active;

  return (
    <AutomationsProductionGate>
      <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg" data-testid="automations-templates-page">
        <div
          className="shrink-0 flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4"
          style={{ minHeight: 40 }}
        >
          <Button size="sm" variant="ghost" onClick={() => navigate("/automations")}>
            <ArrowLeft size={12} weight="regular" />
            Back to automations
          </Button>
          <div className="text-sm font-semibold text-fg">Templates</div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <TemplateGallery
            onUseTemplate={(draft) => {
              navigate("/automations", { state: { draft: draft as AutomationRuleDraft } });
            }}
          />
        </div>
      </div>
    </AutomationsProductionGate>
  );
}
