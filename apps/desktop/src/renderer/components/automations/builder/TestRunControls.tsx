/**
 * Test an automation before it runs for real.
 *
 * The header's Test button opens a Preview; its caret lists the three kinds
 * with one line each. The dialog shows what the test will do with a picked
 * event, step by step, before anything runs:
 * - Preview: what a real run would do. Nothing runs.
 * - Safe test: a throwaway lane; posts, pushes and outside changes are only reported.
 * - Live test: the real run. Notifications say "[Test]".
 *
 * A test runs the saved automation on the machine it is saved to. History
 * labels it a test and offers Clean up for the lanes it made.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Flask } from "@phosphor-icons/react";
import type {
  AutomationRun,
  AutomationTestEvent,
  AutomationTestPlan,
  AutomationTestRunMode,
  AutomationTrigger,
  AutomationWebhookDeliverySummary,
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
  TerminalSessionSummary,
} from "../../../../shared/types";
import { isPullRequestTriggerType } from "../../../../shared/types";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Dialog, confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice/Banner";
import { MENU_SURFACE_CLASS } from "../../ui/paneMenuTokens";
import { inputCls, labelCls, selectCls } from "../designTokens";

export type TestKind = "preview" | AutomationTestRunMode;

export const TEST_KINDS: Array<{ kind: TestKind; label: string; hint: string }> = [
  { kind: "preview", label: "Preview", hint: "Shows what each step would do with an event. Nothing runs." },
  { kind: "safe", label: "Safe test", hint: "Runs in a throwaway lane. Posts and pushes are only reported." },
  { kind: "live", label: "Live test", hint: "Runs for real, as if the trigger fired. Notifications say [Test]." },
];

/** The header's Test button: a click opens a Preview, the caret picks the kind. */
export function TestRunButton({ disabled, title, onOpen }: { disabled?: boolean; title?: string; onOpen: (kind: TestKind) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  return (
    <span className="inline-flex items-stretch">
      <Button
        size="sm"
        variant="outline"
        className="rounded-r-none border-r-0"
        disabled={disabled}
        title={title ?? "See what this automation would do"}
        onClick={() => onOpen("preview")}
        data-testid="automation-test-button"
      >
        <Flask size={12} weight="regular" />
        Test
      </Button>
      <Button
        ref={caretRef}
        size="sm"
        variant="outline"
        className="rounded-l-none px-1.5"
        disabled={disabled}
        aria-label="Choose a kind of test"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <CaretDown size={10} weight="bold" />
      </Button>
      <AnchoredMenu
        open={menuOpen}
        anchorRef={caretRef}
        onClose={() => setMenuOpen(false)}
        placement="bottom-end"
        role="menu"
        aria-label="Kinds of test"
        className={cn(MENU_SURFACE_CLASS, "w-[300px]")}
      >
        {TEST_KINDS.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            role="menuitem"
            className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-fg/[0.06]"
            onClick={() => {
              setMenuOpen(false);
              onOpen(entry.kind);
            }}
          >
            <span className="text-[12px] font-medium text-fg">{entry.label}</span>
            <span className="text-[11px] text-muted-fg/70">{entry.hint}</span>
          </button>
        ))}
      </AnchoredMenu>
    </span>
  );
}

type EventSource = "pr" | "issue" | "linear" | "lane" | "chat" | "webhook" | "none";

function eventSourceFor(triggerType: string): EventSource {
  if (isPullRequestTriggerType(triggerType) || /^git\.pr_/.test(triggerType)) return "pr";
  if (triggerType.startsWith("github.issue")) return "issue";
  if (triggerType.startsWith("linear.")) return "linear";
  if (triggerType.startsWith("session.") || triggerType === "session-end") return "chat";
  if (triggerType === "webhook") return "webhook";
  if (triggerType.startsWith("lane.") || triggerType.startsWith("git.") || triggerType === "file.change") return "lane";
  return "none";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(err);
}

/** Picks the event a test pretends set the rule off. */
function TestEventPicker({
  trigger,
  needsLane,
  pin,
  event,
  onChange,
}: {
  trigger: AutomationTrigger;
  needsLane: boolean;
  pin: OpenProjectBinding | null;
  event: AutomationTestEvent;
  onChange: (next: AutomationTestEvent) => void;
}) {
  const source = eventSourceFor(trigger.type);
  const [prs, setPrs] = useState<PrSummary[] | null>(null);
  const [lanes, setLanes] = useState<LaneSummary[] | null>(null);
  const [chats, setChats] = useState<TerminalSessionSummary[] | null>(null);
  const [deliveries, setDeliveries] = useState<AutomationWebhookDeliverySummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hookId = trigger.webhook?.hookId ?? null;

  useEffect(() => {
    let cancelled = false;
    const fail = (err: unknown) => { if (!cancelled) setLoadError(errorText(err)); };
    if (source === "pr") {
      void window.ade.prs.listAll(pin)
        .then((rows) => { if (!cancelled) setPrs(rows.filter((pr) => pr.state === "open" || pr.state === "draft")); })
        .catch(fail);
    }
    if (source === "lane" || needsLane) {
      void window.ade.lanes.list({ includeArchived: false, includeStatus: false }, pin)
        .then((rows) => { if (!cancelled) setLanes(rows); })
        .catch(fail);
    }
    if (source === "chat") {
      void window.ade.sessions.list({ limit: 40 }, pin)
        .then((rows) => { if (!cancelled) setChats(rows.filter((row) => row.toolType !== "shell" && row.toolType !== null)); })
        .catch(fail);
    }
    if (source === "webhook" && hookId) {
      void window.ade.automations.webhooks.listDeliveries({ hookId, limit: 20 }, pin)
        .then((rows) => { if (!cancelled) setDeliveries(rows); })
        .catch(fail);
    }
    return () => { cancelled = true; };
  }, [hookId, needsLane, pin, source]);

  const pickDelivery = (id: string) => {
    if (!id) {
      onChange({ ...event, webhookBody: undefined, label: null });
      return;
    }
    void window.ade.automations.webhooks.getDelivery({ id }, pin)
      .then((delivery) => {
        if (!delivery) return;
        let body: unknown = delivery.body;
        try { body = JSON.parse(delivery.body); } catch { /* not JSON: keep the text */ }
        onChange({ ...event, webhookBody: body, label: `Webhook ${delivery.eventLabel ?? delivery.method} from ${new Date(delivery.receivedAt).toLocaleString()}` });
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  };

  const laneSelect = (label: string) => (
    <label className="block space-y-1">
      <span className={labelCls}>{label}</span>
      <select
        className={selectCls}
        value={event.laneId ?? ""}
        onChange={(e) => onChange({ ...event, laneId: e.target.value || null })}
      >
        <option value="">{lanes ? "Choose a lane" : "Loading lanes…"}</option>
        {(lanes ?? []).map((lane) => <option key={lane.id} value={lane.id}>{lane.name}</option>)}
      </select>
    </label>
  );

  return (
    <div className="space-y-2.5" data-testid="automation-test-event">
      {source === "pr" ? (
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <label className="block space-y-1">
            <span className={labelCls}>Pull request</span>
            <select
              className={selectCls}
              value={event.pr?.number && prs?.some((pr) => pr.githubPrNumber === event.pr?.number) ? String(event.pr.number) : ""}
              onChange={(e) => {
                const pr = prs?.find((row) => String(row.githubPrNumber) === e.target.value);
                onChange({
                  ...event,
                  pr: pr
                    ? {
                      number: pr.githubPrNumber,
                      title: pr.title,
                      url: pr.githubUrl,
                      repo: `${pr.repoOwner}/${pr.repoName}`,
                      headBranch: pr.headBranch,
                      baseBranch: pr.baseBranch,
                      draft: pr.state === "draft",
                    }
                    : null,
                });
              }}
            >
              <option value="">{prs ? "Choose an open PR" : "Loading PRs…"}</option>
              {(prs ?? []).map((pr) => (
                <option key={pr.id} value={pr.githubPrNumber}>#{pr.githubPrNumber} {pr.title}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className={labelCls}>Or number</span>
            <input
              className={inputCls}
              inputMode="numeric"
              placeholder="1542"
              value={event.pr?.number ? String(event.pr.number) : ""}
              onChange={(e) => {
                const number = Number.parseInt(e.target.value, 10);
                onChange({ ...event, pr: Number.isFinite(number) && number > 0 ? { number, title: "" } : null });
              }}
            />
          </label>
        </div>
      ) : null}
      {source === "issue" ? (
        <div className="grid grid-cols-[120px_1fr] gap-2">
          <label className="block space-y-1">
            <span className={labelCls}>Issue number</span>
            <input
              className={inputCls}
              inputMode="numeric"
              placeholder="42"
              value={event.issue?.number ? String(event.issue.number) : ""}
              onChange={(e) => {
                const number = Number.parseInt(e.target.value, 10);
                onChange({ ...event, issue: Number.isFinite(number) && number > 0 ? { number, title: event.issue?.title ?? "" } : null });
              }}
            />
          </label>
          <label className="block space-y-1">
            <span className={labelCls}>Title</span>
            <input
              className={inputCls}
              placeholder="The issue's title"
              value={event.issue?.title ?? ""}
              disabled={!event.issue?.number}
              onChange={(e) => event.issue && onChange({ ...event, issue: { ...event.issue, title: e.target.value } })}
            />
          </label>
        </div>
      ) : null}
      {source === "linear" ? (
        <div className="grid grid-cols-[120px_1fr] gap-2">
          <label className="block space-y-1">
            <span className={labelCls}>Linear issue</span>
            <input
              className={inputCls}
              placeholder="ADE-171"
              value={event.linearIssue?.id ?? ""}
              onChange={(e) => onChange({ ...event, linearIssue: e.target.value.trim() ? { ...event.linearIssue, id: e.target.value.trim() } : null })}
            />
          </label>
          <label className="block space-y-1">
            <span className={labelCls}>Title</span>
            <input
              className={inputCls}
              placeholder="The issue's title"
              value={event.linearIssue?.title ?? ""}
              disabled={!event.linearIssue?.id}
              onChange={(e) => event.linearIssue && onChange({ ...event, linearIssue: { ...event.linearIssue, title: e.target.value } })}
            />
          </label>
        </div>
      ) : null}
      {source === "chat" ? (
        <label className="block space-y-1">
          <span className={labelCls}>Chat</span>
          <select
            className={selectCls}
            value={event.sessionId ?? ""}
            onChange={(e) => {
              const chat = chats?.find((row) => row.id === e.target.value);
              onChange({ ...event, sessionId: chat?.id ?? null, laneId: chat?.laneId ?? null });
            }}
          >
            <option value="">{chats ? "Choose a chat" : "Loading chats…"}</option>
            {(chats ?? []).map((chat) => (
              <option key={chat.id} value={chat.id}>{chat.title || "Untitled chat"}{chat.laneName ? ` · ${chat.laneName}` : ""}</option>
            ))}
          </select>
        </label>
      ) : null}
      {source === "webhook" ? (
        <label className="block space-y-1">
          <span className={labelCls}>Request</span>
          <select className={selectCls} defaultValue="" onChange={(e) => pickDelivery(e.target.value)}>
            <option value="">{deliveries == null && hookId ? "Loading requests…" : "An empty request"}</option>
            {(deliveries ?? []).map((delivery) => (
              <option key={delivery.id} value={delivery.id}>
                {delivery.eventLabel ?? delivery.method} · {new Date(delivery.receivedAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {source === "lane" || needsLane ? laneSelect(source === "lane" ? "Lane" : "Lane it runs in") : null}
      {source === "none" && !needsLane ? (
        <p className="text-[11px] text-muted-fg/70">This trigger has no event to pick. The test runs as if it fired now.</p>
      ) : null}
      {loadError ? <p className="text-[11px] text-red-300">{loadError}</p> : null}
    </div>
  );
}

const EFFECT_TAG: Record<AutomationTestPlan["steps"][number]["effect"], { label: string; tone?: "ok" | "warn" }> = {
  runs: { label: "Runs" },
  labeled: { label: "Marked [Test]", tone: "warn" },
  "would-run": { label: "Only reported", tone: "ok" },
};

function TestPlanView({ plan, kind }: { plan: AutomationTestPlan; kind: TestKind }) {
  return (
    <div className="space-y-3" data-testid="automation-test-plan">
      <div className="space-y-1">
        <div className="kit-eyebrow">Event</div>
        <div className="text-[12px] text-fg/90">{plan.event}</div>
      </div>
      <div className="space-y-1">
        <div className="kit-eyebrow">Where it works</div>
        <div className="text-[12px] text-fg/90">{plan.lane}</div>
      </div>
      <div className="space-y-1">
        <div className="kit-eyebrow">Steps</div>
        <ol className="space-y-1.5">
          {plan.steps.map((step) => {
            const tag = kind === "preview" ? null : EFFECT_TAG[step.effect];
            return (
              <li key={step.index} className="rounded-md border border-fg/[0.06] bg-fg/[0.02] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="kit-num text-[10.5px] text-muted-fg/60">{step.index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">{step.title}</span>
                  {step.alwaysRun ? <span className="kit-tag">Always runs</span> : null}
                  {tag ? <span className="kit-tag" data-tone={tag.tone}>{tag.label}</span> : null}
                </div>
                {step.detail ? (
                  <div className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-fg/80">{step.detail}</div>
                ) : null}
                {step.note && kind !== "preview" ? <div className="mt-1 text-[11px] text-muted-fg/60">{step.note}</div> : null}
              </li>
            );
          })}
        </ol>
      </div>
      {kind !== "preview" && plan.afterwards.length ? (
        <div className="space-y-1">
          <div className="kit-eyebrow">Afterwards</div>
          <ul className="space-y-0.5 text-[11.5px] text-fg/80">
            {plan.afterwards.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Shows the plan for a picked event, then starts the test. */
export function TestRunDialog({
  open,
  kind: initialKind,
  ruleId,
  ruleName,
  trigger,
  laneMode,
  pin,
  saveFirstReason,
  onClose,
  onStarted,
}: {
  open: boolean;
  kind: TestKind;
  ruleId: string;
  ruleName: string;
  trigger: AutomationTrigger;
  laneMode: string | null;
  /** The machine the rule is saved to. */
  pin: OpenProjectBinding | null;
  /** Why the test cannot start now (unsaved changes, machine offline). */
  saveFirstReason: string | null;
  onClose: () => void;
  onStarted: (run: AutomationRun) => void;
}) {
  const [kind, setKind] = useState<TestKind>(initialKind);
  const [event, setEvent] = useState<AutomationTestEvent>({});
  const [plan, setPlan] = useState<AutomationTestPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => { if (open) setKind(initialKind); }, [initialKind, open]);

  // A preview shows the real run, so it asks for the live plan.
  const planMode: AutomationTestRunMode = kind === "safe" ? "safe" : "live";
  const eventKey = useMemo(() => JSON.stringify(event), [event]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPlanError(null);
    const timer = window.setTimeout(() => {
      void window.ade.automations.planTest({ id: ruleId, mode: planMode, event }, pin)
        .then((next) => { if (!cancelled) setPlan(next); })
        .catch((err: unknown) => { if (!cancelled) { setPlan(null); setPlanError(errorText(err)); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `eventKey` stands for `event`.
  }, [eventKey, open, pin, planMode, ruleId]);

  const start = async () => {
    if (kind === "preview") return;
    if (kind === "live") {
      const ok = await confirmDialog({
        title: `Run "${ruleName}" for real?`,
        message: "A live test does everything a real run does: it can push, comment, and post. Notifications say [Test].",
        confirmLabel: "Run live test",
        destructive: true,
      });
      if (!ok) return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const run = await window.ade.automations.runTest({ id: ruleId, mode: kind, event }, pin);
      onStarted(run);
    } catch (err) {
      setStartError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const problems = plan?.problems ?? [];
  const blocked = saveFirstReason ?? (problems.length ? problems[0]! : null);
  const runLabel = kind === "live" ? "Run live test" : "Run safe test";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && !starting) onClose(); }}
      title={`Test "${ruleName}"`}
      description={TEST_KINDS.find((entry) => entry.kind === kind)?.hint}
      icon={<Flask size={16} weight="regular" />}
      size="lg"
      dismissible={!starting}
      testId="automation-test-dialog"
      actions={kind === "preview"
        ? [{ label: "Close", onClick: onClose, variant: "secondary" }]
        : [
          {
            label: runLabel,
            onClick: () => void start(),
            variant: "solid",
            disabled: Boolean(blocked) || loading || !plan,
            busy: starting,
          },
          { label: "Cancel", onClick: onClose, variant: "secondary" },
        ]}
      footerStart={kind !== "preview" && blocked ? <span className="text-[11px] text-muted-fg/70">{blocked}</span> : null}
    >
      <div className="space-y-4">
        <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label="Kind of test">
          {TEST_KINDS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="radio"
              aria-checked={kind === entry.kind}
              title={entry.hint}
              onClick={() => setKind(entry.kind)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {saveFirstReason && kind !== "preview" ? (
          <Banner layout="inline" model={{ id: "automation-test-save-first", tone: "info", title: saveFirstReason }} />
        ) : null}
        <TestEventPicker
          trigger={trigger}
          needsLane={laneMode === "require-on-trigger"}
          pin={pin}
          event={event}
          onChange={setEvent}
        />
        {problems.length ? (
          <Banner
            layout="inline"
            model={{ id: "automation-test-problems", tone: "warning", title: problems[0]!, detail: problems.slice(1).join(" ") || undefined }}
          />
        ) : null}
        {plan?.warnings.length ? (
          <ul className="space-y-0.5 text-[11px] text-amber-200/90">
            {plan.warnings.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
        {planError ? <Banner layout="inline" model={{ id: "automation-test-plan-error", tone: "error", title: "Could not build the test plan.", detail: planError }} /> : null}
        {startError ? <Banner layout="inline" model={{ id: "automation-test-start-error", tone: "error", title: "The test did not start.", detail: startError }} /> : null}
        {plan ? <TestPlanView plan={plan} kind={kind} /> : loading ? <p className="text-[11px] text-muted-fg/60">Building the plan…</p> : null}
      </div>
    </Dialog>
  );
}
