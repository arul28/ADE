import { memo, useMemo, useState, type CSSProperties } from "react";
import { CaretRight, Robot } from "@phosphor-icons/react";

import type { PrReview } from "../../../../shared/types";
import { COLORS, SANS_FONT, cardStyle, inlineBadge } from "../../lanes/laneDesignTokens";
import { formatTimeAgo } from "./prFormatters";
import { PrMarkdown } from "./PrMarkdown";

export type BotProvider = "greptile" | "seer" | "coderabbit" | "claude" | "sourcery";

type ProviderVisual = {
  label: string;
  accent: string;
  initial: string;
};

const PROVIDERS: Record<BotProvider, ProviderVisual> = {
  greptile: { label: "Greptile", accent: COLORS.success, initial: "G" },
  seer: { label: "Seer", accent: COLORS.accent, initial: "S" },
  coderabbit: { label: "CodeRabbit", accent: COLORS.entryCli, initial: "R" },
  claude: { label: "Claude", accent: COLORS.info, initial: "C" },
  sourcery: { label: "Sourcery", accent: COLORS.warning, initial: "Y" },
};

const DETECTION_PATTERNS: Array<{ provider: BotProvider; test: (login: string) => boolean }> = [
  { provider: "greptile", test: (l) => l.startsWith("greptile") },
  { provider: "seer", test: (l) => l.startsWith("seer") || l.includes("seer-by-sentry") },
  { provider: "coderabbit", test: (l) => l.startsWith("coderabbit") },
  { provider: "claude", test: (l) => l === "claude" || l.startsWith("claude-") || l.startsWith("anthropic-") },
  { provider: "sourcery", test: (l) => l.startsWith("sourcery") },
];

export function detectBotProvider(authorLogin: string): BotProvider | null {
  if (!authorLogin) return null;
  const normalized = authorLogin.toLowerCase().replace(/\[bot\]$/, "");
  for (const { provider, test } of DETECTION_PATTERNS) {
    if (test(normalized)) return provider;
  }
  return null;
}

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

  const provider = useMemo(() => detectBotProvider(review.reviewer), [review.reviewer]);
  const visual = provider ? PROVIDERS[provider] : null;
  const accent = visual?.accent ?? COLORS.textSecondary;
  const body = review.body ?? "";

  const severities = useMemo(() => extractSeverities(body), [body]);
  const issueCount = useMemo(() => extractIssueCount(body), [body]);
  const confidence = useMemo(() => extractConfidence(body), [body]);

  const summaryParts: string[] = [visual?.label ?? review.reviewer];
  if (confidence) summaryParts.push(confidence);
  if (issueCount !== null) summaryParts.push(`${issueCount} ${issueCount === 1 ? "issue" : "issues"}`);

  const containerStyle: CSSProperties = cardStyle({
    padding: 0,
    borderRadius: 12,
    borderLeft: `3px solid ${accent}`,
    overflow: "hidden",
  });

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
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-[11px] font-semibold"
          style={{
            background: `${accent}18`,
            color: accent,
            border: `1px solid ${accent}30`,
          }}
        >
          {visual ? visual.initial : <Robot size={12} weight="bold" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2 text-[12px] font-medium">
            <span className="truncate" style={{ color: COLORS.textPrimary }}>
              {summaryParts.join(" · ")}
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
