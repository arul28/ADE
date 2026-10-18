import React, { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";
import { cssZoomOf } from "../../lib/webZoom";

type RailGeometry = { ys: number[]; xs: number[] };

const sameGeometry = (a: RailGeometry | null, b: RailGeometry) => (
  a !== null
  && a.ys.length === b.ys.length
  && a.ys.every((y, index) => Math.abs(y - (b.ys[index] ?? 0)) < 0.5)
  && a.xs.every((x, index) => Math.abs(x - (b.xs[index] ?? 0)) < 0.5)
);

/**
 * Lanes in one GitHub stack, top layer first, joined by a thin rail on the
 * left. The rail sits where a shared-branch cluster's dashed border would, and
 * a short tick runs from it to each card's stack badge. Members without a
 * visible badge (a collapsed lane) get a tick at their first row.
 */
export function WorkStackRail({
  stackKey,
  className,
  members,
}: {
  stackKey: string;
  className?: string;
  members: { id: string; node: React.ReactNode }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<RailGeometry | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      // Screen rect differences, written as layout px in this relative box.
      const zoom = cssZoomOf(element);
      const next: RailGeometry = { ys: [], xs: [] };
      for (const member of element.querySelectorAll<HTMLElement>(":scope > [data-stack-rail-member]")) {
        const badge = member.querySelector<HTMLElement>("[data-github-stack-badge]");
        if (badge) {
          const rect = badge.getBoundingClientRect();
          next.ys.push((rect.top + rect.height / 2 - box.top) / zoom);
          next.xs.push((rect.left - box.left) / zoom);
        } else {
          next.ys.push((member.getBoundingClientRect().top - box.top) / zoom + 14);
          next.xs.push(8);
        }
      }
      setGeometry((previous) => (sameGeometry(previous, next) ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [members.length]);

  const first = geometry?.ys[0];
  const last = geometry?.ys[geometry.ys.length - 1];
  return (
    <div
      ref={ref}
      className={cn("relative", className)}
      data-testid="github-stack-rail"
      data-stack-key={stackKey}
    >
      {members.map((member) => (
        <div key={member.id} data-stack-rail-member={member.id} className="flow-root">
          {member.node}
        </div>
      ))}
      {geometry && first !== undefined && last !== undefined ? (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <span
            className="absolute left-0 w-px bg-violet-300/45"
            style={{ top: first, height: Math.max(0, last - first) }}
          />
          {geometry.ys.map((y, index) => {
            const width = (geometry.xs[index] ?? 0) - 3;
            return width > 0 ? (
              <span
                key={index}
                className="absolute left-0 h-px bg-violet-300/45"
                style={{ top: y, width }}
              />
            ) : null;
          })}
        </div>
      ) : null}
    </div>
  );
}
