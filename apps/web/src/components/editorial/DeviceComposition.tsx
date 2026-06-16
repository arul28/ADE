import { motion, useReducedMotion } from "framer-motion";

const HERO_IMAGES = {
  tui: { src: "/images/hero/hero-tui.png", alt: "ADE Code TUI — terminal-native Work chat" },
  desktop: { src: "/images/hero/hero-desktop.png", alt: "ADE on macOS — desktop Work workspace" },
  mobile: { src: "/images/hero/hero-mobile.png", alt: "ADE on iOS — mobile companion" },
} as const;

const panelFrame =
  "overflow-hidden border border-[color:var(--color-hairline-strong)] bg-[#07070b] ring-1 ring-white/[0.04]";

/**
 * Hero product trio — desktop hero with smaller TUI + iOS in the bottom corners.
 */
export function DeviceComposition() {
  const reduceMotion = useReducedMotion() ?? true;

  const panel = (delay: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 24 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.85, delay, ease: [0.22, 1, 0.36, 1] as const },
        };

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 30 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="relative w-full self-stretch"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -m-10"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 50% 50%, rgba(124,58,237,0.45) 0%, rgba(124,58,237,0.12) 45%, transparent 78%)",
          filter: "blur(14px)",
          zIndex: 0,
        }}
      />

      <div className="@container relative isolate mx-auto w-full max-w-[1650px] min-w-0 overflow-visible pb-[8%] @md:pb-[10%] @xl:pb-[12%]">
        {/* Desktop — primary layer; container height follows this image */}
        <motion.div
          {...panel(0.65)}
          className="relative z-0 motion-safe:transition-transform motion-safe:duration-500"
          style={{ filter: "drop-shadow(0 36px 64px rgba(0,0,0,0.58))" }}
        >
          <div className={`${panelFrame} rounded-[clamp(8px,1vw,14px)]`}>
            <img
              src={HERO_IMAGES.desktop.src}
              alt={HERO_IMAGES.desktop.alt}
              loading="eager"
              fetchPriority="high"
              decoding="sync"
              className="block h-auto w-full"
            />
          </div>
        </motion.div>

        {/* TUI — bottom-left corner of desktop; sizes track container, not viewport */}
        <motion.div
          {...panel(0.8)}
          className="absolute bottom-[16%] left-[-4%] z-20 w-[44%] origin-bottom-left -rotate-[2deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out @md:bottom-[18%] @md:left-[-10%] @md:w-[50%] @xl:bottom-[20%] @xl:left-[-18%] @xl:w-[54%] [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.14] [@media(hover:hover)]:hover:rotate-0"
          style={{ filter: "drop-shadow(0 24px 40px rgba(0,0,0,0.65))" }}
        >
          <div className={`${panelFrame} rounded-[clamp(6px,0.7vw,10px)]`}>
            <img
              src={HERO_IMAGES.tui.src}
              alt={HERO_IMAGES.tui.alt}
              loading="eager"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </motion.div>

        {/* iOS — wrapped in a real iPhone bezel: dark border, rounded corners,
            Dynamic Island, inner violet glow. */}
        <motion.div
          {...panel(0.9)}
          className="absolute bottom-[10%] right-[-2%] z-30 w-[17%] origin-bottom-right rotate-[3deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out @md:bottom-[12%] @md:right-[-6%] @md:w-[19%] @xl:bottom-[14%] @xl:right-[-10%] @xl:w-[21%] [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.14] [@media(hover:hover)]:hover:rotate-0"
          style={{ filter: "drop-shadow(0 28px 48px rgba(124,58,237,0.45))" }}
        >
          <div className="relative aspect-[9/19.5] overflow-hidden rounded-[clamp(22px,2.6vw,40px)] border-[clamp(4px,0.55vw,8px)] border-[#0c0c12] bg-black ring-1 ring-[color:var(--color-hairline-strong)]">
            {/* Dynamic Island */}
            <div
              aria-hidden="true"
              className="absolute left-1/2 top-[clamp(4px,0.5vw,8px)] z-[2] h-[clamp(9px,1vw,18px)] w-[38%] -translate-x-1/2 rounded-full bg-black"
            />
            <img
              src={HERO_IMAGES.mobile.src}
              alt={HERO_IMAGES.mobile.alt}
              loading="eager"
              decoding="async"
              className="block h-full w-full object-cover object-top"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ boxShadow: "inset 0 0 30px rgba(124,58,237,0.28)" }}
            />
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
