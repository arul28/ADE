import { useState, type ReactNode } from "react";
import { ArrowSquareOut, CaretRight, GitBranch } from "@phosphor-icons/react";
import type { AutomationRunDetail, OpenProjectBinding } from "../../../../shared/types";
import { Banner } from "../../ui/notice/Banner";
import { AgentChatPane } from "../../chat/AgentChatPane";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { formatDate, relativeWhen } from "../../../lib/format";
import { STEP_DEFS, type StepDef } from "../actionCatalog";
import { eventLabel } from "../triggerCatalog";
import { readTestRunInfo, summarizeTestRun, testRunLabel } from "./testRunInfo";
import { STATE_HALO, STATE_TEXT, StatusGlyph, durationLabel, messageTone, runState, statusWord } from "./runPresentation";

function stepLabel(actionType: string): string {
  if (actionType === "lane-setup") return "Set up the lane";
  return (STEP_DEFS as Record<string, StepDef | undefined>)[actionType]?.label
    ?? actionType.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** `scheduledAt` → "Scheduled at"; ISO times read as local times. */
function detailEntry(key: string, value: unknown): { label: string; value: string } {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();
  const label = words.replace(/^./, (c) => c.toUpperCase());
  if (typeof value === "string") {
    return { label, value: /^\d{4}-\d{2}-\d{2}T/.test(value) ? formatDate(value) : value };
  }
  return { label, value: JSON.stringify(value) };
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-4 py-1.5">
      <dt className="w-32 shrink-0 text-[11px] text-[color:var(--kit-text-3)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-xs text-fg/80">{children}</dd>
    </div>
  );
}

function openExternal(url: string) {
  void (window as unknown as { ade?: { app?: { openExternal?: (u: string) => Promise<void> } } }).ade?.app?.openExternal?.(url);
}

/** What a test run did, with Clean up for the lanes it made. */
function TestRunNotice({
  detail,
  pin,
  onChanged,
}: {
  detail: AutomationRunDetail;
  pin: OpenProjectBinding | null;
  onChanged: () => void;
}) {
  const [cleaning, setCleaning] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const test = readTestRunInfo(detail.run);
  if (!test) return null;
  const canClean = test.lanes.length > 0 && !test.cleanedUpAt && Boolean(detail.run.endedAt);
  const cleanUp = async () => {
    setCleaning(true);
    setCleanupError(null);
    try {
      const result = await window.ade.automations.cleanUpTestRun({ runId: detail.run.id }, pin);
      // A partial cleanup keeps this notice and its error; the reload would clear them.
      if (result.failed.length) {
        setCleanupError(result.failed.map((lane) => `${lane.name}: ${lane.error}`).join(" "));
      } else {
        onChanged();
      }
    } catch (err) {
      setCleanupError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };
  return (
    <Banner
      layout="inline"
      testId="automation-run-test"
      model={{
        id: `automation-run-test-${detail.run.id}`,
        tone: "info",
        title: `This was a ${testRunLabel(test).toLowerCase()}.`,
        detail: [
          summarizeTestRun(test, detail.actions),
          !detail.run.endedAt && test.lanes.length ? "Clean up is available when it finishes." : null,
          cleanupError ? `Clean up did not finish: ${cleanupError}` : null,
        ].filter(Boolean).join(" "),
        busy: cleaning,
        actions: canClean
          ? [{
            label: test.lanes.length === 1 ? "Clean up the lane" : `Clean up ${test.lanes.length} lanes`,
            onClick: () => void cleanUp(),
            busy: cleaning,
          }]
          : undefined,
      }}
    />
  );
}

export function RunDetail({
  detail,
  loading,
  pin = null,
  ruleName,
  onChanged,
}: {
  detail: AutomationRunDetail | null;
  loading: boolean;
  /** The rule's name, for a run whose rule has since been removed. */
  ruleName: string;
  /** The machine the run is on. */
  pin?: OpenProjectBinding | null;
  /** Called after Clean up, so the history reloads. */
  onChanged?: () => void;
}) {
  if (loading) return <div className="p-5 text-sm text-muted-fg/60">Loading run detail…</div>;
  if (!detail) return <div className="p-5 text-sm text-muted-fg/60">Select a run to inspect what ADE did.</div>;

  const { run } = detail;
  const metadata = (run.triggerMetadata ?? {}) as Record<string, unknown>;
  const pr = metadata.pr && typeof metadata.pr === "object" ? (metadata.pr as Record<string, unknown>) : {};
  const laneId = detail.chatSession?.laneId ?? readString(metadata, "laneId");
  const laneName = readString(metadata, "laneName");
  const prUrl = readString(pr, "url") ?? readString(metadata, "prUrl");
  const title = detail.rule?.name ?? ruleName;
  const queueStatus = detail.rule?.queueStatus ? detail.rule.queueStatus.replace(/-/g, " ") : null;
  const verifyBeforePublish = detail.rule?.verification?.verifyBeforePublish === true;
  const state = runState(run.status);
  // What happened, said once: the run's error, else its summary.
  const message = run.errorMessage ?? run.summary;
  const took = durationLabel(run.startedAt, run.endedAt);
  const whenLine = [
    eventLabel(run.triggerType),
    relativeWhen(run.startedAt),
    run.endedAt ? (took ? `took ${took}` : null) : state === "running" ? "still running" : null,
    run.spendUsd > 0 ? `$${run.spendUsd.toFixed(2)}` : null,
  ].filter(Boolean).join(" · ");
  const doneSteps = detail.actions.filter((action) => action.status === "succeeded").length;
  // `test` has its own notice; a manual run's `reason` is only the rule id.
  const detailEntries = Object.entries(metadata)
    .filter(([key, value]) => key !== "test" && !(key === "reason" && value === run.automationId))
    .map(([key, value]) => detailEntry(key, value));

  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <TestRunNotice detail={detail} pin={pin} onChanged={() => onChanged?.()} />

        <section className="kit-card" data-testid="automation-run-summary">
          <div className="p-5">
            <div className="flex items-center gap-3">
              <div
                className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", STATE_HALO[state])}
              >
                <StatusGlyph status={run.status} size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-semibold text-fg">{title}</h2>
                <div className="text-xs leading-relaxed text-[color:var(--kit-text-3)]">
                  <span className={cn("font-medium", STATE_TEXT[state])}>{statusWord(run.status)}</span>
                  {whenLine ? ` · ${whenLine}` : null}
                </div>
              </div>
            </div>
            {message ? (
              <p className={cn("mt-4 text-sm leading-relaxed", messageTone(state))}>{message}</p>
            ) : null}
            {(laneId || prUrl || queueStatus || verifyBeforePublish) ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {queueStatus ? <span className="kit-tag">{queueStatus}</span> : null}
                {verifyBeforePublish ? <span className="kit-tag" data-tone="warn">Verify before publish</span> : null}
                {laneId ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.03] px-2 py-1 text-[11px] text-fg/70">
                    <GitBranch size={12} weight="regular" />
                    {laneName ?? <span className="font-mono">{laneId.slice(0, 12)}</span>}
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
          </div>
        </section>

        {detail.actions.length > 0 ? (
          <section className="kit-card">
            <header className="kit-card-head">
              Steps
              <span className="kit-card-head-count">{doneSteps} of {detail.actions.length} done</span>
            </header>
            <ol className="kit-card-body flex flex-col gap-1" data-flush="true">
              {detail.actions.map((action, index) => {
                const stepState = runState(action.status);
                const stepTook = durationLabel(action.startedAt, action.endedAt, true);
                // The run's message already says it; a step repeats only what is new.
                const error = action.errorMessage && action.errorMessage !== message ? action.errorMessage : null;
                const output = action.output && action.output !== action.errorMessage ? action.output : null;
                const last = index === detail.actions.length - 1;
                return (
                  <li key={action.id} className="relative flex gap-3 px-4 py-3">
                    {!last ? <span aria-hidden className="absolute bottom-0 left-[25px] top-9 w-px bg-fg/[0.08]" /> : null}
                    <StatusGlyph status={action.status} size={20} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className={cn("text-sm font-medium", stepState === "skipped" ? "text-fg/50" : "text-fg")}>
                          {stepLabel(action.actionType)}
                        </span>
                        <span className="kit-num shrink-0 text-[11px] text-[color:var(--kit-text-3)]">
                          {action.endedAt ? stepTook ?? "" : "running"}
                        </span>
                      </div>
                      {error ? <p className={cn("mt-1 text-xs leading-relaxed", messageTone("failed"))}>{error}</p> : null}
                      {output ? (
                        <details className="group mt-2">
                          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-[color:var(--kit-text-3)] hover:text-fg/80">
                            <CaretRight size={10} weight="bold" className="transition-transform group-open:rotate-90" />
                            Output
                          </summary>
                          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-fg/[0.06] bg-black/[0.25] p-3 font-mono text-[11px] leading-relaxed text-fg/80">
                            {output}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {detail.chatSession ? (
          <section className="kit-card">
            <header className="kit-card-head">Automation thread</header>
            <div className="kit-card-body">
              <div className="mb-3 text-xs text-[color:var(--kit-text-3)]">This thread lives in Automations history. It doesn't appear in the Work tab.</div>
              <div className="h-[560px] overflow-hidden rounded-xl border border-fg/[0.06] bg-black/[0.18]">
                <AgentChatPane
                  laneId={detail.chatSession.laneId}
                  initialSessionSummary={detail.chatSession}
                  lockSessionId={detail.chatSession.sessionId}
                  lockSessionProvider={detail.chatSession.provider ?? null}
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
            </div>
          </section>
        ) : null}

        <details className="kit-card group">
          <summary className="kit-card-head cursor-pointer list-none select-none">
            <CaretRight size={12} weight="bold" className="transition-transform group-open:rotate-90" />
            Details
          </summary>
          <dl className="kit-card-body divide-y divide-fg/[0.05]">
            <DetailRow label="Run ID"><span className="font-mono">{run.id}</span></DetailRow>
            <DetailRow label="Started">{formatDate(run.startedAt)}</DetailRow>
            <DetailRow label="Finished">{run.endedAt ? formatDate(run.endedAt) : `Not yet (${statusWord(run.status).toLowerCase()})`}</DetailRow>
            <DetailRow label="Spend">${(run.spendUsd ?? 0).toFixed(2)}</DetailRow>
            <DetailRow label="Billing code"><span className="font-mono">{run.billingCode ?? detail.rule?.billingCode ?? "None"}</span></DetailRow>
            {run.chatSessionId ? <DetailRow label="Chat"><span className="font-mono">{run.chatSessionId}</span></DetailRow> : null}
            {detail.ingressEvent ? (
              <DetailRow label="Event">
                {[detail.ingressEvent.source, detail.ingressEvent.eventName, detail.ingressEvent.status].filter(Boolean).join(" · ")}
                {detail.ingressEvent.summary ? <div className="mt-0.5 text-fg/60">{detail.ingressEvent.summary}</div> : null}
              </DetailRow>
            ) : null}
            {detailEntries.map((entry) => (
              <DetailRow key={entry.label} label={entry.label}>{entry.value}</DetailRow>
            ))}
          </dl>
        </details>
      </div>
    </div>
  );
}
