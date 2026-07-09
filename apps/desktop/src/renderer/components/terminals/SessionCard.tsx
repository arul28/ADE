import React from "react";
import { GridFour, WarningCircle, Question, Clock } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import type { OrchestrationRole } from "../../../shared/types/orchestration";
import {
  sessionStatusDot,
  sanitizeTerminalInlineText,
  sessionNeedsChatTabHighlight,
  sessionCapsuleBadge,
  sessionInlineStatusLabel,
} from "../../lib/terminalAttention";
import type { SessionBadge } from "../../../shared/sessionCanonicalState";
import {
  getStaleRunningCliSessionAgeHours,
  primarySessionLabel,
  preferredSessionLabel,
} from "../../lib/sessions";
import { relativeTimeCompact } from "../../lib/format";
import { GRID_SESSION_DND_MIME } from "../../lib/workGrid";
import { useAppStore } from "../../state/appStore";
import { useLaneNaming } from "../../state/laneNamingStore";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import { ToolLogo } from "./ToolLogos";
import { readImportedFrom, providerDisplayName } from "./importSessions/contract";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";

const DELTA_CHIP_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  fontFamily: MONO_FONT,
  letterSpacing: "0",
  borderRadius: 4,
};

/* ──────────────────────────────────────────────────────────────────────────
   Orchestration role pills.
   • lead       → purple `LEAD`
   • worker     → blue   `WORKER · <tag>` (tag lowercased)
   • validator  → green  `VALIDATOR`
   See goal.md §10.8 + §10.12.
   ────────────────────────────────────────────────────────────────────────── */

const ORCHESTRATION_PILL_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  padding: "1px 6px",
  fontSize: 9,
  fontWeight: 600,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "0.14em",
  borderRadius: 4,
  borderWidth: 1,
  borderStyle: "solid",
};

const ORCHESTRATION_PILL_PALETTE: Record<
  OrchestrationRole,
  { background: string; borderColor: string; color: string }
> = {
  lead: {
    background: "rgba(168, 85, 247, 0.14)",
    borderColor: "rgba(168, 85, 247, 0.42)",
    color: "rgb(216, 180, 254)",
  },
  worker: {
    background: "rgba(96, 165, 250, 0.13)",
    borderColor: "rgba(96, 165, 250, 0.38)",
    color: "rgb(147, 197, 253)",
  },
  validator: {
    background: "rgba(34, 197, 94, 0.13)",
    borderColor: "rgba(34, 197, 94, 0.36)",
    color: "rgb(134, 239, 172)",
  },
};

function orchestrationRolePillLabel(role: OrchestrationRole, tag?: string | null): string {
  if (role === "worker" && tag && tag.trim().length > 0) {
    return `WORKER · ${tag.trim().toLowerCase()}`;
  }
  if (role === "lead") return "LEAD";
  if (role === "validator") return "VALIDATOR";
  return role.toUpperCase();
}

function OrchestrationRolePill({
  role,
  tag,
}: {
  role: OrchestrationRole;
  tag?: string | null;
}) {
  const palette = ORCHESTRATION_PILL_PALETTE[role];
  const label = orchestrationRolePillLabel(role, tag);
  return (
    <span
      data-orchestration-role={role}
      style={{ ...ORCHESTRATION_PILL_BASE, ...palette }}
      title={label}
    >
      {label}
    </span>
  );
}

function orchestrationRoleA11yLabel(role: OrchestrationRole, tag?: string | null): string {
  if (role === "worker" && tag && tag.trim().length > 0) {
    return `Worker · ${tag.trim().toLowerCase()}`;
  }
  if (role === "lead") return "Lead";
  if (role === "validator") return "Validator";
  return role;
}

/* ──────────────────────────────────────────────────────────────────────────
   Attention capsule — one-word status from the shared canonical state module.
   Only ever renders for the three attention states; calm sessions get nothing
   (so the title row never reflows). Amber "Needs you", red "Failed", and an
   outlined "Stale" with a clock glyph.
   ────────────────────────────────────────────────────────────────────────── */

const ATTENTION_CAPSULE_STYLE: Record<SessionBadge["kind"], string> = {
  needs_you: "border-amber-400/30 bg-amber-400/15 text-amber-300",
  failed: "border-red-500/30 bg-red-500/15 text-red-300",
  // Stale is the calm-but-silent state: outlined, muted, no fill.
  stale: "border-white/15 bg-transparent text-muted-fg/60",
};

function AttentionCapsule({ badge, compact }: { badge: SessionBadge; compact: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border font-semibold leading-none",
        compact ? "px-1 py-0.5 text-[8px]" : "px-1.5 py-0.5 text-[10px]",
        ATTENTION_CAPSULE_STYLE[badge.kind],
      )}
      title={badge.label}
      aria-label={badge.label}
      data-session-badge={badge.kind}
    >
      {badge.kind === "stale" ? <Clock size={compact ? 9 : 10} weight="bold" /> : null}
      {badge.label}
    </span>
  );
}

function getPreviewLine(session: TerminalSessionSummary, primaryText: string): string | null {
  const summary = preferredSessionLabel(session.summary);
  if (summary && summary !== primaryText) return summary;
  const goal = preferredSessionLabel(session.goal);
  if (session.status !== "running") {
    if (goal && goal !== primaryText) return goal;
    return null;
  }
  const preview = sanitizeTerminalInlineText(session.lastOutputPreview, 120);
  if (preview && preview !== primaryText) return preview;
  if (goal && goal !== primaryText) return goal;
  return null;
}

export const SessionCard = React.memo(function SessionCard({
  session,
  lane,
  isSelected,
  isMultiSelected,
  onSelect,
  onContextMenu,
  compact = false,
  gridBadge = null,
}: {
  session: TerminalSessionSummary;
  lane: LaneSummary | null;
  isSelected: boolean;
  isMultiSelected?: boolean;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  compact?: boolean;
  /** Grid membership indicator: "active" = in the currently-viewed grid, "inactive" = in another grid, null = not gridded. */
  gridBadge?: "active" | "inactive" | null;
}) {
  const dot = sessionStatusDot(session);
  // Blocked on a chat question/plan only the user can answer (distinct from a
  // merely idle/ready chat, which the amber status dot can't disambiguate).
  const awaitingUser = sessionNeedsChatTabHighlight({
    runtimeState: session.runtimeState,
    toolType: session.toolType,
    pendingInputItemId: session.pendingInputItemId,
  });
  // Canonical one-word status capsule (Needs you / Failed / Stale). When the
  // chat-specific "Awaiting you" chip is already showing the same needs-input
  // condition, suppress the capsule so a chat card never doubles up amber pills.
  const sessionAttentionInput = {
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
    toolType: session.toolType,
    pendingInputItemId: session.pendingInputItemId,
    lastActivityAt: session.lastActivityAt,
    exitCode: session.exitCode,
  };
  const capsuleBadge = sessionCapsuleBadge(sessionAttentionInput);
  const attentionBadge =
    capsuleBadge && !(awaitingUser && capsuleBadge.kind === "needs_you") ? capsuleBadge : null;
  const inlineStatusLabel = sessionInlineStatusLabel(sessionAttentionInput);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const delta = useSessionDelta(session.id, !isRemoteProject || isSelected);
  const primaryText = primarySessionLabel(session);
  const previewLine = getPreviewLine(session, primaryText);
  // True while this lane's AI auto-name is being generated in the background.
  const isAutoNaming = useLaneNaming(lane?.id ?? null);
  // Brief warm highlight when the displayed title actually changes (e.g. the
  // deterministic/seed name is replaced by the AI name). Skipped on first mount.
  const [titleJustChanged, setTitleJustChanged] = React.useState(false);
  const prevTitleRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevTitleRef.current;
    prevTitleRef.current = primaryText;
    if (prev === null || prev === primaryText) return undefined;
    setTitleJustChanged(true);
    const timer = setTimeout(() => setTitleJustChanged(false), 1100);
    return () => clearTimeout(timer);
  }, [primaryText]);
  const staleAgeHours = getStaleRunningCliSessionAgeHours(session);
  const importedFrom = readImportedFrom(session);
  const isHighlighted = isSelected || isMultiSelected;
  const highlightedBorder = isHighlighted
    ? "1px solid rgba(255,255,255,0.08)"
    : "1px solid transparent";
  const laneAccent = lane?.color ?? null;
  const useLaneGlow = Boolean(isHighlighted && laneAccent);
  const laneTint = useLaneGlow
    ? `color-mix(in srgb, ${laneAccent} 14%, transparent)`
    : null;
  const laneRing = useLaneGlow
    ? `color-mix(in srgb, ${laneAccent} 32%, transparent)`
    : null;
  const stoppedBySignal = session.exitCode === 130 || session.exitCode === 143;
  const showClaudeCacheTimer = shouldShowClaudeCacheTtl({
    provider: session.toolType === "claude-chat" ? "claude" : null,
    status: session.runtimeState === "idle" ? "idle" : "active",
    idleSinceAt: session.chatIdleSinceAt,
    awaitingInput: session.runtimeState === "waiting-input",
  });
  const hasDeltaChips = Boolean(delta && (delta.insertions > 0 || delta.deletions > 0));
  const hasFooterMeta =
    showClaudeCacheTimer || hasDeltaChips || (session.exitCode != null && session.exitCode !== 0);
  const orchestrationLabel = session.orchestrationRole
    ? orchestrationRoleA11yLabel(session.orchestrationRole, session.orchestrationTag ?? null)
    : null;
  const isActiveGrid = gridBadge === "active";
  const gridLabel = isActiveGrid ? "In the active grid" : "In another grid";

  return (
    <div
      className="group relative"
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(event) => {
        // Source for the Cursor-style work grid: drop onto a session / the work
        // area to add this chat or CLI session to a grid.
        event.dataTransfer.setData(GRID_SESSION_DND_MIME, session.id);
        event.dataTransfer.effectAllowed = "copyMove";
      }}
    >
      <button
        type="button"
        className={cn(
          "relative w-full overflow-hidden text-left transition-all duration-100 rounded-lg",
          useLaneGlow
            ? ""
            : isHighlighted
              ? "bg-white/[0.06] hover:bg-white/[0.07]"
              : "bg-transparent hover:bg-white/[0.03]",
          isMultiSelected && "ring-1 ring-accent/35",
        )}
        style={{
          border: highlightedBorder,
          ...(useLaneGlow
            ? {
                background: laneTint ?? undefined,
                boxShadow: `inset 0 0 0 1px ${laneRing}`,
              }
            : {}),
        }}
        {...(orchestrationLabel ? { "aria-label": `${orchestrationLabel}: ${primaryText}` } : {})}
        onClick={(event) => onSelect(session.id, event)}
      >
        <div className={cn("flex items-stretch", compact ? "gap-2 px-2 py-1" : "gap-2.5 px-2.5 py-2")}>
          {/* Logo — vertically centered against full card height */}
          <div className="flex shrink-0 self-stretch items-center justify-center">
            <ToolLogo toolType={session.toolType} size={compact ? 18 : 26} />
          </div>

          {/* Content — 3 rows */}
          <div className="min-w-0 flex-1">
            {/* Row 1: Title + role pill + status dot + relative time */}
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate rounded px-1 -mx-1 font-semibold text-fg/90",
                  compact ? "text-[11px]" : "text-[13px]",
                )}
                style={{
                  transition: "background-color 900ms ease-out, box-shadow 900ms ease-out",
                  backgroundColor: titleJustChanged
                    ? `color-mix(in srgb, ${laneAccent ?? "rgb(250, 204, 21)"} 22%, transparent)`
                    : "transparent",
                  boxShadow: titleJustChanged
                    ? `0 0 0 2px color-mix(in srgb, ${laneAccent ?? "rgb(250, 204, 21)"} 16%, transparent)`
                    : "none",
                }}
              >
                {primaryText}
              </span>
              {attentionBadge ? <AttentionCapsule badge={attentionBadge} compact={compact} /> : null}
              <div className="flex shrink-0 items-center gap-1.5">
                {importedFrom ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border border-white/[0.08] bg-white/[0.04] font-semibold uppercase tracking-wide leading-none text-muted-fg/80",
                      compact ? "px-1 py-0.5 text-[8px]" : "px-1.5 py-0.5 text-[9px]",
                    )}
                    title={`Imported from ${providerDisplayName(importedFrom.provider)}`}
                    aria-label={`Imported from ${providerDisplayName(importedFrom.provider)}`}
                  >
                    Imported
                  </span>
                ) : null}
                {session.orchestrationRole ? (
                  <>
                    <span className="sr-only">{orchestrationLabel}</span>
                    <OrchestrationRolePill
                      role={session.orchestrationRole}
                      tag={session.orchestrationTag ?? null}
                    />
                  </>
                ) : null}
                {staleAgeHours != null ? (
                  <span
                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300"
                    aria-label="Idle session"
                    title={`This CLI or shell session has had no activity for about ${staleAgeHours} hours. Consider closing it to clean up memory if it is no longer in use.`}
                  >
                    <WarningCircle size={11} weight="fill" />
                  </span>
                ) : null}
                {gridBadge ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center justify-center",
                      isActiveGrid ? "text-violet-300" : "text-muted-fg/40",
                    )}
                    title={gridLabel}
                    aria-label={gridLabel}
                  >
                    <GridFour size={11} weight={isActiveGrid ? "fill" : "bold"} />
                  </span>
                ) : null}
                {awaitingUser ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-0.5 rounded-full font-semibold uppercase tracking-wide leading-none",
                      compact ? "px-1 py-0.5 text-[8px]" : "px-1.5 py-0.5 text-[9px]",
                    )}
                    style={{
                      color: laneAccent ?? "rgb(252, 211, 77)",
                      background: `color-mix(in srgb, ${laneAccent ?? "rgb(252, 211, 77)"} 16%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${laneAccent ?? "rgb(252, 211, 77)"} 34%, transparent)`,
                    }}
                    title="This chat is waiting for your answer"
                    aria-label="Awaiting your input"
                  >
                    <Question size={compact ? 9 : 10} weight="bold" />
                    {compact ? null : "Awaiting you"}
                  </span>
                ) : null}
                {inlineStatusLabel ? (
                  <span
                    className={cn(
                      "shrink-0 font-medium leading-none text-red-300/65",
                      compact ? "text-[9px]" : "text-[10px]",
                    )}
                    title={inlineStatusLabel}
                  >
                    {inlineStatusLabel}
                  </span>
                ) : null}
                <span
                  title={dot.label}
                  className={cn(
                    "shrink-0 rounded-full",
                    compact ? "h-2 w-2" : "h-2.5 w-2.5",
                    dot.cls,
                    dot.spinning && "animate-spin",
                  )}
                />
                <span className={cn("shrink-0 text-muted-fg/45 tabular-nums", compact ? "text-[9px]" : "text-[10px]")}>
                  {relativeTimeCompact(session.endedAt ?? session.startedAt)}
                </span>
              </div>
            </div>

            {/* Row 2: auto-naming status, else summary/preview line (conditional) */}
            {!compact && isAutoNaming ? (
              <div className="mt-0.5 min-w-0">
                <span className="block truncate text-[10px] italic text-muted-fg/45 leading-snug">
                  Auto-naming lane underway…
                </span>
              </div>
            ) : previewLine && !compact ? (
              <div className="mt-0.5 min-w-0">
                <span className="block truncate text-[10px] text-muted-fg/50 leading-snug">
                  {previewLine}
                </span>
              </div>
            ) : null}

            {/* Row 3: Cache badge + Delta chips + Exit code */}
            {hasFooterMeta ? (
              <div className={cn("flex items-center gap-1.5 min-w-0", compact ? "mt-px" : "mt-0.5")}>
                {showClaudeCacheTimer ? (
                  <ClaudeCacheTtlBadge idleSinceAt={session.chatIdleSinceAt} />
                ) : null}

                {hasDeltaChips && delta ? (
                  <>
                    {delta.insertions > 0 ? (
                      <span
                        className="border border-emerald-500/30 bg-emerald-500/15 px-1 py-0.5 text-emerald-300 leading-none shrink-0"
                        style={DELTA_CHIP_STYLE}
                      >
                        +{delta.insertions}
                      </span>
                    ) : null}
                    {delta.deletions > 0 ? (
                      <span
                        className="border border-red-500/30 bg-red-500/15 px-1 py-0.5 text-red-300 leading-none shrink-0"
                        style={DELTA_CHIP_STYLE}
                      >
                        -{delta.deletions}
                      </span>
                    ) : null}
                  </>
                ) : null}

                {session.exitCode != null && session.exitCode !== 0 ? (
                  <span
                    className={cn(
                      "px-1 py-0.5 leading-none shrink-0 border",
                      stoppedBySignal
                        ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
                        : "border-red-500/30 bg-red-500/15 text-red-300",
                    )}
                    style={DELTA_CHIP_STYLE}
                  >
                    {stoppedBySignal ? "STOPPED" : `EXIT ${session.exitCode}`}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </button>
    </div>
  );
});
