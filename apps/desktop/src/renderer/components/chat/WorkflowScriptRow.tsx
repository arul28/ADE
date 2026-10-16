import { useState } from "react";
import { CaretDown, CaretRight, ListChecks } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { pluralCount } from "../../../shared/formatting";
import { CHAT_CARD_WIDTH_CLASS } from "./chatCardPrimitives";
import type { WorkflowScriptRenderEvent } from "./chatTranscriptRows";

/**
 * The script a dynamic workflow ran, as one quiet line: `Ran workflow script ·
 * 42 lines · Scan → Report`. The phase titles come from the script's own
 * `meta.phases`, so they are the run's *plan*; open it to read the script.
 *
 * It sits where the Workflow tool call was, because for a run whose provider
 * publishes no live phase telemetry this row and the workflow's card are the
 * whole record of what it was asked to do.
 */
export function WorkflowScriptRow({ event }: { event: WorkflowScriptRenderEvent }) {
  const [open, setOpen] = useState(false);
  const planned = event.phases.length > 0 ? ` · ${event.phases.join(" → ")}` : "";
  return (
    <div className={cn(CHAT_CARD_WIDTH_CLASS, "min-w-0")} data-workflow-script={event.name ?? "workflow"}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} the workflow script (${event.lines} lines)`}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left font-sans text-[length:var(--chat-font-size)] text-fg/55 transition-colors hover:text-fg/85 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--chat-accent)]"
      >
        <span aria-hidden className="shrink-0 text-fg/35">
          {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
        </span>
        <ListChecks aria-hidden size={12} weight="bold" className="shrink-0 text-amber-300/75" />
        <span className="min-w-0 truncate" title={event.name ?? undefined}>
          Ran workflow script
        </span>
        <span className="shrink-0 text-fg/35">
          · {pluralCount(event.lines, "line")}{planned}
        </span>
      </button>
      {open ? (
        <div className="mt-1 max-h-96 overflow-auto rounded-md border border-fg/[0.08] bg-fg/[0.03] px-2.5 py-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/70">
            {event.script}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
