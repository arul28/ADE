import { CursorClick, Plus } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { AppControlElementSnapshot } from "../../../shared/types";
import { cn } from "../ui/cn";
import { elementSummary, observeBadgeGlyph } from "./appControlTrace";

const OVERSHOOT = [0.34, 1.56, 0.64, 1] as const;
/** Badges past this point appear together — a 60-item cascade reads as lag. */
const MAX_STAGGERED_BADGES = 24;

export type OverlayViewport = { viewportWidth: number; viewportHeight: number };

function percent(value: number, extent: number): number {
  if (!Number.isFinite(extent) || extent <= 0) return 0;
  return Math.max(0, Math.min(100, (value / extent) * 100));
}

/**
 * The observe map: one numbered badge per element in the latest observation,
 * painted over the live frame at the element's own bounds.
 *
 * This is the panel's answer to "what does `obs-…:e:7` mean" — the handle an
 * agent quotes in chat is a thing you can point at on screen. Badges are real
 * buttons so the map is walkable with Tab, and clicking one hands the handle
 * back (clipboard + "Add to chat") instead of driving the app.
 */
export function AppControlObserveOverlay({
  elements,
  viewport,
  activeHandle,
  copiedHandle,
  onSelectHandle,
  onAddToChat,
}: {
  elements: AppControlElementSnapshot[];
  viewport: OverlayViewport;
  activeHandle: string | null;
  copiedHandle: string | null;
  onSelectHandle: (handle: string, element: AppControlElementSnapshot) => void;
  onAddToChat: ((element: AppControlElementSnapshot) => void) | null;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  if (elements.length === 0) return null;

  return (
    <div
      className="absolute inset-0"
      role="group"
      aria-label="Observed elements"
      data-testid="app-control-observe-map"
    >
      {elements.map((element, order) => {
        const handle = element.handle ?? null;
        if (!handle) return null;
        const left = percent(element.frame.x, viewport.viewportWidth);
        const top = percent(element.frame.y, viewport.viewportHeight);
        const width = percent(element.frame.width, viewport.viewportWidth);
        const height = percent(element.frame.height, viewport.viewportHeight);
        const isActive = activeHandle === handle;
        const summary = elementSummary(element);
        const glyph = observeBadgeGlyph(element.index);
        const delay = reduceMotion ? 0 : Math.min(order, MAX_STAGGERED_BADGES) * 0.018;
        return (
          <div
            key={handle}
            className="pointer-events-none absolute"
            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-0 rounded-[3px] border transition-colors duration-[120ms] ease-out",
                isActive
                  ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]"
                  : "border-white/25 bg-white/[0.03]",
              )}
              // A white halo keeps the outline readable on light app surfaces
              // as well as dark ones.
              style={{ boxShadow: "0 0 0 1px rgb(255 255 255 / 0.35)" }}
            />
            <motion.button
              type="button"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: OVERSHOOT, delay }}
              onClick={() => onSelectHandle(handle, element)}
              title={summary ? `${handle} — ${summary}` : handle}
              aria-label={
                summary
                  ? `Element ${element.index}, ${summary}. Copy handle ${handle}.`
                  : `Element ${element.index}. Copy handle ${handle}.`
              }
              data-observe-handle={handle}
              className={cn(
                "pointer-events-auto absolute -left-px -top-px inline-flex h-[15px] min-w-[15px] items-center justify-center",
                "rounded-[4px] px-[3px] font-mono text-[9px] font-semibold leading-none",
                "transition-colors duration-[120ms] ease-out",
                "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-bg)]",
                isActive
                  ? "bg-[var(--color-accent)] text-[#14121F]"
                  : "bg-black/72 text-fg/90 hover:bg-[var(--color-accent)] hover:text-[#14121F]",
              )}
            >
              {glyph}
            </motion.button>

            {isActive ? (
              <div
                className={cn(
                  "pointer-events-auto absolute left-0 top-[calc(100%+4px)] z-20 w-[190px]",
                  "rounded-[var(--radius-md)] border border-white/[0.1] bg-card/95 p-1.5",
                  "shadow-[var(--shadow-popup)] backdrop-blur-[var(--blur-popup)]",
                )}
                role="group"
                aria-label={`Element ${element.index} handle`}
              >
                <div className="truncate font-mono text-[9.5px] text-muted-fg" title={handle}>
                  {handle}
                </div>
                {summary ? (
                  <div className="mt-0.5 truncate text-[10.5px] text-fg/85" title={summary}>
                    {summary}
                  </div>
                ) : null}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span
                    role="status"
                    className={cn(
                      "text-[9.5px] transition-opacity duration-[120ms]",
                      copiedHandle === handle ? "text-emerald-200/85 opacity-100" : "opacity-0",
                    )}
                  >
                    Copied
                  </span>
                  {onAddToChat ? (
                    <button
                      type="button"
                      onClick={() => onAddToChat(element)}
                      className={cn(
                        "ml-auto inline-flex h-[22px] items-center gap-1 rounded-[var(--radius-sm)]",
                        "border border-white/[0.1] bg-white/[0.04] px-2 text-[10.5px] font-medium text-fg/85",
                        "transition-colors duration-[120ms] ease-out hover:bg-white/[0.08]",
                        "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                      )}
                    >
                      <Plus size={9} weight="bold" />
                      Add to chat
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export type AgentCursorState = {
  nonce: number;
  x: number;
  y: number;
  action: string;
  failed: boolean;
};

/**
 * The agent cursor.
 *
 * Agent input teleports — CDP dispatches a click at a coordinate and nothing
 * about the frame says where it landed. Steel's replay overlay solves that by
 * *moving* a cursor to the point over a short lerp and pulsing a ring that
 * contracts inward, and this is that idea in ADE's tokens: 160ms to the target,
 * then a 200ms contract-in ring, then fade. Under reduced motion the cursor
 * simply appears at the point.
 */
export function AppControlAgentCursor({
  cursor,
  viewport,
}: {
  cursor: AgentCursorState | null;
  viewport: OverlayViewport;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <AnimatePresence initial={false}>
      {cursor ? (
        <motion.div
          key="agent-cursor"
          aria-hidden="true"
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2"
          data-testid="app-control-agent-cursor"
          initial={{ opacity: 0 }}
          animate={{
            opacity: 1,
            left: `${percent(cursor.x, viewport.viewportWidth)}%`,
            top: `${percent(cursor.y, viewport.viewportHeight)}%`,
          }}
          exit={{ opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
        >
          <motion.span
            key={cursor.nonce}
            className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: 20,
              height: 20,
              background: cursor.failed
                ? "color-mix(in srgb, #fb7185 45%, transparent)"
                : "color-mix(in srgb, var(--color-accent) 45%, transparent)",
            }}
            initial={{ opacity: 0.3, scale: 1 }}
            animate={reduceMotion ? { opacity: 0.3, scale: 1 } : { opacity: [0.3, 0.5, 0], scale: [1, 0.5, 0.5] }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: "easeInOut" }}
          />
          <CursorClick
            size={16}
            weight="fill"
            className="relative"
            style={{
              color: cursor.failed ? "#fda4af" : "var(--color-accent-bright)",
              filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.7))",
            }}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
