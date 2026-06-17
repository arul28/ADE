/**
 * PlanningTimeline — surfaces the deterministic planning sequence in the
 * orchestration panel: the codebase-intake summary plus the three deliberation
 * rounds (functional → UI → extras) as a vertical stepper with each question
 * and the user's answer inline. Replaces the brittle decision-log scraping of
 * PlanningEmptyState whenever structured planning state is present.
 *
 * The data comes from `manifest.leadState.planning` (see the planning state
 * machine in orchestrationService). This component is pure presentation.
 */

import {
  CheckCircle,
  Circle,
  CircleDashed,
  Files,
  MinusCircle,
} from "@phosphor-icons/react";
import type {
  PlanningRoundKind,
  PlanningRoundRecord,
  PlanningState,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";

const ROUND_ORDER: { kind: PlanningRoundKind; label: string }[] = [
  { kind: "functional", label: "Functional requirements" },
  { kind: "ui", label: "UI design" },
  { kind: "extras", label: "Extras" },
];

type RoundStatus = "done" | "active" | "pending" | "skipped";

function activeKindForStage(stage: PlanningState["stage"]): PlanningRoundKind | null {
  if (stage === "round_functional") return "functional";
  if (stage === "round_ui") return "ui";
  if (stage === "round_extras") return "extras";
  return null;
}

function answerText(round: PlanningRoundRecord): string | null {
  const ids = round.selectedOptionIds ?? [];
  if (ids.length && round.options?.length) {
    const labels = ids.map((id) => round.options?.find((o) => o.id === id)?.label ?? id).filter(Boolean);
    const joined = labels.join(", ");
    return round.freeText ? `${joined} — ${round.freeText}` : joined;
  }
  if (ids.length) return round.freeText ? `${ids.join(", ")} — ${round.freeText}` : ids.join(", ");
  return round.freeText ?? null;
}

function StatusGlyph({ status }: { status: RoundStatus }) {
  if (status === "done") return <CheckCircle size={13} weight="fill" className="text-emerald-300/85" />;
  if (status === "active") return <CircleDashed size={13} weight="bold" className="animate-pulse text-violet-200" />;
  if (status === "skipped") return <MinusCircle size={13} weight="duotone" className="text-muted-fg/45" />;
  return <Circle size={12} weight="bold" className="text-muted-fg/35" />;
}

function RoundBlock({
  label,
  status,
  primary,
  cascades,
}: {
  label: string;
  status: RoundStatus;
  primary: PlanningRoundRecord | null;
  cascades: PlanningRoundRecord[];
}) {
  const answered = primary ? answerText(primary) : null;
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 inline-flex shrink-0 items-center justify-center">
        <StatusGlyph status={status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-sans text-[11.5px] font-semibold text-fg/82">{label}</span>
          <span
            className={cn(
              "font-mono text-[9px] uppercase tracking-[0.16em]",
              status === "done" && "text-emerald-200/70",
              status === "active" && "text-violet-200/80",
              status === "skipped" && "text-muted-fg/45",
              status === "pending" && "text-muted-fg/40",
            )}
          >
            {status}
          </span>
        </div>
        {primary ? (
          <div className="mt-0.5 space-y-0.5">
            <div className="font-sans text-[11px] leading-snug text-fg/70">{primary.question}</div>
            {answered ? (
              <div className="font-sans text-[11px] leading-snug text-muted-fg/75">
                <span className="text-muted-fg/45">→ </span>
                {answered}
              </div>
            ) : null}
            {primary.lockedSummary ? (
              <div className="font-sans text-[10.5px] italic leading-snug text-fg/55">{primary.lockedSummary}</div>
            ) : null}
          </div>
        ) : status === "active" ? (
          <div className="mt-0.5 font-sans text-[11px] leading-snug text-violet-100/70">Asking you now…</div>
        ) : null}
        {cascades.length > 0 ? (
          <ul className="mt-1 space-y-1 border-l border-white/[0.08] pl-2">
            {cascades.map((c) => {
              const ca = answerText(c);
              return (
                <li key={c.id} className="font-sans text-[10.5px] leading-snug text-muted-fg/70">
                  <span className="text-violet-200/60">↳ added: </span>
                  {c.question}
                  {ca ? <span className="text-muted-fg/55"> → {ca}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

export function PlanningTimeline({ planning }: { planning: PlanningState }) {
  const intake = planning.intake;
  const skipped = new Set(planning.overrides?.skippedRounds ?? []);
  const active = activeKindForStage(planning.stage);

  return (
    <div
      data-testid="orchestration-planning-timeline"
      className="space-y-2.5 rounded-md border border-violet-300/15 bg-violet-300/[0.04] px-2.5 py-2.5"
    >
      {/* Codebase intake summary (one line) */}
      {intake ? (
        <div className="flex items-start gap-1.5 border-b border-white/[0.06] pb-2">
          <Files size={13} weight="duotone" className="mt-0.5 shrink-0 text-violet-200/70" />
          <div className="min-w-0 flex-1 font-sans text-[11px] leading-snug text-fg/70">
            <span className="font-semibold text-fg/80">Codebase intake</span>
            <span className="text-muted-fg/55"> · {intake.projectShape}</span>
            {intake.testStack ? <span className="text-muted-fg/45"> · tests: {intake.testStack}</span> : null}
          </div>
        </div>
      ) : (
        <div className="border-b border-white/[0.06] pb-2 font-sans text-[11px] text-muted-fg/55">
          Reading the codebase…
        </div>
      )}

      <ul className="space-y-2">
        {ROUND_ORDER.map(({ kind, label }) => {
          const primary = planning.rounds.find((r) => r.kind === kind && !r.cascadedFrom) ?? null;
          const cascades = planning.rounds.filter((r) => r.kind === kind && r.cascadedFrom);
          const status: RoundStatus = primary
            ? "done"
            : skipped.has(kind)
              ? "skipped"
              : active === kind
                ? "active"
                : "pending";
          return <RoundBlock key={kind} label={label} status={status} primary={primary} cascades={cascades} />;
        })}
      </ul>

      {planning.stage === "ready" ? (
        <div className="border-t border-white/[0.06] pt-2 font-sans text-[11px] text-emerald-200/75">
          Deliberation complete — review the plan below and Implement when ready.
        </div>
      ) : null}
    </div>
  );
}
