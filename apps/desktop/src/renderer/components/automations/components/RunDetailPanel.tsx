import type { AutomationRunDetail } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { statusToneAutomation as statusTone } from "../../../lib/format";

export function RunDetailPanel({
  detail,
  loading,
}: {
  detail: AutomationRunDetail | null;
  loading: boolean;
}) {
  if (loading) {
    return <div className="p-4 font-mono text-[10px] text-[#71717A]">Loading run detail...</div>;
  }

  if (!detail) {
    return (
      <div className="p-4 font-mono text-[10px] text-[#71717A]">
        Select a run to view action results.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="font-mono text-[9px] text-[#71717A]">
        run: <span className="text-[#A1A1AA]">{detail.run.id}</span>
      </div>

      {detail.actions.map((action) => (
        <div
          key={action.id}
          className="p-3"
          style={{ background: "#181423", border: "1px solid #2D2840" }}
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="font-semibold text-[#FAFAFA]">
              #{action.actionIndex + 1} {action.actionType}
            </div>
            <Chip className={cn("text-[9px]", statusTone(action.status))}>{action.status}</Chip>
          </div>

          {action.errorMessage && (
            <div className="mt-1 text-xs text-red-300">{action.errorMessage}</div>
          )}

          {action.output && (
            <pre
              className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap p-2 text-xs leading-relaxed text-[#FAFAFA]"
              style={{ background: "#0B0A0F", border: "1px solid #2D284060" }}
            >
              {action.output}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
