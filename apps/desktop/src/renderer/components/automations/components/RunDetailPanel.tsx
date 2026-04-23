import { ArrowSquareOut } from "@phosphor-icons/react";
import type { AutomationRunDetail } from "../../../../shared/types";
import { AgentChatPane } from "../../chat/AgentChatPane";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { statusToneAutomation as statusTone } from "../../../lib/format";

function MetaCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
      <div className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</div>
      <div className="mt-1 break-all text-xs text-[#F5FAFF]">{value}</div>
    </div>
  );
}

export function RunDetailPanel({
  detail,
  loading,
  onOpenMission,
}: {
  detail: AutomationRunDetail | null;
  loading: boolean;
  onOpenMission?: (missionId: string) => void;
}) {
  if (loading) {
    return <div className="p-5 text-sm text-[#93A4B8]">Loading run detail...</div>;
  }

  if (!detail) {
    return <div className="p-5 text-sm text-[#93A4B8]">Select a run to inspect what ADE did.</div>;
  }

  const triggerMetadataEntries = Object.entries(detail.run.triggerMetadata ?? {});

  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Chip className={cn("text-[9px]", statusTone(detail.run.status))}>{detail.run.status}</Chip>
                <Chip className="text-[9px]">{detail.run.executionKind}</Chip>
                <Chip className="text-[9px]">{detail.run.triggerType}</Chip>
              </div>
              <div className="mt-3 text-lg font-semibold text-[#F5FAFF]">
                {detail.rule?.name ?? detail.run.automationId}
              </div>
              <div className="mt-1 text-sm text-[#93A4B8]">
                {detail.run.summary ?? "No summary recorded for this run."}
              </div>
              {detail.run.errorMessage ? (
                <div className="mt-2 text-sm text-red-200">{detail.run.errorMessage}</div>
              ) : null}
            </div>

            {detail.run.missionId && onOpenMission ? (
              <Button size="sm" variant="outline" onClick={() => onOpenMission(detail.run.missionId!)}>
                <ArrowSquareOut size={12} weight="regular" />
                Open mission
              </Button>
            ) : null}
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetaCard label="Run id" value={detail.run.id} />
          <MetaCard label="Billing" value={detail.run.billingCode ?? detail.rule?.billingCode ?? "none"} />
          <MetaCard label="Started" value={detail.run.startedAt} />
          <MetaCard label="Ended" value={detail.run.endedAt ?? "still running"} />
          <MetaCard label="Automation" value={detail.run.automationId} />
          <MetaCard label="Mission" value={detail.run.missionId ?? "none"} />
          <MetaCard label="Chat session" value={detail.run.chatSessionId ?? "none"} />
        </section>

        {detail.chatSession ? (
          <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
            <div className="mb-3">
              <div className="text-sm font-semibold text-[#F5FAFF]">Automation thread</div>
              <div className="mt-1 text-xs text-[#93A4B8]">
                This thread lives inside Automations history. It does not appear in the Work tab.
              </div>
            </div>
            <div className="h-[620px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#07101A]">
              <AgentChatPane
                laneId={detail.chatSession.laneId}
                initialSessionSummary={detail.chatSession}
                lockSessionId={detail.chatSession.sessionId}
                hideSessionTabs
                modelSelectionLocked
                permissionModeLocked
                presentation={{
                  mode: "standard",
                  title: detail.chatSession.title ?? detail.rule?.name ?? "Automation thread",
                  assistantLabel: "Automation",
                  messagePlaceholder: "Continue the automation thread...",
                }}
              />
            </div>
          </section>
        ) : null}

        {detail.run.missionId && !detail.chatSession ? (
          <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
            <div className="text-sm font-semibold text-[#F5FAFF]">Mission-backed run</div>
            <div className="mt-1 text-sm text-[#93A4B8]">
              This automation launched a mission instead of an automation chat thread. Open the mission to inspect the live transcript, steps, and artifacts.
            </div>
          </section>
        ) : null}

        {detail.actions.length > 0 ? (
          <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
            <div className="text-sm font-semibold text-[#F5FAFF]">Action output</div>
            <div className="mt-3 space-y-3">
              {detail.actions.map((action) => (
                <div key={action.id} className="rounded-xl border border-white/[0.08] bg-[#0B121A] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-[#F5FAFF]">
                      #{action.actionIndex + 1} {action.actionType}
                    </div>
                    <Chip className={cn("text-[9px]", statusTone(action.status as any))}>{action.status}</Chip>
                  </div>
                  {action.errorMessage ? (
                    <div className="mt-2 text-sm text-red-200">{action.errorMessage}</div>
                  ) : null}
                  {action.output ? (
                    <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
                      {action.output}
                    </pre>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {detail.ingressEvent ? (
          <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
            <div className="text-sm font-semibold text-[#F5FAFF]">Ingress context</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Chip className="text-[9px]">{detail.ingressEvent.source}</Chip>
              <Chip className="text-[9px]">{detail.ingressEvent.status}</Chip>
              {detail.ingressEvent.eventName ? <Chip className="text-[9px]">{detail.ingressEvent.eventName}</Chip> : null}
            </div>
            {detail.ingressEvent.summary ? (
              <div className="mt-2 text-sm text-[#93A4B8]">{detail.ingressEvent.summary}</div>
            ) : null}
          </section>
        ) : null}

        {triggerMetadataEntries.length > 0 ? (
          <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
            <div className="text-sm font-semibold text-[#F5FAFF]">Trigger metadata</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {triggerMetadataEntries.map(([key, value]) => (
                <MetaCard
                  key={key}
                  label={key}
                  value={typeof value === "string" ? value : JSON.stringify(value)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
