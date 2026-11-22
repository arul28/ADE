import { useId } from "react";
import { CLOUD_PATH } from "./CloudMark";
import { NightSky } from "./NightCity";

/*
 * The home page's first screen: a dusk sky. Stars at the top, a violet and
 * rose horizon behind the app, and slow clouds drawn with the ADE Cloud mark's
 * outline. The clouds move with transforms only, so the browser composites
 * them without repainting, and they stand still under reduced motion.
 */

type Drift = { left: string; top: string; width: string; opacity: number; duration: number; delay: number; flip?: boolean };

const CLOUDS: Drift[] = [
  { left: "-6%", top: "6%", width: "clamp(220px,26vw,420px)", opacity: 0.55, duration: 90, delay: -20 },
  { left: "74%", top: "13%", width: "clamp(180px,20vw,340px)", opacity: 0.45, duration: 110, delay: -60, flip: true },
  { left: "8%", top: "44%", width: "clamp(260px,34vw,560px)", opacity: 0.4, duration: 130, delay: -35, flip: true },
  { left: "62%", top: "50%", width: "clamp(260px,36vw,600px)", opacity: 0.5, duration: 120, delay: -80 },
];

export function HeroSky() {
  const id = useId().replace(/:/g, "");
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background: [
            // The horizon, low behind the app window.
            "radial-gradient(ellipse 70% 38% at 50% 64%, rgba(139,92,246,0.42) 0%, rgba(139,92,246,0.12) 45%, transparent 75%)",
            "radial-gradient(ellipse 30% 22% at 28% 66%, rgba(219,39,119,0.20) 0%, transparent 70%)",
            "radial-gradient(ellipse 28% 20% at 74% 62%, rgba(255,210,122,0.12) 0%, transparent 70%)",
            "linear-gradient(180deg, #07061a 0%, #0f0c2a 34%, #1a1240 62%, #0a0a0f 100%)",
          ].join(", "),
        }}
      />
      <div className="absolute inset-x-0 top-0 h-[70%]" style={{ maskImage: "linear-gradient(to bottom, black 40%, transparent)" }}>
        <NightSky seed={3} />
      </div>
      <span className="ade-shooting-star absolute left-[18%] top-[9%] h-px w-[120px]" />

      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id={`${id}-cloud`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d8ccff" stopOpacity="0.32" />
            <stop offset="45%" stopColor="#a78bfa" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
          </linearGradient>
          <filter id={`${id}-soft`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="0.5" />
          </filter>
        </defs>
      </svg>
      {CLOUDS.map((cloud, index) => (
        <div
          key={index}
          className="ade-drift absolute"
          style={{
            left: cloud.left,
            top: cloud.top,
            width: cloud.width,
            opacity: cloud.opacity,
            animationDuration: `${cloud.duration}s`,
            animationDelay: `${cloud.delay}s`,
          }}
        >
          <svg viewBox="1 3 30 20" overflow="visible" className="block w-full" style={cloud.flip ? { transform: "scaleX(-1)" } : undefined}>
            <path d={CLOUD_PATH} fill={`url(#${id}-cloud)`} filter={`url(#${id}-soft)`} />
          </svg>
        </div>
      ))}
    </div>
  );
}

/* Widths are shares of the row; the middle clouds stand tallest. */
const BANK_BACK = [16, 22, 18, 26, 20, 24, 17];
const BANK_FRONT = [20, 15, 24, 19, 27, 16, 22];

function BankRow({
  widths,
  gradient,
  rim,
  className,
  flipOdd,
}: {
  widths: number[];
  gradient: string;
  rim: number;
  className?: string;
  flipOdd?: boolean;
}) {
  return (
    <div className={`absolute inset-x-[-45%] bottom-0 flex sm:inset-x-[-6%] items-end justify-center ${className ?? ""}`}>
      {widths.map((width, index) => (
        <svg
          key={index}
          viewBox="1 3 30 20"
          overflow="visible"
          preserveAspectRatio="none"
          className="-mx-[2.5%] block shrink-0"
          style={{
            width: `${width}%`,
            aspectRatio: "30 / 13",
            transform: flipOdd && index % 2 ? "scaleX(-1)" : undefined,
          }}
        >
          <path d={CLOUD_PATH} fill={`url(#${gradient})`} />
          <path
            d={CLOUD_PATH}
            fill="none"
            stroke="#efe7ff"
            strokeOpacity={rim} strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ))}
    </div>
  );
}

/**
 * A bank of clouds on the horizon, behind the top of the app window. The back
 * row drifts very slowly; the front row stays put.
 */
export function CloudBank({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <div
      aria-hidden
      className={`pointer-events-none overflow-hidden ${className ?? ""}`}
      style={{ maskImage: "linear-gradient(to bottom, black 62%, transparent 95%)" }}
    >
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id={`${id}-back`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6b2f7d" />
            <stop offset="45%" stopColor="#2c1650" />
            <stop offset="100%" stopColor="#1a1138" />
          </linearGradient>
          <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4a3392" />
            <stop offset="40%" stopColor="#24184f" />
            <stop offset="100%" stopColor="#120e2a" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-x-[10%] bottom-[30%] h-[40%] rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(244,114,182,0.35),transparent_70%)]" />
      <BankRow widths={BANK_BACK} gradient={`${id}-back`} rim={0.22} className="ade-drift bottom-[16%]" flipOdd />
      <BankRow widths={BANK_FRONT} gradient={`${id}-front`} rim={0.3} />
    </div>
  );
}
