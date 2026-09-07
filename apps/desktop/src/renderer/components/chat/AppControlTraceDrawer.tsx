import { CaretDown, ListChecks, WarningCircle, WifiSlash } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "../ui/cn";
import type { TraceRow } from "./appControlTrace";

/** ADE's canonical reveal curve (chat/BottomDrawerSection.tsx). */
const REVEAL = [0.4, 0, 0.2, 1] as const;

/**
 * The 28px footer under the frame.
 *
 * Three facts that are otherwise invisible while an agent drives an app: what
 * it just did, whether the app is logging errors, and whether requests are
 * failing. The Trace button is the way into the full ledger.
 */
export function AppControlStatusRow({
  lastLine,
  hint,
  consoleErrors,
  networkFailures,
  diagnosticsKnown,
  traceCount,
  traceOpen,
  onToggleTrace,
}: {
  lastLine: string | null;
  hint: string;
  consoleErrors: number;
  networkFailures: number;
  diagnosticsKnown: boolean;
  traceCount: number;
  traceOpen: boolean;
  onToggleTrace: () => void;
}) {
  return (
    <div className="flex h-[28px] shrink-0 items-center gap-2 border-t border-white/[0.08] px-2 text-[10.5px]">
      <span
        className={cn("min-w-0 flex-1 truncate", lastLine ? "text-fg/75" : "text-muted-fg/60")}
        title={lastLine ?? hint}
      >
        {lastLine ?? hint}
      </span>

      {diagnosticsKnown ? (
        <>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 tabular-nums",
              consoleErrors > 0 ? "text-rose-200/85" : "text-muted-fg/50",
            )}
            title={`${consoleErrors} console ${consoleErrors === 1 ? "error" : "errors"} in the last observation`}
          >
            <WarningCircle size={10} weight={consoleErrors > 0 ? "fill" : "regular"} />
            {consoleErrors}
          </span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 tabular-nums",
              networkFailures > 0 ? "text-amber-200/85" : "text-muted-fg/50",
            )}
            title={`${networkFailures} failed ${networkFailures === 1 ? "request" : "requests"} in the last observation`}
          >
            <WifiSlash size={10} />
            {networkFailures}
          </span>
        </>
      ) : null}

      <button
        type="button"
        onClick={onToggleTrace}
        aria-expanded={traceOpen}
        aria-label={traceOpen ? "Hide action trace" : "Show action trace"}
        title={traceCount > 0 ? `${traceCount} recorded ${traceCount === 1 ? "action" : "actions"}` : "No recorded actions yet"}
        className={cn(
          "inline-flex h-[20px] shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 font-medium",
          "transition-colors duration-[120ms] ease-out hover:bg-white/[0.06]",
          "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
          traceOpen ? "bg-white/[0.06] text-fg/85" : "text-muted-fg/75",
        )}
      >
        <ListChecks size={11} />
        Trace
        {traceCount > 0 ? <span className="tabular-nums text-muted-fg/60">{traceCount}</span> : null}
      </button>
    </div>
  );
}

/**
 * The trace ledger, as a drawer that slides up over the frame.
 *
 * Bounded by the service (latest N entries for the active session) and cleared
 * whenever the controlled window changes, because handles minted against the
 * previous document stop meaning anything.
 */
export function AppControlTraceDrawer({
  open,
  rows,
  onClose,
}: {
  open: boolean;
  rows: TraceRow[];
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="app-control-trace"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: REVEAL }}
          className="shrink-0 overflow-hidden border-t border-white/[0.08] bg-black/25"
          data-testid="app-control-trace-drawer"
        >
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
              Action trace
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close action trace"
              className={cn(
                "ml-auto inline-flex h-[18px] w-[18px] items-center justify-center rounded-[var(--radius-sm)]",
                "text-muted-fg/65 transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg",
                "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
              )}
            >
              <CaretDown size={10} weight="bold" />
            </button>
          </div>
          {rows.length === 0 ? (
            <div className="px-2 pb-2 text-[10.5px] text-muted-fg/60">
              Nothing yet. Agent actions on this app show up here.
            </div>
          ) : (
            <ul className="max-h-[152px] overflow-auto pb-1" aria-label="Recorded agent actions">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className={cn(
                    "flex items-baseline gap-2 px-2 py-[3px] text-[10.5px]",
                    row.failed ? "text-rose-200/85" : "text-fg/75",
                  )}
                  title={row.error ?? `${row.action} ${row.target} · ${row.relative}`}
                >
                  <span className="w-[42px] shrink-0 font-medium">{row.action}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-fg">{row.target}</span>
                  <span className="shrink-0 tabular-nums text-muted-fg/65">{row.duration}</span>
                  <span
                    className={cn(
                      "w-[38px] shrink-0 text-right text-[9.5px]",
                      row.failed ? "text-rose-200/85" : "text-muted-fg/50",
                    )}
                  >
                    {row.failed ? "failed" : row.relative}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
