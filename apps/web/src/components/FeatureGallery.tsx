import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { cn } from "../lib/cn";
import { ADE_EASE_OUT, revealTransition } from "../lib/motion";
import { Card } from "./Card";

export type FeatureGalleryItem = {
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
  imageSrc: string;
  imageAlt?: string;
};

function DesktopFeatureRow({
  feature,
  index,
  active,
  onActivate,
  onJump
}: {
  feature: FeatureGalleryItem;
  index: number;
  active: boolean;
  onActivate: (index: number) => void;
  onJump: (index: number) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref, { amount: 0.55, margin: "-35% 0px -55% 0px" });

  useEffect(() => {
    if (inView) onActivate(index);
  }, [inView, index, onActivate]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onJump(index)}
      className={cn(
        "focus-ring group relative w-full scroll-mt-28 text-left",
        "rounded-[22px] border bg-card/60 p-6 shadow-glass-sm",
        "transition-all duration-300 [transition-timing-function:var(--ease-out)]",
        "hover:-translate-y-0.5 hover:bg-card/70 hover:shadow-glass-md",
        active ? "border-accent/40 ring-1 ring-accent/20" : "border-border/70"
      )}
      aria-current={active ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-muted-fg">
            <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-accent" : "bg-border")} />
            {feature.eyebrow}
          </div>
          <div className="mt-2 text-base font-semibold tracking-tight text-fg">{feature.title}</div>
          <div className="mt-2 text-sm leading-relaxed text-muted-fg">{feature.description}</div>
        </div>
        <div className="hidden shrink-0 lg:block">
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold",
              active
                ? "border-accent/30 bg-[rgba(27,118,255,0.10)] text-fg"
                : "border-border/70 bg-card/60 text-muted-fg"
            )}
          >
            {active ? "Now showing" : "View"}
          </span>
        </div>
      </div>

      <ul className="mt-4 space-y-2 text-sm text-muted-fg">
        {feature.bullets.map((b) => (
          <li key={b} className="flex gap-3">
            <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-accent" : "bg-border")} />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

export function FeatureGallery({
  features,
  className,
  initialIndex = 0
}: {
  features: FeatureGalleryItem[];
  className?: string;
  initialIndex?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, Math.min(initialIndex, features.length - 1)));

  const sectionRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start end", "end start"] });
  const parallaxY = useTransform(scrollYProgress, [0, 1], [14, -14]);

  const active = features[activeIndex];

  const onActivate = useCallback((index: number) => {
    setActiveIndex((cur) => (cur === index ? cur : index));
  }, []);

  const desktopJump = useCallback(
    (index: number) => {
      const id = `feature-${index}`;
      const el = document.getElementById(id);
      if (!el) {
        onActivate(index);
        return;
      }
      el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    },
    [onActivate, reduceMotion]
  );

  const mobilePills = useMemo(
    () =>
      features.map((f, idx) => (
        <button
          key={f.title}
          type="button"
          className={cn(
            "focus-ring shrink-0 whitespace-nowrap rounded-full border px-3 py-2 text-xs font-semibold",
            "transition-colors duration-200 [transition-timing-function:var(--ease-out)]",
            activeIndex === idx
              ? "border-accent/30 bg-[rgba(27,118,255,0.10)] text-fg"
              : "border-border/70 bg-card/60 text-muted-fg hover:text-fg"
          )}
          onClick={() => onActivate(idx)}
          aria-pressed={activeIndex === idx}
        >
          {f.eyebrow}
        </button>
      )),
    [activeIndex, features, onActivate]
  );

  return (
    <div ref={sectionRef} className={cn(className)}>
      <div className="lg:hidden">
        <div className="flex gap-2 overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch]">{mobilePills}</div>

        <div className="mt-6">
          <Card className="overflow-hidden p-6">
            <AnimatePresence initial={false} mode="sync">
              <motion.div
                key={active.title}
                initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -10 }}
                transition={{ duration: 0.35, ease: ADE_EASE_OUT }}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">{active.eyebrow}</div>
                <div className="mt-2 text-xl font-semibold tracking-tight text-fg">{active.title}</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">{active.description}</p>

                <ul className="mt-5 space-y-2 text-sm text-muted-fg">
                  {active.bullets.map((b) => (
                    <li key={b} className="flex gap-3">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-6 overflow-hidden rounded-[18px] border border-border/70 bg-card/60">
                  <img
                    src={active.imageSrc}
                    alt={active.imageAlt ?? `${active.eyebrow} illustration`}
                    className="block w-full"
                    loading="lazy"
                  />
                </div>
              </motion.div>
            </AnimatePresence>
          </Card>
        </div>
      </div>

      <div className="hidden gap-10 lg:grid lg:grid-cols-2 lg:items-start">
        <div className="space-y-4">
          {features.map((f, idx) => (
            <motion.div
              key={f.title}
              id={`feature-${idx}`}
              initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
              whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              transition={revealTransition(idx * 0.03)}
            >
              <DesktopFeatureRow
                feature={f}
                index={idx}
                active={activeIndex === idx}
                onActivate={onActivate}
                onJump={desktopJump}
              />
            </motion.div>
          ))}
        </div>

        <div className="lg:sticky lg:top-24">
          <Card className="relative overflow-hidden p-4 shadow-glass-md">
            <motion.div style={reduceMotion ? undefined : { y: parallaxY }}>
              <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[rgba(85,211,255,0.16)] blur-3xl" />
              <div className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-[rgba(27,118,255,0.12)] blur-3xl" />

              <div className="relative overflow-hidden rounded-[18px] border border-border/70 bg-card/60">
                <AnimatePresence initial={false} mode="sync">
                  <motion.img
                    key={active.imageSrc}
                    src={active.imageSrc}
                    alt={active.imageAlt ?? `${active.eyebrow} illustration`}
                    className="block w-full"
                    initial={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.985 }}
                    animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.995 }}
                    transition={{ duration: 0.4, ease: ADE_EASE_OUT }}
                  />
                </AnimatePresence>
              </div>
            </motion.div>
          </Card>
        </div>
      </div>
    </div>
  );
}
