import React from "react";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";
import type { DigestPushTick } from "./prDigestTimelineModel";

/**
 * A thin rail of ticks on the Overview's right edge — one per push. A click
 * scrolls the thread to that push's section; hovering shows what the push was
 * and how much conversation it drew. A tick with open findings is amber, and a
 * tick with any conversation is longer and brighter. Every tick sits on the
 * rail's center line.
 */
export function PrPushTickRail({
  ticks,
  activeId,
  onSelect,
}: {
  ticks: DigestPushTick[];
  activeId: string | null;
  onSelect: (tick: DigestPushTick) => void;
}) {
  const [hover, setHover] = React.useState<{ tick: DigestPushTick; top: number } | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const place = (target: HTMLElement, tick: DigestPushTick) => {
    const wrapper = wrapperRef.current?.getBoundingClientRect();
    const own = target.getBoundingClientRect();
    setHover({ tick, top: wrapper ? own.top - wrapper.top : 0 });
  };
  if (ticks.length === 0) return null;
  return (
    // The tooltip lives outside the scrolling list, which would clip it.
    // A solid pill over the thread's scrollbar: the ticks sit on it, so the
    // scrollbar thumb can never paint across them.
    <div ref={wrapperRef} className="absolute z-30" style={{ right: 4, top: 10, bottom: 300 }} onMouseLeave={() => setHover(null)}>
    <nav
      aria-label="Pushes"
      data-testid="pr-push-tick-rail"
      className="flex max-h-full flex-col items-center gap-[5px] rounded-full px-[5px] py-[7px]"
      style={{
        overflowY: "auto",
        scrollbarWidth: "none",
        background: "color-mix(in srgb, var(--color-card, #16141c) 94%, transparent)",
        boxShadow: "0 6px 18px -10px rgba(0,0,0,0.7), inset 0 0 0 1px color-mix(in srgb, var(--color-fg) 8%, transparent)",
        backdropFilter: "blur(8px)",
      }}
    >
      {ticks.map((tick) => {
        const active = tick.id === activeId;
        const talked = tick.commentCount > 0;
        const tone = tick.openCount > 0
          ? COLORS.warning
          : active
            ? "var(--color-accent)"
            : `color-mix(in srgb, var(--color-fg) ${talked ? 58 : 26}%, transparent)`;
        return (
          <button
            key={tick.id}
            type="button"
            aria-label={`Jump to ${tick.shortSha}: ${tick.subject.split("\n")[0]}`}
            aria-current={active || undefined}
            data-testid="pr-push-tick"
            data-talked={talked || undefined}
            onClick={() => onSelect(tick)}
            onMouseEnter={(event) => place(event.currentTarget, tick)}
            onFocus={(event) => place(event.currentTarget, tick)}
            onBlur={() => setHover(null)}
            className="flex h-[10px] w-[12px] items-center justify-center"
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            <span
              aria-hidden
              className="block rounded-full"
              style={{ width: active ? 12 : talked ? 9 : 6, height: 3, background: tone, transition: "width 120ms ease, background 120ms ease" }}
            />
          </button>
        );
      })}
    </nav>
      {hover ? (
        <div
          role="tooltip"
          data-testid="pr-push-tick-preview"
          className="pointer-events-none absolute right-7 w-[240px] rounded-lg px-3 py-2"
          style={{
            top: Math.max(0, hover.top - 18),
            background: "var(--color-popup-bg, var(--color-card))",
            boxShadow: "0 16px 40px -16px rgba(0,0,0,0.8), inset 0 0 0 1px color-mix(in srgb, var(--color-fg) 8%, transparent)",
            fontFamily: SANS_FONT,
          }}
        >
          <div className="flex items-center gap-1.5 text-[10.5px]" style={{ color: COLORS.textMuted }}>
            <span style={{ fontFamily: MONO_FONT, color: COLORS.accent }}>{hover.tick.shortSha}</span>
            <span>· {relativeWhen(hover.tick.at)}</span>
            {hover.tick.commitCount > 1 ? <span>· {hover.tick.commitCount} commits</span> : null}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12px] font-medium" style={{ color: COLORS.textPrimary }}>
            {hover.tick.subject.split("\n")[0]}
          </div>
          <div className="mt-1 text-[10.5px]" style={{ color: hover.tick.openCount > 0 ? COLORS.warning : COLORS.textMuted }}>
            {hover.tick.commentCount === 0
              ? "No comments"
              : `${hover.tick.commentCount} comment${hover.tick.commentCount === 1 ? "" : "s"}${hover.tick.openCount > 0 ? ` · ${hover.tick.openCount} open` : ""}`}
          </div>
        </div>
      ) : null}
    </div>
  );
}
