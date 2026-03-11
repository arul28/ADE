import { useState } from "react";
import { CheckCircle, ArchiveBox, Moon, Prohibit } from "@phosphor-icons/react";
import type { AutomationRunDetail } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { statusToneAutomation as statusTone } from "../../../lib/format";
import { extractError } from "../shared";

function MetaCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="p-3" style={{ background: "#181423", border: "1px solid #2D2840" }}>
      <div className="font-mono text-[9px] text-[#71717A]">{label}</div>
      <div className={cn("mt-1 text-xs text-[#FAFAFA] break-all", tone)}>{value}</div>
    </div>
  );
}

export function RunDetailPanel({
  detail,
  loading,
  onActionComplete,
}: {
  detail: AutomationRunDetail | null;
  loading: boolean;
  onActionComplete?: () => void;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const queueAction = async (action: "accept" | "archive" | "ignore" | "queue-overnight") => {
    if (!detail.queueItem) return;
    setBusyAction(action);
    setError(null);
    try {
      await window.ade.automations.updateQueueItem({
        queueItemId: detail.queueItem.id,
        action,
      });
      onActionComplete?.();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusyAction(null);
    }
  };

  const triggerMetadataEntries = Object.entries(detail.run.triggerMetadata ?? {}).slice(0, 6);

  return (
    <div className="p-4 space-y-3">
      <div className="font-mono text-[9px] text-[#71717A]">
        run: <span className="text-[#A1A1AA]">{detail.run.id}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] text-[#71717A]">status</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Chip className={cn("text-[9px]", statusTone(detail.run.status))}>{detail.run.status}</Chip>
            <Chip className="text-[9px]">{detail.run.queueStatus}</Chip>
            <Chip className="text-[9px]">{detail.run.executorMode}</Chip>
            <Chip className="text-[9px]">{detail.run.triggerType}</Chip>
          </div>
          {detail.run.summary ? <div className="text-xs text-[#D4D4D8]">{detail.run.summary}</div> : null}
          {detail.run.confidence ? (
            <div className="font-mono text-[9px] text-[#8B8B9A]">
              confidence {detail.run.confidence.label} ({Math.round(detail.run.confidence.value * 100)}%)
            </div>
          ) : null}
          {detail.run.errorMessage ? <div className="text-xs text-red-300">{detail.run.errorMessage}</div> : null}
        </div>

        <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] text-[#71717A]">review / publish gate</div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip className="text-[9px]">{detail.run.verificationRequired ? "verification required" : "no publish gate"}</Chip>
            {detail.pendingPublish ? <Chip className="text-[9px]">pending publish</Chip> : null}
          </div>
          {detail.pendingPublish ? (
            <div className="text-xs text-[#D4D4D8]">{detail.pendingPublish.summary}</div>
          ) : (
            <div className="text-xs text-[#8B8B9A]">No staged publish continuation attached to this run.</div>
          )}
          {detail.pendingPublish?.toolPalette?.length ? (
            <div className="font-mono text-[9px] text-[#8B8B9A]">
              publish tools: {detail.pendingPublish.toolPalette.join(", ")}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <MetaCard label="mission" value={detail.run.missionId ?? "none"} />
        <MetaCard label="worker run" value={detail.run.workerRunId ?? "none"} />
        <MetaCard label="worker target" value={detail.run.workerAgentId ?? detail.rule?.executor.targetId ?? "none"} />
        <MetaCard label="billing code" value={detail.run.billingCode ?? detail.rule?.billingCode ?? "none"} />
        <MetaCard label="spend" value={`$${detail.run.spendUsd.toFixed(2)}`} />
        <MetaCard label="actions" value={`${detail.run.actionsCompleted}/${detail.run.actionsTotal}`} />
      </div>

      {detail.queueItem ? (
        <div className="p-3 space-y-3" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-mono text-[9px] text-[#71717A]">queue item</div>
              <div className="mt-1 text-xs text-[#FAFAFA]">{detail.queueItem.title}</div>
            </div>
            <Chip className="text-[9px]">{detail.queueItem.queueStatus}</Chip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busyAction != null} onClick={() => void queueAction("accept")}>
              <CheckCircle size={12} weight="regular" />
              Accept
            </Button>
            <Button size="sm" variant="outline" disabled={busyAction != null} onClick={() => void queueAction("archive")}>
              <ArchiveBox size={12} weight="regular" />
              Archive
            </Button>
            <Button size="sm" variant="outline" disabled={busyAction != null} onClick={() => void queueAction("queue-overnight")}>
              <Moon size={12} weight="regular" />
              Requeue
            </Button>
            <Button size="sm" variant="outline" disabled={busyAction != null} onClick={() => void queueAction("ignore")}>
              <Prohibit size={12} weight="regular" />
              Ignore
            </Button>
          </div>
          {error ? <div className="text-xs text-red-300">{error}</div> : null}
        </div>
      ) : null}

      {detail.ingressEvent ? (
        <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] text-[#71717A]">ingress</div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip className="text-[9px]">{detail.ingressEvent.source}</Chip>
            <Chip className="text-[9px]">{detail.ingressEvent.status}</Chip>
            {detail.ingressEvent.eventName ? <Chip className="text-[9px]">{detail.ingressEvent.eventName}</Chip> : null}
          </div>
          {detail.ingressEvent.summary ? <div className="text-xs text-[#D4D4D8]">{detail.ingressEvent.summary}</div> : null}
          <div className="font-mono text-[9px] text-[#8B8B9A]">
            key {detail.ingressEvent.eventKey}
            {detail.ingressEvent.cursor ? ` · cursor ${detail.ingressEvent.cursor}` : ""}
          </div>
          {detail.ingressEvent.errorMessage ? <div className="text-xs text-red-300">{detail.ingressEvent.errorMessage}</div> : null}
        </div>
      ) : null}

      {triggerMetadataEntries.length ? (
        <div className="p-3 space-y-2" style={{ background: "#181423", border: "1px solid #2D2840" }}>
          <div className="font-mono text-[9px] text-[#71717A]">trigger metadata</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {triggerMetadataEntries.map(([key, value]) => (
              <div key={key} className="rounded px-3 py-2" style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}>
                <div className="font-mono text-[9px] text-[#71717A]">{key}</div>
                <div className="mt-1 text-xs text-[#FAFAFA] break-all">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
