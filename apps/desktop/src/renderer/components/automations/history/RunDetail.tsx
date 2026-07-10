import { ArrowSquareOut, GitBranch } from "@phosphor-icons/react";
import type { AutomationRunDetail } from "../../../../shared/types";
import { AgentChatPane } from "../../chat/AgentChatPane";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { statusToneAutomation as statusTone } from "../../../lib/format";
import { cardCls, labelCls, recessedCls } from "../designTokens";
import { eventLabel } from "../triggerCatalog";

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn(recessedCls, "p-3")}>
      <div className={labelCls}>{label}</div>
      <div className="mt-1 break-all text-xs text-fg">{value}</div>
    </div>
  );
}

function humanizeQueue(status: string): string {
  return status.replace(/-/g, " ");
}

function openExternal(url: string) {
  void (window as unknown as { ade?: { app?: { openExternal?: (u: string) => Promise<void> } } }).ade?.app?.openExternal?.(url);
}

export function RunDetail({ detail, loading }: { detail: AutomationRunDetail | null; loading: boolean }) {
  if (loading) return <div className="p-5 text-sm text-muted-fg/60">Loading run detail…</div>;
  if (!detail) return <div className="p-5 text-sm text-muted-fg/60">Select a run to inspect what ADE did.</div>;

  const metadata = (detail.run.triggerMetadata ?? {}) as Record<string, unknown>;
  const metadataEntries = Object.entries(metadata);
  const laneId =
    detail.chatSession?.laneId ?? (typeof metadata.laneId === "string" ? (metadata.laneId as string) : null);
  const prUrl =
    (metadata.pr && typeof metadata.pr === "object" && "url" in (metadata.pr as object)
      ? (metadata.pr as { url?: string }).url
      : undefined) ?? (typeof metadata.prUrl === "string" ? (metadata.prUrl as string) : undefined);

  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <section className={cardCls}>
          <div className="flex flex-wrap items-center gap-2">
            <Chip className={cn("text-[9px]", statusTone(detail.run.status))}>{detail.run.status}</Chip>
            <Chip className="text-[9px]">{detail.run.executionKind}</Chip>
            <Chip className="text-[9px]">{eventLabel(detail.run.triggerType)}</Chip>
            {detail.rule?.queueStatus ? (
              <Chip className="text-[9px]">{humanizeQueue(detail.rule.queueStatus)}</Chip>
            ) : null}
            {detail.rule?.verification?.verifyBeforePublish ? (
              <Chip className="text-[9px] text-accent">Verify before publish</Chip>
            ) : null}
          </div>
          <div className="mt-3 text-lg font-semibold text-fg">{detail.rule?.name ?? detail.run.automationId}</div>
          <div className="mt-1 text-sm text-muted-fg/70">{detail.run.summary ?? "No summary recorded for this run."}</div>
          {detail.run.errorMessage ? <div className="mt-2 text-sm text-red-400">{detail.run.errorMessage}</div> : null}

          {(laneId || prUrl) ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {laneId ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10.5px] text-muted-fg/75">
                  <GitBranch size={11} weight="regular" />
                  <span className="font-mono">{laneId.slice(0, 12)}</span>
                </span>
              ) : null}
              {prUrl ? (
                <Button size="sm" variant="outline" onClick={() => openExternal(prUrl)}>
                  <ArrowSquareOut size={11} weight="bold" />
                  View PR
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetaCard label="Run id" value={detail.run.id} />
          <MetaCard label="Billing" value={detail.run.billingCode ?? detail.rule?.billingCode ?? "none"} />
          <MetaCard label="Spend" value={`$${(detail.run.spendUsd ?? 0).toFixed(2)}`} />
          <MetaCard label="Started" value={detail.run.startedAt} />
          <MetaCard label="Ended" value={detail.run.endedAt ?? "still running"} />
          <MetaCard label="Chat session" value={detail.run.chatSessionId ?? "none"} />
        </section>

        {detail.chatSession ? (
          <section className={cardCls}>
            <div className="mb-3">
              <div className="text-sm font-semibold text-fg">Automation thread</div>
              <div className="mt-1 text-xs text-muted-fg/60">This thread lives in Automations history. It doesn't appear in the Work tab.</div>
            </div>
            <div className="h-[560px] overflow-hidden rounded-xl border border-white/[0.06] bg-black/[0.18]">
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
                  messagePlaceholder: "Continue the automation thread…",
                }}
              />
            </div>
          </section>
        ) : null}

        {detail.actions.length > 0 ? (
          <section className={cardCls}>
            <div className="text-sm font-semibold text-fg">Step results</div>
            <div className="mt-3 space-y-3">
              {detail.actions.map((action) => {
                const isLaneSetup = action.actionType === "lane-setup";
                return (
                  <div
                    key={action.id}
                    className={cn("rounded-lg border p-3", isLaneSetup ? "border-accent/25 bg-accent/[0.04]" : "border-white/[0.06] bg-black/[0.14]")}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                        {isLaneSetup ? <GitBranch size={13} weight="regular" className="text-accent" /> : null}
                        <span>{isLaneSetup ? "Lane setup" : `#${action.actionIndex + 1} ${action.actionType}`}</span>
                      </div>
                      <Chip className={cn("text-[9px]", statusTone(action.status))}>{action.status}</Chip>
                    </div>
                    {action.errorMessage ? <div className="mt-2 text-sm text-red-400">{action.errorMessage}</div> : null}
                    {action.output ? (
                      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/[0.3] p-3 font-mono text-[11px] leading-relaxed text-fg/80">
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
            {detail.ingressEvent.summary ? <div className="mt-2 text-sm text-muted-fg/70">{detail.ingressEvent.summary}</div> : null}
          </section>
        ) : null}

        {metadataEntries.length > 0 ? (
          <section className={cardCls}>
            <div className="text-sm font-semibold text-fg">Trigger metadata</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {metadataEntries.map(([key, value]) => (
                <MetaCard key={key} label={key} value={typeof value === "string" ? value : JSON.stringify(value)} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
