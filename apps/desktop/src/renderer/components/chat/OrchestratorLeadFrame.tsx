/**
 * OrchestratorLeadFrame
 * ─────────────────────
 * Wrapper that renders a conic-gradient ring around the chat surface when a
 * session is acting as the orchestrator lead. The rainbow treatment communicates
 * "this chat plans and dispatches work — it does not edit files".
 *
 * Behaviour:
 * - Default: static CSS conic-gradient on a pseudo-border + subtle box-shadow.
 *
 * The wrapper is layout-neutral: it does not change the flex/grid sizing of its
 * child, only adds an absolutely-positioned decorative ring overlay. Worker /
 * validator chats receive no rainbow.
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "../ui/cn";

export const ORCHESTRATOR_LEAD_FRAME_TEST_ID = "orchestrator-lead-frame";
export const ORCHESTRATOR_LEAD_RING_TEST_ID = "orchestrator-lead-frame-ring";

export function OrchestratorLeadFrame({
  active,
  glow = true,
  radius = 16,
  children,
  className,
  style,
}: {
  /** When false, the wrapper renders children straight-through with no decoration. */
  active: boolean;
  /** When true (default), the wrapper also shows a soft static accent glow. */
  glow?: boolean;
  /** Outer corner radius — should match the chat shell radius (default 16). */
  radius?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  if (!active) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  // Outer wrapper carries the ring layer. The inner div hosts the
  // chat surface and sits above the ring (via z-index from --inner-z) so the
  // pseudo-element's cutout (::after) leaves a thin colored edge.
  return (
    <div
      data-orchestrator-lead-frame=""
      data-orchestrator-lead-frame-glow={glow ? "true" : "false"}
      data-testid={ORCHESTRATOR_LEAD_FRAME_TEST_ID}
      className={cn("relative", className)}
      style={{ borderRadius: radius, ...style }}
    >
      <div
        data-orchestrator-lead-ring=""
        data-testid={ORCHESTRATOR_LEAD_RING_TEST_ID}
        aria-hidden
      />
      <div className="relative z-[1] h-full w-full" style={{ borderRadius: radius }}>
        {children}
      </div>
    </div>
  );
}

export default OrchestratorLeadFrame;
