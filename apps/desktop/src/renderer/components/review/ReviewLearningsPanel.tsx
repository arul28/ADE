import React from "react";
import {
  ArrowClockwise,
  Brain,
  ChartLine,
  Shield,
  Trash,
  X,
} from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";
import type { ReviewQualityReport, ReviewSuppression } from "./reviewTypes";
import {
  deleteReviewSuppression,
  fetchReviewQualityReport,
  listReviewSuppressions,
  onReviewEvent,
} from "./reviewApi";

const SCOPE_LABEL: Record<ReviewSuppression["scope"], string> = {
  repo: "Repo",
  path: "Path",
  global: "Global",
};

function toReasonLabel(reason: ReviewSuppression["reason"]): string {
  if (!reason) return "—";
  return reason.replaceAll("_", " ");
}

function relativeTime(value: string | null): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  const diffMs = Date.now() - ts;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function QualityMetric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={cn("rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2", tone)}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#6E7F92]">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-[#F5FAFF]">{value}</div>
    </div>
  );
}

export function ReviewLearningsPanel({
  onClose,
}: {
  onClose?: () => void;
}) {
  const [suppressions, setSuppressions] = React.useState<ReviewSuppression[] | null>(null);
  const [report, setReport] = React.useState<ReviewQualityReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, quality] = await Promise.all([
        listReviewSuppressions({ limit: 100 }),
        fetchReviewQualityReport(),
      ]);
      setSuppressions(list);
      setReport(quality);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load learnings");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    const unsub = onReviewEvent((event) => {
      if (event.type === "suppressions-updated" || event.type === "feedback-updated") {
        void refresh();
      }
    });
    return () => {
      try { unsub(); } catch { /* ignore */ }
    };
  }, [refresh]);

  const handleRemove = React.useCallback(async (suppressionId: string) => {
    try {
      await deleteReviewSuppression(suppressionId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove suppression");
    }
  }, [refresh]);

  const totalNoisy = (report?.dismissedCount ?? 0) + (report?.suppressedCount ?? 0);
  const noisePct = report ? Math.round((report.noiseRate ?? 0) * 100) : 0;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#08111C]">
      <header className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-violet-200" />
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[#6E7F92]">Review learnings</div>
            <div className="text-sm font-semibold text-[#F5FAFF]">Suppressions & quality</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
            <ArrowClockwise size={12} />
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-[#93A4B8] hover:bg-white/[0.06]"
              aria-label="Close learnings panel"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-500/20 bg-red-500/[0.08] px-4 py-2 text-xs text-red-200">{error}</div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-5 p-4">
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[#6E7F92]">
              <ChartLine size={11} /> quality over time
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <QualityMetric label="Runs" value={report?.totalRuns ?? "—"} />
              <QualityMetric label="Findings" value={report?.totalFindings ?? "—"} />
              <QualityMetric label="Addressed" value={report?.addressedCount ?? "—"} tone="border-emerald-400/20 bg-emerald-400/[0.05]" />
              <QualityMetric
                label="Noise"
                value={report ? `${noisePct}%` : "—"}
                tone={noisePct > 40 ? "border-amber-400/30 bg-amber-400/[0.08]" : "border-white/[0.06] bg-white/[0.03]"}
              />
              <QualityMetric label="Published" value={report?.publishedCount ?? "—"} />
              <QualityMetric label="Dismissed" value={report?.dismissedCount ?? "—"} />
              <QualityMetric label="Snoozed" value={report?.snoozedCount ?? "—"} />
              <QualityMetric label="Suppressed" value={report?.suppressedCount ?? "—"} tone="border-violet-400/20 bg-violet-400/[0.06]" />
            </div>
            {report?.byClass.length ? (
              <div className="space-y-1.5 pt-2">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#6E7F92]">By finding class</div>
                <div className="flex flex-wrap gap-1.5">
                  {report.byClass.map((row) => {
                    const pct = row.total > 0 ? Math.round((row.addressed / row.total) * 100) : 0;
                    return (
                      <Chip key={row.findingClass} className="text-[10px]">
                        <span className="font-mono uppercase">{row.findingClass}</span>
                        <span className="text-[#93A4B8]">{row.total} · {pct}% addressed</span>
                      </Chip>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <p className="text-[10px] leading-relaxed text-[#6E7F92]">
              Noise = dismissed + suppressed over total findings. {totalNoisy > 0 && report?.totalFindings ? (
                <>That's {totalNoisy} of {report.totalFindings} findings the team didn't action.</>
              ) : null}
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[#6E7F92]">
              <Shield size={11} /> active suppressions {suppressions?.length ? `(${suppressions.length})` : ""}
            </div>
            {suppressions == null ? (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">Loading…</div>
            ) : suppressions.length === 0 ? (
              <EmptyState
                icon={Shield}
                title="No suppressions yet"
                description="Use the Suppress action on noisy findings to teach the engine. Suppressions persist across runs and are matched semantically via embeddings."
              />
            ) : (
              <div className="space-y-1.5">
                {suppressions.map((sup) => (
                  <div
                    key={sup.id}
                    className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Chip className="text-[9px] border-violet-400/25 bg-violet-400/[0.08] text-violet-200">
                          {SCOPE_LABEL[sup.scope]}
                        </Chip>
                        {sup.findingClass ? (
                          <Chip className="text-[9px]">{sup.findingClass.replaceAll("_", " ")}</Chip>
                        ) : null}
                        {sup.severity ? <Chip className="text-[9px]">{sup.severity}</Chip> : null}
                        <Chip className="text-[9px]">{toReasonLabel(sup.reason)}</Chip>
                        {sup.hitCount > 0 ? (
                          <Chip className="text-[9px] border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200">
                            filtered {sup.hitCount}×
                          </Chip>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-sm font-medium text-[#F5FAFF]">{sup.title}</div>
                      {sup.pathPattern ? (
                        <div className="mt-0.5 truncate font-mono text-[10px] text-[#93A4B8]">{sup.pathPattern}</div>
                      ) : null}
                      {sup.note ? (
                        <div className="mt-1 text-xs leading-relaxed text-[#B7C4D7]">{sup.note}</div>
                      ) : null}
                      <div className="mt-1 text-[10px] text-[#6E7F92]">
                        added {relativeTime(sup.createdAt)}
                        {sup.lastMatchedAt ? ` · last match ${relativeTime(sup.lastMatchedAt)}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRemove(sup.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-[#B7C4D7] hover:border-red-400/40 hover:bg-red-400/[0.08] hover:text-red-200"
                    >
                      <Trash size={10} /> remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {report?.recentFeedback?.length ? (
            <section className="space-y-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[#6E7F92]">Recent feedback</div>
              <div className="space-y-1.5">
                {report.recentFeedback.slice(0, 8).map((fb) => (
                  <div key={fb.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[11px] text-[#B7C4D7]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono uppercase tracking-[0.1em] text-[#93A4B8]">{fb.kind}</span>
                      {fb.reason ? <Chip className="text-[9px]">{fb.reason.replaceAll("_", " ")}</Chip> : null}
                      <span className="ml-auto text-[10px] text-[#6E7F92]">{relativeTime(fb.createdAt)}</span>
                    </div>
                    {fb.note ? <div className="mt-0.5 text-[#CBD5E1]">{fb.note}</div> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}
