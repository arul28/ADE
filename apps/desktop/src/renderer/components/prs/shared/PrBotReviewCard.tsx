import { memo, useMemo, useState, type CSSProperties } from "react";
import { CaretRight } from "@phosphor-icons/react";

import type { PrReview } from "../../../../shared/types";
import { classifyPrAuthor } from "../../../../shared/prBotIdentity";
import { COLORS, SANS_FONT, inlineBadge } from "../../lanes/laneDesignTokens";
import { formatTimeAgo } from "./prFormatters";
import { PrMarkdown } from "./PrMarkdown";
import { PrAgentAvatar } from "./PrAgentAvatar";

type Severity = "P0" | "P1" | "P2" | "High" | "Medium" | "Low";

const SEVERITY_COLORS: Record<Severity, string> = {
  P0: COLORS.danger,
  P1: COLORS.warning,
  P2: COLORS.textSecondary,
  High: COLORS.danger,
  Medium: COLORS.warning,
  Low: COLORS.textSecondary,
};

function extractSeverities(body: string): Severity[] {
  const found = new Set<Severity>();
  const re = /\b(P[012]|High|Medium|Low)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    found.add(match[1] as Severity);
  }
  return Array.from(found);
}

function extractIssueCount(body: string): number | null {
  const match = body.match(/(\d+)\s+(?:issues?|findings?|comments?)/i);
  return match ? Number(match[1]) : null;
}

function extractConfidence(body: string): string | null {
  const match = body.match(/confidence[:\s]+(high|medium|low|\d+%)/i);
  return match ? match[1] : null;
}

type PrBotReviewCardProps = {
  review: PrReview;
  repoOwner: string;
  repoName: string;
  defaultOpen?: boolean;
};

export const PrBotReviewCard = memo(function PrBotReviewCard({
  review,
  repoOwner,
  repoName,
  defaultOpen = false,
}: PrBotReviewCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  const identity = useMemo(
    () => classifyPrAuthor(review.reviewer, review.reviewerIsBot),
    [review.reviewer, review.reviewerIsBot],
  );
  const provider = identity.kind;
  const body = review.body ?? "";

  // Only mine free-text heuristics for KNOWN structured providers, so prose in
  // an unrecognized bot's review can't produce bogus severity/issue badges.
  const severities = useMemo(() => (provider ? extractSeverities(body) : []), [provider, body]);
  const issueCount = useMemo(() => (provider ? extractIssueCount(body) : null), [provider, body]);
  const confidence = useMemo(() => (provider ? extractConfidence(body) : null), [provider, body]);

  const summaryParts: string[] = [identity.displayName || review.reviewer];
  if (confidence) summaryParts.push(confidence);
  if (issueCount !== null) summaryParts.push(`${issueCount} ${issueCount === 1 ? "issue" : "issues"}`);

  const containerStyle: CSSProperties = {
    padding: 0,
    borderRadius: 12,
    overflow: "hidden",
    background: COLORS.threadCard,
    border: "none",
  };

  return (
    <div
      data-pr-bot-review-card
      data-provider={provider ?? "unknown"}
      style={containerStyle}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]"
        style={{ fontFamily: SANS_FONT, color: COLORS.textPrimary }}
      >
        <PrAgentAvatar
          login={review.reviewer}
          isBot={review.reviewerIsBot}
          avatarUrl={review.reviewerAvatarUrl}
          size={24}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2 text-[12px] font-medium">
            <span className="truncate" style={{ color: COLORS.textPrimary }}>
              {summaryParts.join(" · ")}
            </span>
            <span
              style={inlineBadge(COLORS.textMuted, {
                padding: "1px 5px",
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: 0.3,
                textTransform: "uppercase",
                flexShrink: 0,
              })}
            >
              App
            </span>
            {severities.map((sev) => (
              <span
                key={sev}
                style={inlineBadge(SEVERITY_COLORS[sev], {
                  padding: "1px 6px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.2,
                })}
              >
                {sev}
              </span>
            ))}
          </div>
          <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
            {formatTimeAgo(review.submittedAt)}
          </span>
        </div>
        <CaretRight
          size={12}
          weight="bold"
          className="shrink-0 transition-transform"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            color: COLORS.textSecondary,
          }}
        />
      </button>
      {open && body ? (
        <div
          className="border-t px-4 py-3"
          style={{ borderColor: COLORS.border, background: "rgba(255,255,255,0.01)" }}
        >
          <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
            {body}
          </PrMarkdown>
        </div>
      ) : null}
      {open && !body ? (
        <div
          className="border-t px-4 py-3 text-[12px]"
          style={{ borderColor: COLORS.border, color: COLORS.textMuted, fontFamily: SANS_FONT }}
        >
          No review body.
        </div>
      ) : null}
    </div>
  );
});

export default PrBotReviewCard;
