import { CaretRight, Copy } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

/**
 * One visual language for ADE's failure surfaces (project recovery, the page
 * and window crash boundaries, the CTO pane). They are rare screens, so they
 * drift easily; they are built on the surface kit (`styles/surfaceKit.css`)
 * like every other card, so a person who has seen one of them can read the
 * next one at a glance, and they read on light themes and over a picture.
 *
 * Hierarchy: exactly one primary (the thing to do), any number of secondaries
 * (the alternatives), and ghost for the meta actions — report, copy, disclose.
 */
export const ERROR_PRIMARY_BUTTON = "kit-btn kit-btn-primary";

export const ERROR_SECONDARY_BUTTON = "kit-btn";

/**
 * Same row, third rank: a way out that is worth offering but is not what this
 * particular failure asks for. Borderless so a row of three buttons still reads
 * as one primary and one alternative rather than three equal choices.
 */
export const ERROR_GHOST_BUTTON = "kit-btn kit-btn-ghost";

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

/** The headline every failure card leads with. */
export const ERROR_HEADLINE =
  "text-[16px] font-semibold leading-snug tracking-[-0.01em] text-fg";

/** The one hint line under it. */
export const ERROR_BODY = "mt-1 text-[12.5px] leading-relaxed text-(color:--kit-text-2)";

/**
 * The tones these surfaces use. `warning` is the default (something broke),
 * `success` closes a repair out, and `neutral` is for the states where nothing
 * is wrong and ADE is simply working — a warning there is the "broken ADE"
 * report those states exist to avoid.
 */
export type ErrorSurfaceTone = "warning" | "success" | "neutral" | "error";

const TONE_TAG: Record<ErrorSurfaceTone, "ok" | "warn" | "crit" | undefined> = {
  warning: "warn",
  success: "ok",
  neutral: undefined,
  error: "crit",
};

/**
 * The card every full-screen failure state sits in: a `.kit-card` whose 40px
 * head names what it is about (`label`) and its status as a tinted tag — the
 * only colour on the card — with an optional action on the right. Anything below the headline
 * (checklists, actions, notes) goes in as children.
 *
 * `hero` replaces the headline/body pair for the rare state that needs a richer
 * lede (the repair success report).
 */
export function ErrorSurfaceCard({
  tone = "warning",
  icon,
  label = "ADE",
  status,
  action,
  headline,
  body,
  hero,
  children,
}: {
  tone?: ErrorSurfaceTone;
  /** A neutral glyph for the head; the status colour lives on the tag. */
  icon?: ReactNode;
  label?: ReactNode;
  status?: string;
  /** The head's right-hand action (`.kit-card-head-action`), e.g. Back. */
  action?: ReactNode;
  headline?: ReactNode;
  body?: ReactNode;
  hero?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="kit-card" data-tone={tone}>
      <header className="kit-card-head">
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        {status ? (
          <span className="kit-tag shrink-0" data-tone={TONE_TAG[tone]}>
            {status}
          </span>
        ) : null}
        {action}
      </header>
      {/* Roomier than a dashboard card: this one card is the whole screen. */}
      <div className="kit-card-body" style={{ padding: "2px 18px 18px" }}>
        {hero ?? (
          <>
            <h1 className={ERROR_HEADLINE}>{headline}</h1>
            {body ? <p className={ERROR_BODY}>{body}</p> : null}
          </>
        )}
        {children}
      </div>
    </section>
  );
}

/**
 * A short "what to do" list. Kept plain: no icons, no emphasis —
 * these read as instructions, and decoration makes them read as decoration.
 */
export function WhatToDo({ title, steps }: { title: string; steps: readonly ReactNode[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-5 text-[12.5px] leading-relaxed text-(color:--kit-text-2)">
      <p className="font-medium text-fg">{title}</p>
      <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 marker:text-(color:--kit-text-3)">
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
    <div className={"kit-card " + (className ?? "")}>
      <details className="group">
        <summary className="flex h-9 cursor-pointer select-none items-center gap-3 px-3.5 pr-24 text-[12px] font-medium text-(color:--kit-text-3) transition-colors hover:text-fg">
          <span className="inline-flex items-center gap-1.5">
            {ERROR_DISCLOSURE_CARET}
            Show technical details
          </span>
        </summary>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-(color:--kit-rule) px-3.5 py-3 font-mono text-[11px] leading-relaxed text-(color:--kit-text-2)">
          {text}
        </pre>
      </details>
      <button
        type="button"
        onClick={() => void copy(text)}
        className="absolute right-3.5 top-2.5 inline-flex items-center gap-1 text-[11px] text-(color:--kit-text-3) transition-colors hover:text-fg"
      >
        <Copy size={12} weight="regular" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
