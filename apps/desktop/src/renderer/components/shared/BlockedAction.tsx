import type { ReactNode } from "react";
import { Warning } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

/**
 * The blocked-action primitive.
 *
 * ADE keeps regrowing the same bug: a surface computes a list of blocking
 * reasons, uses it to disable the primary button, and then renders none of it.
 * The cross-machine handoff modal shipped exactly that — it pushed "Update the
 * source branch before handing it off" into `blockingErrors` and drew three
 * green check rows plus a dead "Continue" button, so a branch that was merely
 * *behind* looked completely healthy and the user had no way to learn why
 * nothing happened.
 *
 * The fix is structural rather than a one-off copy change: `BlockedActionButton`
 * takes the reasons themselves instead of a `disabled` boolean, so a caller
 * cannot disable the button without having handed over the explanation. Pair it
 * with `BlockedReasons` to render those reasons inline with their fixes.
 *
 * Rule for reviewers: if a surface computes a blocker, that blocker must reach
 * the user. A disabled control may never be the only signal.
 */

export type BlockedActionReason = {
  /** Stable identity — used as the React key and for the accessible description. */
  id: string;
  /** One line naming what is blocking, in the user's terms. */
  title: string;
  /** Why it matters, or what happens if it is ignored. */
  detail?: string;
  /**
   * The actions that clear this blocker. The first is the primary one; the
   * rest render after it as quieter buttons ("Publish branch", then "Bring
   * them along"). Omit when the fix genuinely lives elsewhere (another
   * machine, another app) — then `detail` must say where to go.
   */
  fixes?: BlockedActionFix[];
};

export type BlockedActionFix = {
  label: string;
  onFix: () => void;
  /** Disables the fix while another operation on the same surface is running. */
  busy?: boolean;
};

/** Flattens reasons into the one-line summary used for tooltips and a11y text. */
export function describeBlockedReasons(reasons: BlockedActionReason[]): string {
  return reasons
    .map((reason) => (reason.detail ? `${reason.title} — ${reason.detail}` : reason.title))
    .join(" · ");
}

export function BlockedReasons({
  reasons,
  heading,
  className,
  variant = "card",
}: {
  reasons: BlockedActionReason[];
  /** Optional lead-in, e.g. "Two things to fix first". Omitted for a single obvious blocker. */
  heading?: string;
  className?: string;
  /**
   * `card` (default) stacks title, detail and fixes. `rows` draws each reason
   * as one line (icon, title, fixes on the right) for compact dialogs; the
   * detail moves to the row's tooltip, or shows inline when nothing can fix it.
   */
  variant?: "card" | "rows";
}): JSX.Element | null {
  if (reasons.length === 0) return null;
  if (variant === "rows") {
    return (
      <div role="alert" className={cn("flex flex-col gap-1", className)}>
        {reasons.map((reason) => (
          <div
            key={reason.id}
            id={blockedReasonDomId(reason.id)}
            title={reason.detail}
            className="flex min-h-9 items-center gap-2 rounded-lg border border-rose-300/18 bg-rose-400/[0.05] px-2.5 py-1"
          >
            <Warning size={13} weight="fill" className="shrink-0 text-rose-300/80" />
            <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-rose-50/90">{reason.title}</span>
            {!reason.fixes?.length && reason.detail ? (
              <span className="min-w-0 truncate text-[10.5px] text-rose-100/55">{reason.detail}</span>
            ) : null}
            {reason.fixes?.length ? (
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {reason.fixes.map((fix, index) => (
                  <button
                    key={fix.label}
                    type="button"
                    disabled={fix.busy}
                    onClick={fix.onFix}
                    className={index === 0
                      ? "inline-flex h-6 items-center whitespace-nowrap rounded-md border border-sky-300/45 bg-transparent px-2 text-[10.5px] font-semibold text-sky-100 transition-colors hover:bg-sky-400/15 disabled:opacity-45"
                      : "inline-flex h-6 items-center whitespace-nowrap rounded-md border border-fg/[0.12] bg-fg/[0.03] px-2 text-[10.5px] font-semibold text-fg/75 transition-colors hover:bg-fg/[0.07] hover:text-fg/90 disabled:opacity-45"}
                  >
                    {fix.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-rose-300/22 bg-rose-400/[0.06] px-3 py-2.5",
        className,
      )}
    >
      {heading ? (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-rose-100/85">
          <Warning size={13} weight="fill" />
          {heading}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {reasons.map((reason) => (
          <div key={reason.id} id={blockedReasonDomId(reason.id)}>
            <div className="text-[11px] font-semibold leading-4 text-rose-50/90">{reason.title}</div>
            {reason.detail ? (
              <div className="mt-0.5 text-[10px] leading-4 text-rose-100/58">{reason.detail}</div>
            ) : null}
            {reason.fixes?.length ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {reason.fixes.map((fix, index) => (
                  <button
                    key={fix.label}
                    type="button"
                    disabled={fix.busy}
                    onClick={fix.onFix}
                    className={index === 0
                      ? "inline-flex h-7 items-center rounded-md border border-rose-200/25 bg-rose-300/10 px-2.5 text-[10px] font-semibold text-rose-50 transition-colors hover:bg-rose-300/16 disabled:opacity-45"
                      : "inline-flex h-7 items-center rounded-md border border-fg/[0.12] bg-fg/[0.03] px-2.5 text-[10px] font-semibold text-fg/75 transition-colors hover:bg-fg/[0.07] hover:text-fg/90 disabled:opacity-45"}
                  >
                    {fix.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BlockedActionButton({
  reasons,
  busy,
  onClick,
  children,
  className,
  type = "button",
}: {
  /**
   * Every reason the action cannot run. Non-empty disables the button, and the
   * reasons become its tooltip and accessible description — which is why this
   * replaces a plain `disabled` prop.
   */
  reasons: BlockedActionReason[];
  /** In-flight state. Disables without implying the action is blocked. */
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  type?: "button" | "submit";
}): JSX.Element {
  const blocked = reasons.length > 0;
  const summary = blocked ? describeBlockedReasons(reasons) : undefined;
  return (
    <button
      type={type}
      disabled={blocked || busy}
      onClick={onClick}
      {...(summary ? { title: summary } : {})}
      {...(blocked
        ? { "aria-describedby": reasons.map((reason) => blockedReasonDomId(reason.id)).join(" ") }
        : {})}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/30 bg-accent/14 px-3 text-[11px] font-semibold text-fg transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-35",
        className,
      )}
    >
      {children}
    </button>
  );
}

function blockedReasonDomId(id: string): string {
  return `blocked-reason-${id}`;
}
