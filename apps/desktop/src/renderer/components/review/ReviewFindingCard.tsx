import React from "react";
import {
  ArrowSquareOut,
  BellSimpleSlash,
  CaretDown,
  CaretRight,
  CheckCircle,
  FileText,
  MagnifyingGlass,
  Prohibit,
  Shield,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import type {
  ReviewDiffContext,
  ReviewDismissReason,
  ReviewEvidence,
  ReviewFeedbackKind,
  ReviewFeedbackRecord,
  ReviewFinding,
  ReviewFindingClass,
  ReviewFindingSuppressionMatch,
  ReviewSuppressionScope,
} from "./reviewTypes";

export type FindingActionRequest = {
  finding: ReviewFinding;
  kind: ReviewFeedbackKind;
  reason?: ReviewDismissReason | null;
  note?: string | null;
  snoozeDurationMs?: number | null;
  suppression?: { scope: ReviewSuppressionScope; pathPattern?: string | null } | null;
};

type ReviewFindingCardProps = {
  finding: ReviewFinding;
  onRequestAction: (request: FindingActionRequest) => Promise<void> | void;
  onOpenInFiles?: (finding: ReviewFinding) => void;
  onOpenInEditor?: (finding: ReviewFinding) => void;
  disabled?: boolean;
};

const FINDING_CLASS_DESCRIPTION: Record<ReviewFindingClass, string> = {
  intent_drift: "Implementation may diverge from the stated goal or prompt for this lane.",
  incomplete_rollout: "Only part of a cross-surface change landed — check paired files.",
  late_stage_regression: "A risky change appeared after a failed validation or late fix cycle.",
};

const PASS_LABEL: Record<string, string> = {
  "diff-risk": "Diff risk",
  "cross-file-impact": "Cross-file",
  "checks-and-tests": "Tests + CI",
};

function toSeverityTone(severity: string): string {
  const n = severity.toLowerCase();
  if (n.includes("crit")) return "border-red-400/30 bg-red-400/[0.12] text-red-200";
  if (n.includes("high")) return "border-orange-400/30 bg-orange-400/[0.12] text-orange-200";
  if (n.includes("medium")) return "border-amber-400/30 bg-amber-400/[0.12] text-amber-200";
  if (n.includes("low")) return "border-sky-400/30 bg-sky-400/[0.12] text-sky-200";
  return "border-zinc-400/25 bg-zinc-400/[0.10] text-zinc-200";
}

function toFindingClassTone(value: ReviewFindingClass | null | undefined): string {
  if (value === "intent_drift") return "border-fuchsia-400/30 bg-fuchsia-400/[0.12] text-fuchsia-200";
  if (value === "incomplete_rollout") return "border-cyan-400/30 bg-cyan-400/[0.12] text-cyan-200";
  if (value === "late_stage_regression") return "border-rose-400/30 bg-rose-400/[0.12] text-rose-200";
  return "border-zinc-400/25 bg-zinc-400/[0.10] text-zinc-200";
}

function toFindingClassLabel(value: ReviewFindingClass | null | undefined): string {
  if (!value) return "general";
  return value.replaceAll("_", " ");
}

function formatConfidence(value: number | string): string {
  if (typeof value === "number") {
    if (value <= 1) return `${Math.round(value * 100)}%`;
    return `${Math.round(value)}%`;
  }
  return value;
}

function describeSuppression(match: ReviewFindingSuppressionMatch | null | undefined): string | null {
  if (!match) return null;
  const pct = Math.round((match.similarity ?? 0) * 100);
  const reasonLabel = match.reason ? `(${match.reason.replaceAll("_", " ")})` : "";
  return `Filtered by ${match.scope} suppression · ${pct}% match ${reasonLabel}`.trim();
}

function describeFeedback(record: ReviewFeedbackRecord | null | undefined): { label: string; tone: string } | null {
  if (!record) return null;
  switch (record.kind) {
    case "acknowledge":
      return { label: "Acknowledged", tone: "border-emerald-400/30 bg-emerald-400/[0.10] text-emerald-200" };
    case "dismiss":
      return {
        label: `Dismissed${record.reason ? ` · ${record.reason.replaceAll("_", " ")}` : ""}`,
        tone: "border-zinc-500/25 bg-zinc-500/[0.12] text-zinc-200",
      };
    case "snooze": {
      const until = record.snoozeUntil ? new Date(record.snoozeUntil).toLocaleDateString() : "later";
      return { label: `Snoozed until ${until}`, tone: "border-amber-400/30 bg-amber-400/[0.10] text-amber-200" };
    }
    case "suppress":
      return {
        label: `Suppressed${record.reason ? ` · ${record.reason.replaceAll("_", " ")}` : ""}`,
        tone: "border-violet-400/30 bg-violet-400/[0.10] text-violet-200",
      };
    default:
      return null;
  }
}

function DiffContextBlock({ context }: { context: ReviewDiffContext | null | undefined }) {
  if (!context || context.lines.length === 0) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-black/20 p-3 text-[11px] text-[#94A3B8]">
        No inline diff excerpt available for this finding.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-black/30">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
        <span className="truncate text-[11px] text-[#93A4B8]">{context.filePath}</span>
        <span className="text-[10px] text-[#6E7F92]">
          L{context.startLine}–{context.endLine}
          {context.anchoredLine ? ` · focus L${context.anchoredLine}` : ""}
        </span>
      </div>
      <pre className="overflow-x-auto px-0 py-1 text-[11px] leading-[1.45]">
        {context.lines.map((line, idx) => {
          const base = "flex gap-2 px-3";
          const lineColor = line.kind === "add"
            ? "bg-emerald-400/[0.08] text-emerald-100"
            : line.kind === "del"
              ? "bg-red-400/[0.08] text-red-100"
              : line.kind === "meta"
                ? "bg-white/[0.02] text-[#6E7F92] italic"
                : line.highlighted
                  ? "bg-amber-400/[0.12] text-amber-100"
                  : "text-[#CBD5E1]";
          const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "meta" ? "@" : " ";
          return (
            <span
              key={`${line.line ?? "x"}-${idx}`}
              className={cn(base, lineColor, line.highlighted ? "border-l-2 border-amber-400/70" : "border-l-2 border-transparent")}
            >
              <span className="w-10 shrink-0 text-right font-mono text-[#4B5B71]">{line.line ?? ""}</span>
              <span className="w-3 shrink-0 font-mono text-[#6E7F92]">{marker}</span>
              <span className="whitespace-pre font-mono text-[11px]">{line.text || " "}</span>
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function ToolSignalBlock({ evidence }: { evidence: ReviewEvidence[] }) {
  const toolSignals = evidence.filter((entry) => entry.kind === "tool_signal" && entry.toolSignal);
  if (toolSignals.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {toolSignals.map((entry, idx) => {
        const sig = entry.toolSignal!;
        const tone = sig.status === "fail"
          ? "border-red-400/30 bg-red-400/[0.10] text-red-200"
          : sig.status === "warn"
            ? "border-amber-400/30 bg-amber-400/[0.10] text-amber-200"
            : "border-sky-400/25 bg-sky-400/[0.08] text-sky-200";
        return (
          <div
            key={`${sig.source}-${idx}`}
            className={cn("rounded-lg border p-2 text-[11px]", tone)}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono uppercase tracking-[0.08em]">{sig.kind.replaceAll("_", " ")}</span>
              <span className="truncate">{entry.summary}</span>
            </div>
            {entry.quote ? (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                {entry.quote}
              </pre>
            ) : null}
            {sig.source && !entry.quote ? (
              <div className="mt-1 text-[10px] text-[#8FA1B8]">source · {sig.source}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type DismissModalProps = {
  open: boolean;
  initialKind: Exclude<ReviewFeedbackKind, "acknowledge">;
  finding: ReviewFinding;
  onClose: () => void;
  onSubmit: (args: {
    kind: Exclude<ReviewFeedbackKind, "acknowledge">;
    reason: ReviewDismissReason;
    note: string;
    snoozeDurationMs: number | null;
    suppressionScope?: ReviewSuppressionScope;
  }) => Promise<void> | void;
};

const DISMISS_REASONS: Array<{ value: ReviewDismissReason; label: string; hint: string }> = [
  { value: "not_a_bug", label: "Not a bug", hint: "The flagged behavior is intentional or already correct." },
  { value: "out_of_scope", label: "Out of scope", hint: "True but belongs in a different PR or project." },
  { value: "style_only", label: "Style only", hint: "Stylistic nit handled elsewhere (linter, formatter)." },
  { value: "duplicate", label: "Duplicate", hint: "Same issue already flagged by another finding or tool." },
  { value: "wont_fix", label: "Won't fix", hint: "Known limitation we are deliberately not addressing." },
  { value: "low_value_noise", label: "Low-value noise", hint: "Generic warning that adds cost but rarely catches bugs." },
  { value: "other", label: "Other (explain)", hint: "Free-form reason in the note field below." },
];

function DismissModal({ open, initialKind, finding, onClose, onSubmit }: DismissModalProps) {
  const [kind, setKind] = React.useState<Exclude<ReviewFeedbackKind, "acknowledge">>(initialKind);
  const [reason, setReason] = React.useState<ReviewDismissReason>("low_value_noise");
  const [note, setNote] = React.useState("");
  const [snoozeDays, setSnoozeDays] = React.useState(7);
  const [suppressionScope, setSuppressionScope] = React.useState<ReviewSuppressionScope>("repo");
  const [submitting, setSubmitting] = React.useState(false);
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (open) {
      setKind(initialKind);
      setReason("low_value_noise");
      setNote("");
      setSnoozeDays(7);
      setSuppressionScope("repo");
      setSubmitting(false);
    }
  }, [open, initialKind]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    // Move focus into the dialog so keyboard users are oriented.
    queueMicrotask(() => closeButtonRef.current?.focus());
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit({
        kind,
        reason,
        note: note.trim(),
        snoozeDurationMs: kind === "snooze" ? snoozeDays * 24 * 60 * 60 * 1000 : null,
        suppressionScope: kind === "suppress" ? suppressionScope : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const kindOptions: Array<{ value: Exclude<ReviewFeedbackKind, "acknowledge">; label: string; icon: React.ReactNode }> = [
    { value: "dismiss", label: "Dismiss this finding", icon: <X size={14} /> },
    { value: "snooze", label: "Snooze for a while", icon: <BellSimpleSlash size={14} /> },
    { value: "suppress", label: "Suppress similar findings", icon: <Shield size={14} /> },
  ];

  const submitLabel = submitting
    ? "Saving…"
    : kind === "suppress"
      ? suppressionScope === "path"
        ? "Suppress for this path"
        : suppressionScope === "global"
          ? "Suppress everywhere"
          : "Suppress in this repo"
      : kind === "snooze"
        ? `Snooze ${snoozeDays} day${snoozeDays === 1 ? "" : "s"}`
        : "Dismiss";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Review finding feedback"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0B141F] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-5 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-[#6E7F92]">Feedback</div>
            <div className="truncate text-sm font-semibold text-[#F5FAFF]">{finding.title}</div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close feedback dialog"
            className="rounded-md p-1 text-[#93A4B8] hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-sky-400/50"
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {kindOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setKind(opt.value)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left text-xs transition",
                  kind === opt.value
                    ? "border-sky-400/40 bg-sky-400/[0.10] text-[#F5FAFF]"
                    : "border-white/[0.08] bg-white/[0.02] text-[#B7C4D7] hover:border-white/[0.16]",
                )}
              >
                <span className="flex items-center gap-1.5">{opt.icon}<span className="font-medium">{opt.label.split(" ")[0]}</span></span>
                <span className="text-[10px] leading-tight text-[#93A4B8]">{opt.label}</span>
              </button>
            ))}
          </div>

          {kind === "snooze" ? (
            <div>
              <label className="text-[10px] uppercase tracking-[0.18em] text-[#6E7F92]">Hide for</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={snoozeDays}
                  onChange={(e) => setSnoozeDays(Math.max(1, Math.min(180, Number(e.target.value) || 1)))}
                  className="w-20 rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 text-sm text-[#F5FAFF]"
                />
                <span className="text-xs text-[#93A4B8]">days</span>
              </div>
            </div>
          ) : null}

          {kind === "suppress" ? (
            <div>
              <label className="text-[10px] uppercase tracking-[0.18em] text-[#6E7F92]">Suppression scope</label>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {(["repo", "path", "global"] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setSuppressionScope(scope)}
                    className={cn(
                      "rounded-md border px-2 py-1.5 text-[11px] transition",
                      suppressionScope === scope
                        ? "border-violet-400/40 bg-violet-400/[0.10] text-[#F5FAFF]"
                        : "border-white/[0.08] bg-white/[0.02] text-[#B7C4D7] hover:border-white/[0.16]",
                    )}
                  >
                    {scope === "repo" ? "This repo" : scope === "path" ? (finding.filePath ? `Path (${finding.filePath.split("/").slice(-1)[0]})` : "Path") : "Global"}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-[#6E7F92]">
                Future runs skip findings semantically similar to this one within the chosen scope. You can remove suppressions later from the Learnings panel.
              </p>
            </div>
          ) : null}

          <div>
            <label className="text-[10px] uppercase tracking-[0.18em] text-[#6E7F92]">Reason</label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              {DISMISS_REASONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setReason(opt.value)}
                  title={opt.hint}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-left text-[11px] transition",
                    reason === opt.value
                      ? "border-sky-400/40 bg-sky-400/[0.10] text-[#F5FAFF]"
                      : "border-white/[0.06] bg-white/[0.02] text-[#93A4B8] hover:border-white/[0.16]",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-[0.18em] text-[#6E7F92]">
              Note (optional{reason === "other" ? ", required for \"Other\"" : ""})
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Why is this finding wrong, noisy, or out of scope?"
              className="mt-1 w-full resize-y rounded-md border border-white/[0.08] bg-black/30 px-2 py-1.5 text-xs text-[#F5FAFF] placeholder:text-[#4B5B71]"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-white/[0.02] px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || (reason === "other" && !note.trim())}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ReviewFindingCard({
  finding,
  onRequestAction,
  onOpenInFiles,
  onOpenInEditor,
  disabled,
}: ReviewFindingCardProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [modalKind, setModalKind] = React.useState<Exclude<ReviewFeedbackKind, "acknowledge"> | null>(null);

  const feedback = finding.feedback ?? null;
  const feedbackBadge = describeFeedback(feedback);
  const suppression = finding.suppressionMatch ?? null;
  const isSuppressed = suppression != null;
  const findingClass = finding.findingClass ?? null;
  const nonToolEvidence = (finding.evidence ?? []).filter((entry) => entry.kind !== "tool_signal");
  const toolSignalCount = (finding.evidence ?? []).filter((entry) => entry.kind === "tool_signal").length;

  const handleAcknowledge = async () => {
    await onRequestAction({ finding, kind: "acknowledge" });
  };

  const handleModalSubmit = async (args: {
    kind: Exclude<ReviewFeedbackKind, "acknowledge">;
    reason: ReviewDismissReason;
    note: string;
    snoozeDurationMs: number | null;
    suppressionScope?: ReviewSuppressionScope;
  }) => {
    await onRequestAction({
      finding,
      kind: args.kind,
      reason: args.reason,
      note: args.note || null,
      snoozeDurationMs: args.snoozeDurationMs,
      suppression: args.kind === "suppress" && args.suppressionScope
        ? {
            scope: args.suppressionScope,
            pathPattern: args.suppressionScope === "path" ? finding.filePath ?? null : null,
          }
        : null,
    });
    setModalKind(null);
  };

  return (
    <article
      className={cn(
        "rounded-xl border p-3 transition",
        isSuppressed
          ? "border-violet-500/20 bg-violet-500/[0.04] opacity-75 hover:opacity-100"
          : feedback?.kind === "acknowledge"
            ? "border-emerald-400/25 bg-emerald-400/[0.04]"
            : feedback?.kind === "dismiss" || feedback?.kind === "snooze"
              ? "border-white/[0.06] bg-white/[0.02] opacity-70"
              : "border-white/[0.08] bg-white/[0.04] hover:border-white/[0.14]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip className={cn("text-[9px]", toSeverityTone(finding.severity))}>{finding.severity}</Chip>
            {findingClass ? (
              <span
                title={FINDING_CLASS_DESCRIPTION[findingClass]}
                className={cn("rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] cursor-help", toFindingClassTone(findingClass))}
              >
                {toFindingClassLabel(findingClass)}
              </span>
            ) : null}
            {feedbackBadge ? (
              <Chip className={cn("text-[9px]", feedbackBadge.tone)}>{feedbackBadge.label}</Chip>
            ) : null}
            {isSuppressed ? (
              <Chip className="text-[9px] border-violet-400/30 bg-violet-400/[0.10] text-violet-200">filtered</Chip>
            ) : null}
          </div>
          <div className="mt-1.5 text-sm font-semibold leading-snug text-[#F5FAFF]">{finding.title}</div>
          <div className="mt-1 text-xs leading-relaxed text-[#93A4B8]">{finding.body}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-[10px] text-[#94A3B8]">
          <span>conf {formatConfidence(finding.confidence)}</span>
          {finding.filePath ? (
            <span className="max-w-[200px] truncate font-mono text-[10px]" title={finding.filePath}>
              {finding.filePath.split("/").slice(-2).join("/")}{finding.line ? `:${finding.line}` : ""}
            </span>
          ) : null}
        </div>
      </div>

      {isSuppressed ? (
        <div className="mt-2 rounded-lg border border-violet-400/20 bg-violet-400/[0.06] px-2.5 py-1.5 text-[11px] text-violet-100">
          {describeSuppression(suppression)}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {finding.originatingPasses?.map((pass) => (
          <Chip key={`${finding.id}-${pass}`} className="text-[9px]">{PASS_LABEL[pass] ?? pass}</Chip>
        ))}
        {toolSignalCount > 0 ? (
          <Chip className="text-[9px] border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200">
            <ShieldCheck size={10} /> tool-backed · {toolSignalCount}
          </Chip>
        ) : null}
        {finding.adjudication ? (
          <Chip className="text-[9px]">
            {finding.adjudication.publicationEligible ? "publication eligible" : "local only"}
          </Chip>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-[#B7C4D7] hover:bg-white/[0.06]"
        >
          {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
          {finding.diffContext ? (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[#6E7F92]">
                <FileText size={10} /> inline diff
              </div>
              <DiffContextBlock context={finding.diffContext} />
            </div>
          ) : null}

          {toolSignalCount > 0 ? (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[#6E7F92]">
                <ShieldCheck size={10} /> tool-backed evidence
              </div>
              <ToolSignalBlock evidence={finding.evidence ?? []} />
            </div>
          ) : null}

          {nonToolEvidence.length > 0 ? (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[#6E7F92]">
                <MagnifyingGlass size={10} /> evidence trail
              </div>
              <div className="space-y-1.5">
                {nonToolEvidence.map((entry, idx) => (
                  <div key={`${finding.id}-${idx}`} className="rounded-lg border border-white/[0.06] bg-black/20 p-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8FA1B8]">
                      <span className="font-mono uppercase tracking-[0.08em]">{entry.kind}</span>
                      {entry.summary ? <span className="text-[#CBD5E1]">{entry.summary}</span> : null}
                      {entry.filePath ? (
                        <span className="font-mono text-[10px]">{entry.filePath}{entry.line ? `:${entry.line}` : ""}</span>
                      ) : null}
                    </div>
                    {entry.quote ? (
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
                        {entry.quote}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {finding.adjudication?.rationale ? (
            <div className="rounded-lg border border-white/[0.06] bg-black/20 p-2 text-[11px] leading-relaxed text-[#B7C4D7]">
              <span className="text-[10px] uppercase tracking-[0.12em] text-[#6E7F92]">Adjudication — </span>
              {finding.adjudication.rationale}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {finding.filePath && onOpenInFiles ? (
          <Button size="sm" variant="ghost" onClick={() => onOpenInFiles(finding)}>
            <FileText size={12} /> Open in files
          </Button>
        ) : null}
        {finding.filePath && onOpenInEditor ? (
          <Button size="sm" variant="ghost" onClick={() => onOpenInEditor(finding)}>
            <ArrowSquareOut size={12} /> Open editor
          </Button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleAcknowledge}
            disabled={disabled || feedback?.kind === "acknowledge"}
            title="Mark this finding as useful. Strengthens future findings like it."
          >
            <CheckCircle size={12} /> Useful
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setModalKind("dismiss")}
            disabled={disabled}
            title="Dismiss with a reason."
          >
            <X size={12} /> Dismiss
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setModalKind("snooze")}
            disabled={disabled}
            title="Hide this class of finding for a while."
          >
            <BellSimpleSlash size={12} /> Snooze
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setModalKind("suppress")}
            disabled={disabled}
            title="Teach the engine to skip similar findings in the future."
          >
            <Prohibit size={12} /> Suppress
          </Button>
        </div>
      </div>

      <DismissModal
        open={modalKind != null}
        initialKind={modalKind ?? "dismiss"}
        finding={finding}
        onClose={() => setModalKind(null)}
        onSubmit={handleModalSubmit}
      />
    </article>
  );
}
