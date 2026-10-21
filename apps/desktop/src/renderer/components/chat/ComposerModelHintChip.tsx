import { memo } from "react";
import { ArrowDown, ArrowUp, X } from "@phosphor-icons/react";
import { SmartTooltip } from "../ui/SmartTooltip";
import { reasoningEffortTierLabel } from "../shared/ModelPicker/ReasoningEffortPicker";
import { shortName } from "./modelHint";
import type { ComposerModelHint } from "./useComposerModelHint";

function effortWord(effort: string | null): string {
  return effort ? reasoningEffortTierLabel(effort).toLowerCase() : "";
}

/** The chip for `useComposerModelHint`'s advice. */
export const ComposerModelHintChip = memo(function ComposerModelHintChip({ chip }: { chip: ComposerModelHint["chip"] }) {
  if (!chip) return null;
  const { hint, apply, dismiss } = chip;
  const Arrow = hint.direction === "up" ? ArrowUp : ArrowDown;
  const label = hint.effortOnly
    ? `${effortWord(hint.effort)} effort?`
    : `${shortName(hint.displayName)}${hint.effort ? ` · ${effortWord(hint.effort)}` : ""}?`;

  return (
    <SmartTooltip
      forceEnabled
      content={{ label: hint.effortOnly ? "Suggested effort" : "Suggested model", description: hint.reason }}
    >
      <span
        data-chat-composer-model-hint=""
        className="inline-flex h-6 min-w-0 shrink items-center rounded-md border border-dashed border-violet-400/30 font-sans text-[length:calc(var(--chat-font-size)*9/14)] leading-none text-fg/70"
      >
        <button
          type="button"
          aria-label={`Use ${hint.displayName}${hint.effort ? ` at ${effortWord(hint.effort)} effort` : ""}`}
          className="inline-flex h-full min-w-0 items-center gap-0.5 rounded-l-md pl-1.5 pr-1 hover:bg-violet-500/[0.08] hover:text-fg"
          onClick={apply}
        >
          <Arrow size={10} weight="bold" />
          <span className="max-w-32 truncate">{label}</span>
        </button>
        <button
          type="button"
          aria-label="Dismiss suggestion"
          className="inline-flex h-full items-center rounded-r-md px-1 text-fg/40 hover:bg-fg/[0.06] hover:text-fg"
          onClick={dismiss}
        >
          <X size={9} weight="bold" />
        </button>
      </span>
    </SmartTooltip>
  );
});
