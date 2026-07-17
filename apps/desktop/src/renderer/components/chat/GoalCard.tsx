import { Target } from "@phosphor-icons/react";
import type { ClaudeActiveGoal, CodexThreadGoal } from "../../../shared/types";
import { cn } from "../ui/cn";
import { CodexGoalCard } from "./codex/CodexGoalCard";

const AMBER = "#F59E0B";

/**
 * Shared goal surface used by both providers. Codex keeps its full edit / clear /
 * status controls (delegated to {@link CodexGoalCard}); the Claude variant is
 * read-only — the objective is owned by the CLI's `/goal` Stop-hook loop, so ADE
 * only reflects its condition, iteration count, and last check reason, with a
 * hint that it is managed through `/goal`.
 */
export type GoalCardProps =
  | {
      variant: "codex";
      goal: CodexThreadGoal;
      onEdit?: (nextObjective: string) => void;
      onClear?: () => void;
      onSetStatus?: (status: Extract<NonNullable<CodexThreadGoal["status"]>, "active" | "paused" | "blocked" | "complete">) => void;
      pending?: boolean;
    }
  | {
      variant: "claude";
      goal: ClaudeActiveGoal;
    };

function ClaudeGoalCard({ goal }: { goal: ClaudeActiveGoal }) {
  const condition = goal.condition.trim();
  if (!condition) return null;
  const lastReason = goal.lastReason?.trim();

  return (
    <section className="px-3 pb-3 pt-3">
      <div className="relative overflow-hidden rounded-lg border border-amber-400/15 bg-amber-500/[0.04] pl-3 pr-2 py-2.5">
        <span aria-hidden className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-amber-400/55" />

        <header className="flex items-center gap-2">
          <Target size={13} weight="duotone" aria-hidden style={{ color: AMBER }} className="shrink-0" />
          <span className="font-sans text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber-200/65">
            Goal
          </span>
          {goal.iterations > 0 ? (
            <span className="ml-auto inline-flex items-center rounded-full bg-amber-500/12 px-1.5 py-0.5 font-sans text-[10px] font-medium tracking-tight text-amber-100 ring-1 ring-inset ring-amber-400/30">
              iteration {goal.iterations}
            </span>
          ) : null}
        </header>

        <div className="mt-1.5 block w-full font-sans text-[13px] leading-snug text-amber-50" title={condition}>
          {condition}
        </div>

        {lastReason ? (
          <div className="mt-1.5 font-sans text-[11.5px] leading-snug text-amber-100/60">
            last: {lastReason}
          </div>
        ) : null}

        <div className="mt-2 font-sans text-[10.5px] tracking-tight text-amber-200/45">
          manage with <span className="font-medium text-amber-200/65">/goal</span>
        </div>
      </div>
    </section>
  );
}

export function GoalCard(props: GoalCardProps) {
  if (props.variant === "claude") {
    return <ClaudeGoalCard goal={props.goal} />;
  }
  return (
    <CodexGoalCard
      goal={props.goal}
      onEdit={props.onEdit}
      onClear={props.onClear}
      onSetStatus={props.onSetStatus}
      pending={props.pending}
    />
  );
}

export default GoalCard;
