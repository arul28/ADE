import { CaretRight, Copy } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

/**
 * One visual language for ADE's failure surfaces (project recovery, the page
 * and window crash boundaries, the CTO pane). They are rare screens, so they
 * drift easily; keeping the button shapes and the technical fold here means a
 * person who has seen one of them can read the next one at a glance.
 *
 * Hierarchy: exactly one primary (the thing to do), any number of secondaries
 * (the alternatives), and ghost for the meta actions — report, copy, disclose.
 */
export const ERROR_PRIMARY_BUTTON =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-amber-400/90 px-4 text-[13px] font-semibold text-[#1a1206] transition-colors hover:bg-amber-300 disabled:opacity-60";

export const ERROR_SECONDARY_BUTTON =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border/80 bg-fg/[0.03] px-4 text-[13px] font-medium text-fg/75 transition-colors hover:bg-fg/[0.07] disabled:opacity-60";

/**
 * Same row, third rank: a way out that is worth offering but is not what this
 * particular failure asks for. Borderless so a row of three buttons still reads
 * as one primary and one alternative rather than three equal choices.
 */
export const ERROR_GHOST_BUTTON =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-fg/55 transition-colors hover:bg-fg/[0.05] hover:text-fg/80 disabled:opacity-60";

/**
 * The one disclosure affordance these surfaces use. `<summary>` drops its native
 * marker as soon as it is laid out as a flex box, and half of these folds are —
 * so the caret is drawn here and every fold gets the same one.
 */
export const ERROR_DISCLOSURE_CARET = (
  <CaretRight
    size={11}
    weight="bold"
    aria-hidden="true"
    className="shrink-0 transition-transform group-open:rotate-90"
  />
);

/** The card every full-screen failure state sits in. */
const ERROR_CARD =
  "rounded-2xl border border-border/70 bg-fg/[0.02] px-6 py-5 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]";

/** The headline every failure card leads with. */
export const ERROR_HEADLINE =
  "text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-fg/95";

/** The sentence under it. */
export const ERROR_BODY = "mt-1.5 text-[13px] leading-relaxed text-fg/60";

/**
 * The badge tones these surfaces use. `warning` is the default (something
 * broke), `success` closes a repair out, and `neutral` is for the states where
 * nothing is wrong and ADE is simply working — a warning badge there is the
 * "broken ADE" report those states exist to avoid.
 */
export type ErrorSurfaceTone = "warning" | "success" | "neutral";

const TONE_BADGE: Record<ErrorSurfaceTone, string> = {
  warning: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-400",
  neutral: "border-border/70 bg-fg/[0.04] text-fg/55",
};

/**
 * The card + badge + hero every full-screen failure state opens with. Three
 * screens used to hand-assemble this identical block and drifted apart a class
 * at a time; anything below the hero (checklists, actions, notes) goes in as
 * children.
 *
 * `hero` replaces the headline/body pair for the rare state that needs a richer
 * lede (the repair success report).
 */
export function ErrorSurfaceCard({
  tone = "warning",
  icon,
  headline,
  body,
  hero,
  children,
}: {
  tone?: ErrorSurfaceTone;
  icon: ReactNode;
  headline?: ReactNode;
  body?: ReactNode;
  hero?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={ERROR_CARD}>
      <div className="flex items-start gap-3.5">
        <div
          className={
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border "
            + TONE_BADGE[tone]
          }
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          {hero ?? (
            <>
              <h1 className={ERROR_HEADLINE}>{headline}</h1>
              {body ? <p className={ERROR_BODY}>{body}</p> : null}
            </>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * A short "what to do" list. Kept plain: no icons, no emphasis —
 * these read as instructions, and decoration makes them read as decoration.
 */
export function WhatToDo({ title, steps }: { title: string; steps: readonly ReactNode[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-5 text-[12.5px] leading-relaxed text-fg/60">
      <p className="font-medium text-fg/80">{title}</p>
      <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 marker:text-fg/25">
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The only place raw internals are allowed to appear. Collapsed by default so
 * the surface stays readable, with a Copy affordance because the next thing
 * people do with it is paste it somewhere.
 */
export function TechnicalDetailsFold({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { copy, copied } = useCopyToClipboard();
  if (!text.trim()) return null;
  return (
    // Copy sits ON the summary row but not INSIDE `<summary>`: a summary is
    // itself the disclosure control, and a button nested in one is flattened
    // away by some assistive technology and has to fight the toggle with
    // `preventDefault`. Overlaying it keeps the row people already know.
    <div className={"relative " + (className ?? "")}>
      <details className="group rounded-lg border border-border/60 bg-fg/[0.015]">
        <summary className="flex cursor-pointer select-none items-center gap-3 px-3.5 py-2.5 pr-24 text-[12px] font-medium text-fg/55 transition-colors hover:text-fg/80">
          <span className="inline-flex items-center gap-1.5">
            {ERROR_DISCLOSURE_CARET}
            Show technical details
          </span>
        </summary>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-fg/60">
          {text}
        </pre>
      </details>
      <button
        type="button"
        onClick={() => void copy(text)}
        className="absolute right-3.5 top-2.5 inline-flex items-center gap-1 text-[11px] text-fg/45 transition-colors hover:text-fg/75"
      >
        <Copy size={12} weight="regular" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
