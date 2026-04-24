import { motion, useReducedMotion } from "framer-motion";

/**
 * Right column of the fold — MacBook + iPhone on violet halo + Fig. 1 caption.
 */
export function DeviceComposition() {
  const reduceMotion = useReducedMotion() ?? true;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 30 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="relative flex flex-col items-center"
    >
      {/* Violet halo */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -m-6"
        style={{
          background:
            "radial-gradient(ellipse 55% 55% at 50% 45%, rgba(124,58,237,0.5) 0%, rgba(124,58,237,0.14) 40%, transparent 75%)",
          filter: "blur(10px)",
          zIndex: 0,
        }}
      />

      <div className="relative z-[1] aspect-[1/0.78] w-full">
        {/* MacBook */}
        <div
          className="absolute left-[-2%] top-[6%] w-[82%]"
          style={{
            transform: "rotate(-1.6deg)",
            filter: "drop-shadow(0 30px 50px rgba(0,0,0,0.55))",
          }}
        >
          <div className="relative aspect-[16/10] overflow-hidden rounded-t-[10px] border border-[color:var(--color-hairline-strong)] bg-[#07070b]">
            <div className="absolute left-[10px] top-[9px] z-[3] flex gap-[5px]">
              <span className="h-[9px] w-[9px] rounded-full bg-[#ff5f57]" />
              <span className="h-[9px] w-[9px] rounded-full bg-[#febc2e]" />
              <span className="h-[9px] w-[9px] rounded-full bg-[#28c840]" />
            </div>
            <img
              src="/images/screenshots/lanes.png"
              alt="ADE on macOS"
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="h-full w-full object-cover object-top"
            />
          </div>
          <div
            className="relative h-[10px] border-x border-b border-[color:var(--color-hairline)] rounded-b-[14px]"
            style={{
              background: "linear-gradient(180deg, #1e1e24, #0d0d12)",
            }}
          >
            <span
              className="absolute left-1/2 top-0 h-[3px] w-[80px] -translate-x-1/2 rounded-b-[3px]"
              style={{ background: "rgba(0,0,0,0.6)" }}
            />
          </div>
        </div>

        {/* iPhone */}
        <div
          className="absolute right-[2%] bottom-[-4%] w-[30%]"
          style={{
            transform: "rotate(3.4deg)",
            filter: "drop-shadow(0 30px 50px rgba(124,58,237,0.55))",
          }}
        >
          <div className="relative aspect-[9/19.5] overflow-hidden rounded-[32px] border-[6px] border-[#0c0c12] bg-black ring-1 ring-[color:var(--color-hairline-strong)]">
            <div aria-hidden="true" className="absolute left-1/2 top-[7px] z-[2] h-[20px] w-[44%] -translate-x-1/2 rounded-full bg-black" />
            <img
              src="/images/screenshots/agent-chat.png"
              alt="ADE on iOS"
              loading="eager"
              decoding="async"
              className="h-full w-full object-cover object-left-top"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-[28px]"
              style={{ boxShadow: "inset 0 0 40px rgba(124,58,237,0.35)" }}
            />
          </div>
        </div>
      </div>

      <div className="relative z-[1] mt-8 max-w-[380px] self-end text-right font-serif italic text-[color:var(--color-cream-muted)]"
           style={{ fontSize: "16px", lineHeight: 1.4 }}>
        <span className="mr-[10px] inline-block align-middle font-sans text-[10px] uppercase tracking-[0.22em] not-italic text-[color:var(--color-violet-bright)]">
          Fig. 1
        </span>
        ADE, <em className="text-[color:var(--color-cream)]">on desk and in hand</em>. Photographed April 2026.
      </div>
    </motion.div>
  );
}
