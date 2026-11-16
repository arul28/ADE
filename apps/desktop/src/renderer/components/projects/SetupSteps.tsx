import { useEffect, useRef, useState, type ReactNode } from "react";
import "./getStarted.css";

export type SetupStepState = "todo" | "running" | "waiting" | "done" | "failed";

export type SetupStep = {
  id: string;
  title: ReactNode;
  state: SetupStepState;
  /** One quiet line under the title (the card layout only). */
  hint?: ReactNode;
  /** A control on the row's right: the step's action. */
  action?: ReactNode;
  /** Extra content under the row (a sign-in code, an error), card layout only. */
  detail?: ReactNode;
};

function StepMark({ state }: { state: SetupStepState }) {
  return (
    <svg className="ade-step-mark" viewBox="0 0 18 18" aria-hidden>
      <circle className="ade-step-mark-ring" cx="9" cy="9" r="7.25" />
      {state === "done" ? <path className="ade-step-mark-check" d="M5.6 9.3l2.3 2.2 4.5-4.7" /> : null}
      {state === "failed" ? <path className="ade-step-mark-check" d="M6.5 6.5l5 5M11.5 6.5l-5 5" /> : null}
    </svg>
  );
}

/**
 * Steps that finished while this list was on screen play the check once.
 * A step that was already done when the list mounted shows still.
 */
function useFreshDone(steps: readonly SetupStep[]): ReadonlySet<string> {
  const seen = useRef<Map<string, SetupStepState> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const signature = steps.map((step) => `${step.id}:${step.state}`).join("|");
  useEffect(() => {
    const before = seen.current;
    const next = new Map(steps.map((step) => [step.id, step.state] as const));
    seen.current = next;
    if (!before) return;
    const finished = steps.filter((step) => step.state === "done" && before.get(step.id) !== undefined && before.get(step.id) !== "done");
    if (finished.length === 0) return;
    setFresh((current) => new Set([...current, ...finished.map((step) => step.id)]));
    // The steps list changes only through its signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return fresh;
}

/**
 * A short list of setup steps: "Get started with ADE" on Home (card), the
 * project page's strip, and a new ADE Cloud computer's setup card. The first
 * step that isn't done is the current one.
 */
export function SetupSteps({
  steps,
  layout = "card",
  label,
}: {
  steps: readonly SetupStep[];
  layout?: "card" | "strip";
  label: string;
}) {
  const fresh = useFreshDone(steps);
  const currentId = steps.find((step) => step.state !== "done")?.id ?? null;
  return (
    <ol className="ade-steps" data-layout={layout} aria-label={label} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {steps.map((step) => (
        <li
          key={step.id}
          className="ade-step"
          data-state={step.state}
          data-current={step.id === currentId ? "true" : undefined}
          data-fresh={fresh.has(step.id) ? "true" : undefined}
          aria-current={step.id === currentId ? "step" : undefined}
        >
          <StepMark state={step.state} />
          <span className="ade-step-title">
            {step.title}
            {step.hint && layout === "card" ? <span className="ade-step-hint">{step.hint}</span> : null}
          </span>
          {step.action ? <span className="flex shrink-0 items-center gap-1.5">{step.action}</span> : <span />}
          {step.detail && layout === "card" ? <div style={{ gridColumn: "2 / 4" }}>{step.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
