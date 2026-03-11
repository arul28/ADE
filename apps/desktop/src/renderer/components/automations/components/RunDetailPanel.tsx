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
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] text-[#71717A]">status</div>
          <div className="mt-1 flex items-center gap-2">
            <Chip className={cn("text-[9px]", statusTone(detail.run.status))}>{detail.run.status}</Chip>
            <Chip className="text-[9px]">{detail.run.queueStatus}</Chip>
          </div>
          {detail.run.summary ? <div className="mt-2 text-xs text-[#D4D4D8]">{detail.run.summary}</div> : null}
          {detail.run.confidence ? (
            <div className="mt-2 font-mono text-[9px] text-[#8B8B9A]">
              confidence {detail.run.confidence.label} ({Math.round(detail.run.confidence.value * 100)}%)
            </div>
          ) : null}
        </div>
        <div className="p-3" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] text-[#71717A]">mission</div>
          <div className="mt-1 text-xs text-[#FAFAFA]">{detail.run.missionId ?? "legacy/none"}</div>
          {detail.run.verificationRequired ? (
            <div className="mt-2 text-[10px] text-[#F59E0B]">verification required before publish</div>
          ) : null}
          {detail.queueItem ? (
            <div className="mt-2 text-[10px] text-[#8B8B9A]">queue item: {detail.queueItem.title}</div>
          ) : null}
        </div>
      </div>

      {detail.procedureFeedback.length ? (
        <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] text-[#71717A]">procedure feedback</div>
          {detail.procedureFeedback.map((feedback) => (
            <div key={`${feedback.procedureId}-${feedback.outcome}`} className="text-xs text-[#D4D4D8]">
              {feedback.procedureId}: {feedback.outcome} · {feedback.reason}
            </div>
          ))}
        </div>
      ) : null}

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
