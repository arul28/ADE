import { ArrowSquareOut, GitBranch } from "@phosphor-icons/react";
import type { AutomationRunDetail } from "../../../../shared/types";
import { AgentChatPane } from "../../chat/AgentChatPane";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { statusToneAutomation as statusTone } from "../../../lib/format";
import { cardCls, labelCls } from "../designTokens";

function MetaCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-[rgba(12,10,22,0.6)] p-3">
      <div className={labelCls}>{label}</div>
      <div className="mt-1 break-all text-xs text-fg">{value}</div>
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
    return <div className="p-5 text-sm text-muted-fg/60">Loading run detail...</div>;
  }

  if (!detail) {
    return <div className="p-5 text-sm text-muted-fg/60">Select a run to inspect what ADE did.</div>;
  }

  const triggerMetadataEntries = Object.entries(detail.run.triggerMetadata ?? {});

  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className={cardCls}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Chip className={cn("text-[9px]", statusTone(detail.run.status))}>{detail.run.status}</Chip>
                <Chip className="text-[9px]">{detail.run.executionKind}</Chip>
                <Chip className="text-[9px]">{detail.run.triggerType}</Chip>
              </div>
              <div className="mt-3 text-lg font-semibold text-fg">
                {detail.rule?.name ?? detail.run.automationId}
              </div>
              <div className="mt-1 text-sm text-muted-fg/70">
                {detail.run.summary ?? "No summary recorded for this run."}
              </div>
              {detail.run.errorMessage ? (
                <div className="mt-2 text-sm text-error">{detail.run.errorMessage}</div>
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
          <MetaCard label="Spend" value={`$${(detail.run.spendUsd ?? 0).toFixed(2)}`} />
          <MetaCard label="Started" value={detail.run.startedAt} />
          <MetaCard label="Ended" value={detail.run.endedAt ?? "still running"} />
          <MetaCard label="Automation" value={detail.run.automationId} />
          <MetaCard label="Mission" value={detail.run.missionId ?? "none"} />
          <MetaCard label="Chat session" value={detail.run.chatSessionId ?? "none"} />
        </section>

        {detail.chatSession ? (
          <section className={cardCls}>
            <div className="mb-3">
              <div className="text-sm font-semibold text-fg">Automation thread</div>
              <div className="mt-1 text-xs text-muted-fg/60">
                This thread lives inside Automations history. It does not appear in the Work tab.
              </div>
            </div>
            <div className="h-[620px] overflow-hidden rounded-xl border border-white/[0.08] bg-[rgba(7,16,26,0.6)]">
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
          <section className={cardCls}>
            <div className="text-sm font-semibold text-fg">Mission-backed run</div>
            <div className="mt-1 text-sm text-muted-fg/70">
              This automation launched a mission instead of an automation chat thread. Open the mission to inspect the live transcript, steps, and artifacts.
            </div>
          </section>
        ) : null}

        {detail.actions.length > 0 ? (
          <section className={cardCls}>
            <div className="text-sm font-semibold text-fg">Action output</div>
            <div className="mt-3 space-y-3">
              {detail.actions.map((action) => {
                const isLaneSetup = action.actionType === "lane-setup";
                return (
                  <div
                    key={action.id}
                    className={cn(
                      "rounded-xl border p-4",
                      isLaneSetup
                        ? "border-accent/25 bg-accent/[0.04]"
                        : "border-white/[0.08] bg-[rgba(11,18,26,0.6)]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                        {isLaneSetup ? <GitBranch size={13} weight="regular" className="text-accent" /> : null}
                        <span>
                          {isLaneSetup ? "Lane setup" : `#${action.actionIndex + 1} ${action.actionType}`}
                        </span>
                      </div>
                      <Chip className={cn("text-[9px]", statusTone(action.status as any))}>{action.status}</Chip>
                    </div>
                    {action.errorMessage ? (
                      <div className="mt-2 text-sm text-error">{action.errorMessage}</div>
                    ) : null}
                    {action.output ? (
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-[rgba(0,0,0,0.3)] p-3 font-mono text-[11px] leading-relaxed text-fg/80">
                        {action.output}
                      </pre>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {detail.ingressEvent ? (
          <section className={cardCls}>
            <div className="text-sm font-semibold text-fg">Ingress context</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Chip className="text-[9px]">{detail.ingressEvent.source}</Chip>
              <Chip className="text-[9px]">{detail.ingressEvent.status}</Chip>
              {detail.ingressEvent.eventName ? <Chip className="text-[9px]">{detail.ingressEvent.eventName}</Chip> : null}
            </div>
            {detail.ingressEvent.summary ? (
              <div className="mt-2 text-sm text-muted-fg/70">{detail.ingressEvent.summary}</div>
            ) : null}
          </section>
        ) : null}

        {triggerMetadataEntries.length > 0 ? (
          <section className={cardCls}>
            <div className="text-sm font-semibold text-fg">Trigger metadata</div>
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
