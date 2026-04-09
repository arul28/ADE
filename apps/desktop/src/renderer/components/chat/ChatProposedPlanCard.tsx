import React, { useCallback, useMemo, useState } from "react";
import { ListChecks, CopySimple, CaretDown, CaretRight } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../ui/cn";
import { ChatStatusGlyph } from "./chatStatusVisuals";

/* ── Types ── */

interface ChatProposedPlanCardProps {
  source: string;
  description: string | null;
  question: string | null;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/* ── Step parsing ── */

type ParsedSegment =
  | { kind: "header"; text: string }
  | { kind: "step"; text: string }
  | { kind: "text"; text: string };

function parseDescription(raw: string): ParsedSegment[] {
  const lines = raw.split(/\r?\n/);
  const segments: ParsedSegment[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^#{1,2}\s+/.test(trimmed)) {
      segments.push({ kind: "header", text: trimmed.replace(/^#{1,2}\s+/, "").trim() });
    } else if (/^\d+\.\s+/.test(trimmed)) {
      segments.push({ kind: "step", text: trimmed.replace(/^\d+\.\s+/, "").trim() });
    } else if (/^[-*]\s+/.test(trimmed)) {
      segments.push({ kind: "step", text: trimmed.replace(/^[-*]\s+/, "").trim() });
    } else if (trimmed.length > 0) {
      segments.push({ kind: "text", text: line });
    }
  }

  return segments;
}

function hasStructure(segments: ParsedSegment[]): boolean {
  return segments.some((s) => s.kind === "header" || s.kind === "step");
}

/* ── Constants ── */

const COLLAPSE_THRESHOLD = 300;
const VISIBLE_CHARS = 200;

/* ── Component ── */

const ChatProposedPlanCard = React.memo(function ChatProposedPlanCard({
  source,
  description,
  question,
  disabled,
  onApprove,
  onReject,
}: ChatProposedPlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [copied, setCopied] = useState(false);

  const bodyText = description ?? question ?? "The agent has prepared a plan.";

  const segments = useMemo(() => parseDescription(bodyText), [bodyText]);
  const structured = useMemo(() => hasStructure(segments), [segments]);
  const isLong = bodyText.length > COLLAPSE_THRESHOLD;
  const showFull = expanded || !isLong;

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(bodyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bodyText]);

  /* ── Truncated plain text ── */
  const truncatedText = useMemo(() => {
    if (showFull) return bodyText;
    return bodyText.slice(0, VISIBLE_CHARS).trimEnd() + "\u2026";
  }, [bodyText, showFull]);

  /* ── Truncated structured segments ── */
  const visibleSegments = useMemo(() => {
    if (showFull) return segments;
    let charCount = 0;
    const result: ParsedSegment[] = [];
    for (const seg of segments) {
      charCount += seg.text.length;
      if (charCount > VISIBLE_CHARS && result.length > 0) break;
      result.push(seg);
    }
    return result;
  }, [segments, showFull]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-amber-500/[0.10] bg-gradient-to-br from-amber-950/15 via-[#12101A] to-[#12101A] p-4">
      {/* Gradient accent line */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/25 to-transparent" />

      {/* ── Header ── */}
      <div className="mb-2.5 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/[0.10] shadow-[0_0_0_3px_rgba(245,158,11,0.08)]">
          <ChatStatusGlyph status="waiting" size={11} />
        </span>
        <ListChecks size={13} weight="bold" className="text-amber-400/60" />
        <span className="text-amber-300/50 font-mono text-[9px] uppercase tracking-[0.16em]">
          Plan Approval &middot; {source}
        </span>
      </div>

      {/* ── Body ── */}
      <AnimatePresence initial={false}>
        <motion.div
          key={showFull ? "full" : "collapsed"}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          onAnimationStart={() => setAnimating(true)}
          onAnimationComplete={() => setAnimating(false)}
          className={animating ? "overflow-hidden" : ""}
        >
          {structured ? (
            <div className="mb-2 space-y-1">
              {visibleSegments.map((seg, i) => {
                if (seg.kind === "header") {
                  return (
                    <div
                      key={`h-${i}`}
                      className="mt-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-amber-300/70"
                    >
                      {seg.text}
                    </div>
                  );
                }
                if (seg.kind === "step") {
                  return (
                    <div key={`s-${i}`} className="flex items-start gap-2 pl-0.5">
                      <span className="mt-[3px] block h-1 w-1 shrink-0 rounded-full bg-amber-400/40" />
                      <span className="text-[12px] leading-relaxed text-fg/80">
                        {seg.text}
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={`t-${i}`}
                    className="font-mono text-[11px] leading-relaxed text-fg/68"
                  >
                    {seg.text}
                  </div>
                );
              })}
              {!showFull && (
                <span className="font-mono text-[10px] text-fg/30">&hellip;</span>
              )}
            </div>
          ) : (
            <div className="mb-2 max-h-72 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg/68">
              {truncatedText}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── Show more / less toggle ── */}
      {isLong && (
        <button
          type="button"
          className="mb-2.5 flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-300/55 transition-colors hover:text-amber-200/80"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <CaretDown size={9} weight="bold" />
              Show less
            </>
          ) : (
            <>
              <CaretRight size={9} weight="bold" />
              Show more
            </>
          )}
        </button>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "rounded-lg border border-emerald-400/25 bg-emerald-500/[0.10] px-3 py-1.5 text-[11px] font-medium text-emerald-300 transition-colors",
            "hover:bg-emerald-500/[0.16] disabled:pointer-events-none disabled:opacity-40",
          )}
          onClick={onApprove}
        >
          Approve &amp; Implement
        </button>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "rounded-lg border border-white/[0.06] px-3 py-1.5 text-[11px] text-fg/50 transition-colors",
            "hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-40",
          )}
          onClick={onReject}
        >
          Reject &amp; Revise
        </button>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded-[var(--chat-radius-pill)] border border-white/[0.06] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg/35 transition-colors hover:bg-white/[0.04] hover:text-fg/55"
          onClick={handleCopy}
        >
          <CopySimple size={10} weight="bold" />
          {copied ? "Copied" : "Copy Plan"}
        </button>
      </div>
    </div>
  );
});

export { ChatProposedPlanCard };
export type { ChatProposedPlanCardProps };
