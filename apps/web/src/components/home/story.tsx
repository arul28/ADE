import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { transform, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * A tall section whose inner stage pins to the viewport while the visitor
 * scrolls through it. `progress` runs 0 → 1 across the pinned stretch, so
 * every animation inside is driven by the scroll, never by a timer.
 */
export function useStickyProgress(): {
  ref: RefObject<HTMLDivElement>;
  progress: MotionValue<number>;
  reduceMotion: boolean;
} {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion() ?? false;
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  return { ref, progress: scrollYProgress, reduceMotion };
}

/** The index of the step the scroll is on, as React state that changes only at a step boundary. */
export function useStep(progress: MotionValue<number>, edges: number[]): number {
  const find = (v: number) => edges.reduce((step, edge, i) => (v >= edge ? i + 1 : step), 0);
  const [step, setStep] = useState(() => find(progress.get()));
  useMotionValueEvent(progress, "change", (v) => {
    const next = find(v);
    setStep((cur) => (cur === next ? cur : next));
  });
  return step;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-violet-bright)]">
      {children}
    </div>
  );
}

export function StoryHeading({
  eyebrow,
  title,
  children,
  className,
  center,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
  center?: boolean;
}) {
  return (
    <div className={cn("max-w-[640px]", center && "mx-auto text-center", className)}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2
        className="mt-3 font-serif font-normal text-white"
        style={{ fontSize: "clamp(32px, 4vw, 56px)", lineHeight: 1.04, letterSpacing: "-0.02em" }}
      >
        {title}
      </h2>
      {children ? <p className="mt-4 text-[clamp(15px,1.15vw,17px)] leading-[1.55] text-white/60">{children}</p> : null}
    </div>
  );
}

/** One line of a scroll-driven step list: bright when active, dim otherwise. */
export function StepLine({ active, title, body }: { active: boolean; title: string; body: string }) {
  return (
    <div
      className={cn(
        "border-l-2 py-1 pl-4 transition-[opacity,border-color] duration-300",
        active ? "border-[color:var(--color-violet-bright)] opacity-100" : "border-white/10 opacity-40",
      )}
    >
      <div className="text-[15px] font-medium text-white">{title}</div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300",
          active ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <p className="overflow-hidden text-[14px] leading-[1.5] text-white/60">{body}</p>
      </div>
    </div>
  );
}

/** True on screens wide enough for the pinned, scroll-driven layouts. */
export function useWideScreen(): boolean {
  const query = "(min-width: 640px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setWide(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/**
 * `useTransform(progress, input, output)` for values the browser could run on
 * its own scroll timeline (opacity). framer-motion 12 hands a plain opacity
 * transform of `useScroll` to a page-wide ScrollTimeline, which ignores the
 * section's offsets; the function form keeps it on the section's progress.
 */
export function useRange<T extends number | string>(progress: MotionValue<number>, input: number[], output: T[]): MotionValue<T> {
  return useTransform(progress, (v) => transform(v, input, output) as T);
}

/**
 * A stage laid out once at a fixed size and scaled as a whole to the space it
 * gets, so a narrow window shows the same composition smaller.
 */
export function FitStage({ width, height, children, className }: { width: number; height: number; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / width, el.clientHeight / height));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);
  return (
    <div ref={ref} className={cn("relative w-[94vw] flex-1", className)} style={{ maxWidth: width }}>
      <div className="absolute left-1/2 top-1/2" style={{ width, height, transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
