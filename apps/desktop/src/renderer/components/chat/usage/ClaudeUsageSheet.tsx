/**
 * `/usage` in a Claude chat: Claude Code's own usage report as a side sheet.
 *
 * Three cards, in the order a person asks the questions: how much plan is left
 * (Plan limits), what this chat has cost (This session), and what is eating
 * the plan and what to change (What's using it). The last one comes from a
 * scan of this computer's Claude transcripts, which is slow, so the sheet
 * paints the first two at once and fills it in when the scan answers.
 *
 * Everything is read through the chat's runtime pin: the report comes from
 * the machine the chat runs on, and so does the Fix.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ChartBar, Gauge, Lightning, Receipt } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import {
  planClaudeUsageFix,
  type ClaudeUsageBehaviorWindow,
  type ClaudeUsageLimitWindow,
  type ClaudeUsageReport,
} from "../../../../shared/claudeUsageReport";
import { resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { modelMentionEffortLabel } from "../../../../shared/modelMentions";
import { extractError, formatDurationMs, formatSpend } from "../../../lib/format";
import { Dialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { useAgentChatApi } from "../agentChatApi";
import { showToast } from "../../app/toast/toastStore";
import { ClaudeLogo } from "../../terminals/ToolLogos";
import { usageLeftLevel } from "../../usage/usageDesign";
import { formatResetIn } from "../../usage/usageWindowFormat";
import { abbreviateTokenCount } from "../../../../shared/contextCompaction";
import "./claudeUsageSheet.css";

type Range = "day" | "week";

const PLAN_LABELS: Record<string, string> = {
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
};

function modelName(model: string): string {
  return resolveModelDescriptor(model)?.displayName ?? model;
}

function LimitRow({ limit, nowMs }: { limit: ClaudeUsageLimitWindow; nowMs: number }) {
  const left = limit.usedPercent == null ? null : Math.max(0, 100 - limit.usedPercent);
  const reset = limit.resetsAt ? formatResetIn(limit.resetsAt, nowMs) : "";
  return (
    <div className="ade-cu-limit">
      <div className="ade-cu-limit-line">
        <span className="ade-cu-limit-label">{limit.label}</span>
        <span className="ade-cu-limit-left kit-num">{left == null ? "—" : `${Math.round(left)}% left`}</span>
      </div>
      <span className="kit-meter" data-level={left == null ? undefined : usageLeftLevel(left)}>
        <span style={{ width: `${left ?? 0}%` }} />
      </span>
      {reset ? <span className="ade-cu-limit-reset">{reset.charAt(0).toUpperCase() + reset.slice(1)}</span> : null}
    </div>
  );
}

function SourceChips({ window }: { window: ClaudeUsageBehaviorWindow }) {
  const groups: Array<[string, Array<{ name: string; pct: number }>]> = [
    ["Agents", window.sources.agents],
    ["Skills", window.sources.skills],
    ["Plugins", window.sources.plugins],
    ["MCP servers", window.sources.mcpServers],
  ];
  const shown = groups.filter(([, items]) => items.length > 0);
  if (!shown.length) return null;
  return (
    <div className="ade-cu-sources">
      {shown.map(([label, items]) => (
        <div key={label} className="ade-cu-source-group">
          <span className="kit-eyebrow">{label}</span>
          <div className="ade-cu-source-list">
            {items.slice(0, 4).map((item) => (
              <span key={item.name} className="kit-legend" title={`${item.name}: ${Math.round(item.pct)}% of local usage`}>
                {item.name}
                <b>{Math.round(item.pct)}%</b>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Memoized: it sits under the chat pane, which re-renders many times per chat
 * switch, and a closed sheet with the same props has nothing to redraw.
 */
export const ClaudeUsageSheet = memo(function ClaudeUsageSheet({
  open,
  onOpenChange,
  sessionId,
  pin,
  turnActive,
  onApplyEffort,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  pin: OpenProjectBinding | null;
  /** A turn is running: the Fix queues its messages behind it. */
  turnActive: boolean;
  /** Set the chat's effort through the composer's own control, so the picker stays true. */
  onApplyEffort: (level: string) => void;
}) {
  const [report, setReport] = useState<ClaudeUsageReport | null>(null);
  const [behaviors, setBehaviors] = useState<ClaudeUsageReport["behaviors"] | undefined>(undefined);
  /** The transcript scan failed; distinct from `behaviors: null`, which means no plan to scan. */
  const [behaviorsError, setBehaviorsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<Range>("week");
  const [fixing, setFixing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestRef = useRef(0);
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  // The chat surface's own API (personal chats refuse `/usage`), not window.ade.
  const agentChatApi = useAgentChatApi();
  const apiRef = useRef(agentChatApi);
  apiRef.current = agentChatApi;

  const load = useCallback(() => {
    const request = ++requestRef.current;
    const api = apiRef.current;
    setLoading(true);
    setError(null);
    setBehaviorsError(null);
    // Another chat's (or an older) report must not show under this one.
    setReport(null);
    setNowMs(Date.now());
    // Limits first (no transcript scan), then the scan for "What's using it".
    void api.getClaudeUsage({ sessionId, skipBehaviors: true }, pinRef.current)
      .then((quick) => {
        if (request !== requestRef.current) return;
        setReport(quick);
      })
      .catch((loadError: unknown) => {
        if (request !== requestRef.current) return;
        setError(extractError(loadError));
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
    setBehaviors(undefined);
    void api.getClaudeUsage({ sessionId }, pinRef.current)
      .then((full) => {
        if (request !== requestRef.current) return;
        setReport(full);
        setBehaviors(full.behaviors);
        setError(null);
      })
      .catch((scanError: unknown) => {
        if (request !== requestRef.current) return;
        setBehaviors(null);
        setBehaviorsError(extractError(scanError));
      });
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [open, load, pinKey]);

  const windowData = behaviors ? behaviors[range] ?? null : null;
  const fixPlan = useMemo(
    () => (windowData?.fix ? planClaudeUsageFix(windowData.fix.messages) : null),
    [windowData],
  );

  const applyFix = useCallback(async () => {
    if (!fixPlan) return;
    setFixing(true);
    try {
      if (fixPlan.effort) onApplyEffort(fixPlan.effort);
      const api = apiRef.current;
      let queueBehindTurn = turnActive;
      for (const text of fixPlan.messages) {
        // A running turn (or the Fix's own first message) is still going, so
        // the rest wait in the queue rather than steering it.
        if (queueBehindTurn) {
          const steered = await api.steer({ sessionId, text }, pinRef.current);
          if (steered.reason === "queue_full") {
            throw new Error("This chat's queue is full. Send the rest when the queue clears.");
          }
        } else {
          await api.send({ sessionId, text }, pinRef.current);
        }
        queueBehindTurn = true;
      }
      showToast({
        id: `claude-usage-fix:${sessionId}`,
        tone: "success",
        title: "Usage fixes applied",
        message: fixPlan.messages.length
          ? "Claude is working through the rest in this chat."
          : "Effort changed for this chat.",
      });
      onOpenChange(false);
    } catch (fixError) {
      setError(extractError(fixError));
    } finally {
      setFixing(false);
    }
  }, [fixPlan, onApplyEffort, onOpenChange, sessionId, turnActive]);

  const plan = report?.subscriptionType ? PLAN_LABELS[report.subscriptionType] ?? report.subscriptionType : null;
  const session = report?.session ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Claude usage"
      titleContent={(
        <span className="ade-cu-title">
          <ClaudeLogo size={16} />
          Claude usage
          {plan ? <span className="kit-tag">{plan}</span> : null}
        </span>
      )}
      placement="right"
      width={440}
      preventAutoFocus
      testId="claude-usage-sheet"
    >
      <div className="ade-cu-body">
        {error ? (
          <Banner
            layout="inline"
            model={{
              id: "claude-usage-error",
              tone: "error",
              title: error,
              report: { surface: "claude_usage_sheet" },
              dismiss: { onDismiss: () => setError(null) },
            }}
          />
        ) : null}

        <section className="kit-card">
          <header className="kit-card-head">
            <Gauge size={14} />
            Plan limits
            <button
              type="button"
              className="kit-card-head-action"
              aria-label="Refresh usage"
              disabled={loading}
              onClick={load}
            >
              <ArrowClockwise size={12} />
              Refresh
            </button>
          </header>
          <div className="kit-card-body ade-cu-limits">
            {!report ? (
              <span className="ade-cu-muted">{loading ? "Loading…" : "No usage yet."}</span>
            ) : report.limitsAvailable ? (
              <>
                {report.limits.map((limit) => <LimitRow key={limit.key} limit={limit} nowMs={nowMs} />)}
                {report.extraUsage?.enabled && report.extraUsage.monthlyLimit ? (
                  <div className="ade-cu-limit">
                    <div className="ade-cu-limit-line">
                      <span className="ade-cu-limit-label">Extra usage this month</span>
                      <span className="ade-cu-limit-left kit-num">
                        {`${formatSpend(report.extraUsage.usedCredits ?? 0)} of ${formatSpend(report.extraUsage.monthlyLimit)}`}
                      </span>
                    </div>
                    <span className="kit-meter">
                      <span style={{ width: `${report.extraUsage.usedPercent ?? 0}%` }} />
                    </span>
                  </div>
                ) : null}
              </>
            ) : (
              <span className="ade-cu-muted">Plan limits don't apply to this sign-in.</span>
            )}
          </div>
        </section>

        <section className="kit-card">
          <header className="kit-card-head">
            <Receipt size={14} />
            This session
          </header>
          <div className="kit-card-body">
            {session ? (
              <>
                <div className="ade-cu-stats">
                  <div>
                    <span className="kit-eyebrow">Cost</span>
                    <div className="kit-stat">{formatSpend(session.costUsd)}</div>
                  </div>
                  <div>
                    <span className="kit-eyebrow">Code</span>
                    <div className="ade-cu-stat-sm kit-num">
                      <span className="ade-cu-added">+{session.linesAdded}</span>
                      {" "}
                      <span className="ade-cu-removed">−{session.linesRemoved}</span>
                    </div>
                  </div>
                  <div>
                    <span className="kit-eyebrow">API time</span>
                    <div className="ade-cu-stat-sm kit-num">{formatDurationMs(session.apiDurationMs)}</div>
                  </div>
                </div>
                {session.models.length ? (
                  <div className="ade-cu-models">
                    {session.models.map((row) => (
                      <div key={row.model} className="ade-cu-model">
                        <span className="ade-cu-model-name" title={row.model}>{modelName(row.model)}</span>
                        <span
                          className="ade-cu-model-tokens kit-num"
                          title={`${row.inputTokens.toLocaleString()} in · ${row.outputTokens.toLocaleString()} out · ${row.cacheReadTokens.toLocaleString()} cache read · ${row.cacheWriteTokens.toLocaleString()} cache write`}
                        >
                          {`${abbreviateTokenCount(row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens)} in · ${abbreviateTokenCount(row.outputTokens)} out`}
                        </span>
                        <span className="ade-cu-model-cost kit-num">{formatSpend(row.costUsd)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <span className="ade-cu-muted">{loading ? "Loading…" : "Nothing yet."}</span>
            )}
          </div>
        </section>

        <section className="kit-card">
          <header className="kit-card-head">
            <ChartBar size={14} />
            What's using it
            <div className="kit-seg ade-cu-period" role="group" aria-label="Period">
              <button type="button" aria-pressed={range === "day"} onClick={() => setRange("day")}>Today</button>
              <button type="button" aria-pressed={range === "week"} onClick={() => setRange("week")}>7 days</button>
            </div>
          </header>
          <div className="kit-card-body">
            {behaviors === undefined ? (
              <span className="ade-cu-muted">Reading this computer's Claude sessions…</span>
            ) : !windowData ? (
              <span className="ade-cu-muted">
                {behaviorsError
                  ? "Couldn't read what is using your plan. Refresh to try again."
                  : behaviors === null ? "Only shown for a Claude plan sign-in." : "Nothing recorded in this period."}
              </span>
            ) : (
              <>
                <span className="ade-cu-scope">
                  {`${windowData.requestCount.toLocaleString()} requests in ${windowData.sessionCount.toLocaleString()} sessions on this computer`}
                </span>
                {windowData.recommendations.length ? (
                  <ol className="ade-cu-recs">
                    {windowData.recommendations.map((rec) => (
                      <li key={`${rec.key}:${rec.title}`} className="ade-cu-rec">
                        <span className="kit-tag ade-cu-rec-pct">{`${Math.round(rec.pct)}%`}</span>
                        <div className="ade-cu-rec-text">
                          <span className="ade-cu-rec-title">{rec.title}</span>
                          {rec.detail ? <span className="ade-cu-rec-detail">{rec.detail}</span> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <span className="ade-cu-muted">No changes to suggest.</span>
                )}
                <SourceChips window={windowData} />
                {fixPlan && (fixPlan.effort || fixPlan.messages.length) ? (
                  <div className="ade-cu-fix">
                    <span className="kit-eyebrow">Fix does</span>
                    <ul className="ade-cu-fix-list">
                      {fixPlan.effort ? (
                        <li>{`Sets this chat's effort to ${modelMentionEffortLabel(fixPlan.effort)}`}</li>
                      ) : null}
                      {fixPlan.messages.map((message) => (
                        <li key={message} className="ade-cu-fix-message" title={message}>
                          {turnActive ? "Queues: " : "Sends: "}
                          <q>{message}</q>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="kit-btn kit-btn-primary"
                      data-size="sm"
                      disabled={fixing}
                      onClick={() => { void applyFix(); }}
                    >
                      <Lightning size={13} />
                      {fixing ? "Applying…" : "Fix"}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      </div>
    </Dialog>
  );
});
