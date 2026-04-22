import { motion, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

/**
 * Reusable iPhone mockup — bezel + Dynamic Island + inner violet glow.
 * Used for the fold's DeviceComposition and the mobile chapter's cutout.
 */
export function IPhoneFrame({
  src,
  alt,
  rotate = 0,
  className,
  width = "w-[220px] sm:w-[240px]",
  /** when true, wraps with an editorial-style caption */
  figCaption,
}: {
  src: string;
  alt: string;
  rotate?: number;
  className?: string;
  width?: string;
  figCaption?: { figNumber: string; caption: string; tone?: "ink" | "cream" };
}) {
  const reduceMotion = useReducedMotion() ?? true;
  const frameShadow = "drop-shadow(0 30px 60px rgba(124,58,237,0.45))";

  const frame = (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0.3, filter: `blur(10px) ${frameShadow}` }}
      whileInView={reduceMotion ? undefined : { opacity: 1, filter: `blur(0px) ${frameShadow}` }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      className={cn("relative mx-auto", width, className)}
      style={{
        transform: `rotate(${rotate}deg)`,
        filter: frameShadow,
      }}
    >
      <div className="relative aspect-[9/19.5] overflow-hidden rounded-[36px] border-[7px] border-[#0c0c12] bg-black ring-1 ring-[color:var(--color-hairline-strong)]">
        {/* Dynamic Island */}
        <div aria-hidden="true" className="absolute left-1/2 top-[7px] z-[2] h-[22px] w-[42%] -translate-x-1/2 rounded-full bg-black" />
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover object-left-top"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[30px]"
          style={{ boxShadow: "inset 0 0 44px rgba(124,58,237,0.32)" }}
        />
      </div>
    </motion.div>
  );

  if (!figCaption) return frame;

  const captionTone = figCaption.tone ?? "ink";
  return (
    <figure className="mx-auto w-full">
      {frame}
      <figcaption
        className={cn(
          "mx-auto mt-5 max-w-[28ch] text-center font-serif italic",
          captionTone === "ink"
            ? "text-[color:var(--color-ink-muted)]"
            : "text-[color:var(--color-cream-muted)]"
        )}
        style={{ fontSize: "15px", lineHeight: 1.4 }}
      >
        <span
          className={cn(
            "mr-2 inline-block align-middle font-sans text-[10px] uppercase tracking-[0.22em] not-italic",
            captionTone === "ink"
              ? "text-[color:var(--color-accent)]"
              : "text-[color:var(--color-violet-bright)]"
          )}
        >
          {figCaption.figNumber}
        </span>
        {figCaption.caption}
      </figcaption>
    </figure>
  );
}
