import { motion, useReducedMotion } from "framer-motion";

type Callout = {
  label: string;
  /** anchor on the image, 0–100 (percent of image width/height) */
  x: number;
  y: number;
  /** direction the arrow points from the label toward the anchor */
  from: "top" | "bottom" | "left" | "right";
};

/**
 * Annotated figure — screenshot with hand-drawn-feel callout arrows +
 * small caps labels pointing at UI regions.
 * Callouts coordinate space is 0–100 percent of image box.
 */
export function AnnotatedFigure({
  src,
  alt,
  figNumber,
  caption,
  callouts,
  className,
}: {
  src: string;
  alt: string;
  figNumber: string;
  caption: string;
  callouts: Callout[];
  className?: string;
}) {
  const reduceMotion = useReducedMotion() ?? true;

  return (
    <figure className={className}>
      <motion.div
        initial={reduceMotion ? false : { opacity: 0.35, filter: "blur(10px)" }}
        whileInView={
          reduceMotion ? undefined : { opacity: 1, filter: "blur(0px)" }
        }
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        className="relative"
      >
        <div className="relative overflow-hidden border border-[color:var(--color-ink-hairline)] shadow-[0_24px_48px_-24px_rgba(24,21,15,0.45)]">
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="block w-full"
          />
        </div>

        {/* Callouts overlay */}
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          {callouts.map((c, i) => {
            // Place label anchor offset based on 'from' direction
            const labelDx = c.from === "left" ? -14 : c.from === "right" ? 14 : 0;
            const labelDy = c.from === "top" ? -12 : c.from === "bottom" ? 12 : 0;
            const labelX = c.x + labelDx;
            const labelY = c.y + labelDy;
            // wavy path for hand-drawn feel
            const midX = (c.x + labelX) / 2 + (i % 2 === 0 ? 1.5 : -1.5);
            const midY = (c.y + labelY) / 2 + (i % 2 === 0 ? -1.5 : 1.5);
            return (
              <motion.path
                key={i}
                initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
                whileInView={reduceMotion ? undefined : { pathLength: 1, opacity: 1 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{
                  duration: 0.9,
                  delay: 0.3 + i * 0.15,
                  ease: "easeOut",
                }}
                d={`M ${labelX} ${labelY} Q ${midX} ${midY} ${c.x} ${c.y}`}
                stroke="rgba(124,58,237,0.75)"
                strokeWidth="0.35"
                strokeLinecap="round"
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {/* Callout labels — rendered outside SVG so text stays crisp */}
        {callouts.map((c, i) => {
          const labelDx = c.from === "left" ? -14 : c.from === "right" ? 14 : 0;
          const labelDy = c.from === "top" ? -12 : c.from === "bottom" ? 12 : 0;
          const labelX = c.x + labelDx;
          const labelY = c.y + labelDy;
          const alignX = c.from === "left" ? "flex-end" : "flex-start";
          return (
            <motion.div
              key={`label-${i}`}
              aria-hidden="true"
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.45, delay: 0.6 + i * 0.15 }}
              className="pointer-events-none absolute flex"
              style={{
                left: `${labelX}%`,
                top: `${labelY}%`,
                transform: `translate(${
                  c.from === "left" ? "-100%" : c.from === "right" ? "0" : "-50%"
                }, ${c.from === "top" ? "-100%" : c.from === "bottom" ? "0" : "-50%"})`,
                justifyContent: alignX,
              }}
            >
              <span
                className="rounded-[2px] border border-[color:var(--color-accent)] bg-[color:var(--color-paper)] px-2 py-[3px] font-sans text-[10px] font-medium uppercase tracking-[0.18em] text-[color:var(--color-accent)] shadow-[0_4px_12px_-4px_rgba(24,21,15,0.3)]"
                style={{ whiteSpace: "nowrap" }}
              >
                {c.label}
              </span>
            </motion.div>
          );
        })}
      </motion.div>

      <figcaption
        className="mt-5 font-serif italic text-[color:var(--color-ink-muted)]"
        style={{ fontSize: "15px", lineHeight: 1.4 }}
      >
        <span className="mr-2 inline-block align-middle font-sans text-[10px] uppercase tracking-[0.22em] not-italic text-[color:var(--color-accent)]">
          {figNumber}
        </span>
        {caption}
      </figcaption>
    </figure>
  );
}
