import { memo, useMemo, useState, type CSSProperties } from "react";
import { CaretRight, Robot } from "@phosphor-icons/react";
import claudeMark from "@lobehub/icons-static-svg/icons/claude.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex.svg";
import copilotMark from "@lobehub/icons-static-svg/icons/githubcopilot.svg";
import greptileMark from "@lobehub/icons-static-svg/icons/greptile.svg";
import vercelMark from "@lobehub/icons-static-svg/icons/vercel.svg";

import type { PrReview } from "../../../../shared/types";
import { COLORS, SANS_FONT, inlineBadge } from "../../lanes/laneDesignTokens";
import { formatTimeAgo } from "./prFormatters";
import { PrMarkdown } from "./PrMarkdown";
import { PrUserAvatar } from "./PrUserAvatar";

export type BotProvider =
  | "greptile"
  | "seer"
  | "coderabbit"
  | "claude"
  | "codex"
  | "copilot"
  | "sourcery"
  | "cursor"
  | "vercel"
  | "linear"
  | "codecov";

type ProviderVisual = {
  label: string;
  accent: string;
  initial: string;
  /**
   * Bundled brand mark used as a fallback when GitHub doesn't hand us the bot's
   * real avatar URL (the avatar IS the logo). Tinted to `accent` via a CSS mask
   * so color/mono source marks render as a consistent branded silhouette.
   */
  mark?: string;
};

const PROVIDERS: Record<BotProvider, ProviderVisual> = {
  greptile: { label: "Greptile", accent: COLORS.success, initial: "G", mark: greptileMark },
  seer: { label: "Seer", accent: COLORS.accent, initial: "S" },
  coderabbit: { label: "CodeRabbit", accent: COLORS.entryCli, initial: "R" },
  claude: { label: "Claude", accent: COLORS.info, initial: "C", mark: claudeMark },
  codex: { label: "Codex", accent: COLORS.textSecondary, initial: "C", mark: codexMark },
  copilot: { label: "Copilot", accent: COLORS.info, initial: "C", mark: copilotMark },
  sourcery: { label: "Sourcery", accent: COLORS.warning, initial: "Y" },
  cursor: { label: "Cursor", accent: COLORS.accent, initial: "C" },
  vercel: { label: "Vercel", accent: COLORS.textPrimary, initial: "V", mark: vercelMark },
  linear: { label: "Linear", accent: COLORS.accent, initial: "L" },
  codecov: { label: "Codecov", accent: COLORS.danger, initial: "C" },
};

const DETECTION_PATTERNS: Array<{ provider: BotProvider; test: (login: string) => boolean }> = [
  { provider: "greptile", test: (l) => l.startsWith("greptile") },
  { provider: "seer", test: (l) => l.startsWith("seer") || l.includes("seer-by-sentry") || l.startsWith("sentry") },
  { provider: "coderabbit", test: (l) => l.startsWith("coderabbit") },
  {
    provider: "copilot",
    test: (l) => l === "copilot" || l.startsWith("github-copilot") || l.startsWith("copilot-"),
  },
  {
    provider: "codex",
    test: (l) => l.startsWith("codex") || l.startsWith("chatgpt-codex") || l.includes("codex-connector"),
  },
  { provider: "claude", test: (l) => l === "claude" || l.startsWith("claude-") || l.startsWith("anthropic-") },
  { provider: "sourcery", test: (l) => l.startsWith("sourcery") },
  { provider: "vercel", test: (l) => l.startsWith("vercel") },
  { provider: "linear", test: (l) => l === "linear" || l.startsWith("linear-") },
  { provider: "codecov", test: (l) => l.startsWith("codecov") },
  { provider: "cursor", test: (l) => l.startsWith("cursor") },
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

  // Only mine free-text heuristics for KNOWN structured providers, so prose in
  // an unrecognized bot's review can't produce bogus severity/issue badges.
  const severities = useMemo(() => (provider ? extractSeverities(body) : []), [provider, body]);
  const issueCount = useMemo(() => (provider ? extractIssueCount(body) : null), [provider, body]);
  const confidence = useMemo(() => (provider ? extractConfidence(body) : null), [provider, body]);

  const summaryParts: string[] = [visual?.label ?? review.reviewer];
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
        {review.reviewerAvatarUrl ? (
          // GitHub bot accounts (greptile-apps, vercel[bot], linear[bot], …) ship
          // a real avatar that IS the brand logo — prefer it for full fidelity.
          <PrUserAvatar user={{ login: review.reviewer, avatarUrl: review.reviewerAvatarUrl }} size={24} />
        ) : visual?.mark ? (
          // No avatar URL: fall back to the bundled brand mark, tinted to the
          // provider accent via a CSS mask so color/mono marks read consistently.
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px]"
            style={{ background: `${accent}18`, border: `1px solid ${accent}30` }}
          >
            <span
              className="h-3.5 w-3.5"
              style={{
                backgroundColor: accent,
                WebkitMaskImage: `url(${visual.mark})`,
                maskImage: `url(${visual.mark})`,
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
                WebkitMaskSize: "contain",
                maskSize: "contain",
              }}
            />
          </span>
        ) : (
          // Last resort: a brand-tinted monogram (known provider) or a generic
          // robot glyph (unrecognized bot with no avatar).
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
        )}
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
