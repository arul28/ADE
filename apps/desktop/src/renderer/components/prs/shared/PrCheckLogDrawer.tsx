import React from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Copy,
  GithubLogo,
  Sparkle,
  XCircle,
} from "@phosphor-icons/react";

import type { PrCheckLogExcerpt, PrWorkflowGraphNode } from "../../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  RADII,
  SANS_FONT,
  floatingPane,
} from "../../lanes/laneDesignTokens";

function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

function SmallButton({
  onClick,
  children,
  tone = "neutral",
  disabled = false,
  testId,
  title,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  tone?: "neutral" | "warn";
  disabled?: boolean;
  testId?: string;
  title?: string;
}) {
  const color = tone === "warn" ? COLORS.warning : COLORS.textSecondary;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className="inline-flex h-[26px] shrink-0 items-center gap-1.5 px-2.5 text-[11px] font-medium"
      style={{
        borderRadius: RADII.sm,
        fontFamily: SANS_FONT,
        color,
        background: COLORS.cardBg,
        border: `1px solid ${tone === "warn" ? tint(COLORS.warning, 38) : COLORS.outlineBorder}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

export type PrCheckLogDrawerState = {
  node: PrWorkflowGraphNode;
  jobId: number | null;
};

export function PrCheckLogDrawer({
  drawer,
  excerpt,
  loading,
  error,
  elapsedLabel,
  onCopy,
  copied,
  onRerunJob,
  onFixInChat,
  onClose,
}: {
  drawer: PrCheckLogDrawerState;
  excerpt: PrCheckLogExcerpt | null;
  loading: boolean;
  error: string | null;
  elapsedLabel: string | null;
  onCopy: () => void;
  copied: boolean;
  onRerunJob: (() => void) | undefined;
  onFixInChat: (() => void) | undefined;
  onClose: () => void;
}) {
  const stepLine = excerpt?.failingStepName
    ? `failed at step ${excerpt.failingStepNumber ?? "?"}/${excerpt.stepTotal ?? "?"} · ${excerpt.failingStepName}`
    : null;

  return (
    <section
      data-testid="pr-checks-log-drawer"
      data-job-id={drawer.jobId ?? undefined}
      className="mt-2 overflow-hidden"
      style={floatingPane({ padding: 0, border: `1px solid ${tint(COLORS.danger, 30)}` })}
    >
      <div
        className="flex items-center gap-2 px-3 py-2.5"
        style={{ borderBottom: `1px solid ${COLORS.borderMuted}`, background: tint(COLORS.danger, 7) }}
      >
        <XCircle size={13} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} />
        <span className="text-[12px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
          {drawer.node.displayName}
        </span>
        <span className="min-w-0 truncate text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
          {[stepLine, elapsedLabel].filter(Boolean).join(" · ")}
        </span>
        <span className="flex-1" />
        {onRerunJob ? (
          <SmallButton tone="warn" onClick={onRerunJob} testId="pr-checks-drawer-rerun-job">
            <ArrowsClockwise size={12} /> Re-run this job
          </SmallButton>
        ) : null}
        {drawer.node.detailsUrl ? (
          <SmallButton onClick={() => void window.ade.app.openExternal(drawer.node.detailsUrl!)}>
            <GithubLogo size={12} /> GitHub
          </SmallButton>
        ) : null}
        <SmallButton onClick={onClose} testId="pr-checks-drawer-close" title="Close log">✕</SmallButton>
      </div>

      {excerpt?.headline ? (
        <div
          className="px-3 py-2 text-[11.5px]"
          style={{ color: COLORS.danger, fontFamily: MONO_FONT, borderBottom: `1px solid ${COLORS.borderMuted}` }}
          data-testid="pr-checks-log-headline"
        >
          {excerpt.headline}
        </div>
      ) : null}

      <pre
        className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap px-3 py-2.5 text-[11px] leading-[1.55]"
        style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT, background: COLORS.recessedBg }}
        data-testid="pr-checks-log-body"
      >
        {loading
          ? "Fetching the failing step's output…"
          : error
            ? error
            : excerpt
              ? excerpt.lines.join("\n")
              : "No log excerpt available for this job."}
      </pre>

      <div className="flex items-center gap-[7px] px-3 py-2" style={{ borderTop: `1px solid ${COLORS.borderMuted}` }}>
        <SmallButton onClick={onCopy} disabled={!excerpt} testId="pr-checks-drawer-copy">
          <Copy size={12} /> {copied ? "Copied" : "Copy excerpt"}
        </SmallButton>
        <SmallButton
          onClick={excerpt?.htmlUrl ? () => void window.ade.app.openExternal(excerpt.htmlUrl!) : undefined}
          disabled={!excerpt?.htmlUrl}
          testId="pr-checks-drawer-full-log"
        >
          <ArrowSquareOut size={12} /> Full log
        </SmallButton>
        <SmallButton onClick={onFixInChat} disabled={!onFixInChat} testId="pr-checks-drawer-fix-in-chat">
          <Sparkle size={12} /> Fix in chat
        </SmallButton>
        <span className="ml-auto text-[10.5px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
          tail of the failing step · fetched on open
        </span>
      </div>
    </section>
  );
}
