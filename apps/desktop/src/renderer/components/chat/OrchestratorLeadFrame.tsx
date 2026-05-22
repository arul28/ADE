/**
 * OrchestratorLeadFrame
 * ─────────────────────
 * Wrapper that renders an animated conic-gradient ring around the chat surface
 * when a session is acting as the orchestrator lead. The ring slowly cycles
 * through the rainbow (red → orange → yellow → green → blue → violet) to
 * communicate "this chat plans and dispatches work — it does not edit files".
 *
 * Behaviour:
 * - Default: animated CSS conic-gradient on a pseudo-border + subtle box-shadow
 *   pulse. Designed to add <40ms of render cost (single transform-only animation
 *   on a sibling element — no layout, no paint of the wrapped subtree).
 * - `@media (prefers-reduced-motion: reduce)`: a static rainbow border, no
 *   rotation, no pulse.
 *
 * The wrapper is layout-neutral: it does not change the flex/grid sizing of its
 * child, only adds an absolutely-positioned decorative ring overlay. Worker /
 * validator chats receive no rainbow.
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "../ui/cn";

const RAINBOW_GRADIENT =
  "conic-gradient(from 0deg, #ff5f5f, #ff9b3f, #f7d05c, #59d97f, #4f93ff, #a566ff, #ff5f5f)";

export const ORCHESTRATOR_LEAD_FRAME_TEST_ID = "orchestrator-lead-frame";
export const ORCHESTRATOR_LEAD_RING_TEST_ID = "orchestrator-lead-frame-ring";

const styleSheetId = "orchestrator-lead-frame-keyframes";

function ensureKeyframes(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(styleSheetId)) return;
  const sheet = document.createElement("style");
  sheet.id = styleSheetId;
  sheet.textContent = `
    @keyframes orchestrator-lead-ring-rotate {
      to { transform: rotate(360deg); }
    }
    @keyframes orchestrator-lead-ring-pulse {
      0%, 100% { box-shadow: 0 0 0 1px rgba(255,255,255,0.04), 0 0 32px 0 color-mix(in srgb, var(--color-accent, #a566ff) 14%, transparent); }
      50%      { box-shadow: 0 0 0 1px rgba(255,255,255,0.06), 0 0 56px 4px color-mix(in srgb, var(--color-accent, #a566ff) 22%, transparent); }
    }
    [data-orchestrator-lead-frame] {
      position: relative;
      isolation: isolate;
    }
    [data-orchestrator-lead-frame] > [data-orchestrator-lead-ring] {
      pointer-events: none;
      position: absolute;
      inset: 0;
      z-index: 0;
      border-radius: inherit;
    }
    /* Inner cutout — leaves a thin (1.5px) ring visible at the edge. */
    [data-orchestrator-lead-frame] > [data-orchestrator-lead-ring]::after {
      content: "";
      position: absolute;
      inset: 1.5px;
      border-radius: inherit;
      background: var(--color-bg, #0a0a0c);
    }
    /* Rotation layer carries the conic-gradient and spins via transform only. */
    [data-orchestrator-lead-frame] > [data-orchestrator-lead-ring]::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: ${RAINBOW_GRADIENT};
      /* Two layers of ring shading for depth without burning paint. */
      animation: orchestrator-lead-ring-rotate 14s linear infinite;
      transform-origin: 50% 50%;
      will-change: transform;
      opacity: 0.78;
    }
    [data-orchestrator-lead-frame][data-orchestrator-lead-frame-pulse="true"] {
      animation: orchestrator-lead-ring-pulse 4.8s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      [data-orchestrator-lead-frame] > [data-orchestrator-lead-ring]::before {
        animation: none !important;
        transform: none !important;
      }
      [data-orchestrator-lead-frame][data-orchestrator-lead-frame-pulse="true"] {
        animation: none !important;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.04), 0 0 32px 0 color-mix(in srgb, var(--color-accent, #a566ff) 14%, transparent);
      }
    }
  `;
  document.head.appendChild(sheet);
}

export function OrchestratorLeadFrame({
  active,
  pulse = true,
  radius = 16,
  children,
  className,
  style,
}: {
  /** When false, the wrapper renders children straight-through with no decoration. */
  active: boolean;
  /** When true (default), the wrapper also pulses a soft accent glow. */
  pulse?: boolean;
  /** Outer corner radius — should match the chat shell radius (default 16). */
  radius?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  if (active) ensureKeyframes();

  if (!active) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  // Outer wrapper carries the rotating ring layer. The inner div hosts the
  // chat surface and sits above the ring (via z-index from --inner-z) so the
  // pseudo-element's cutout (::after) leaves a thin colored edge.
  return (
    <div
      data-orchestrator-lead-frame=""
      data-orchestrator-lead-frame-pulse={pulse ? "true" : "false"}
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
