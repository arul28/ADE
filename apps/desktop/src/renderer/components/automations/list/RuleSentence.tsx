import { Fragment } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import type { RuleSentence as RuleSentenceValue } from "../automationCopy";

/**
 * Renders a rule as a readable sentence: "When <trigger> → <step> → <step>".
 * The `→` is a muted glyph, not text — the clauses carry the meaning.
 */
export function RuleSentence({
  sentence,
  className,
}: {
  sentence: RuleSentenceValue;
  className?: string;
}) {
  return (
    <div className={cn("leading-relaxed text-muted-fg/85", className)}>
      <span className="text-muted-fg/60">When </span>
      <span className="text-fg/90">{sentence.trigger}</span>
      {sentence.steps.map((step, i) => (
        <Fragment key={`${step}-${i}`}>
          <CaretRight size={10} weight="bold" className="mx-1 inline align-[-1px] text-muted-fg/40" />
          <span className="text-fg/80">{step}</span>
        </Fragment>
      ))}
    </div>
  );
}
