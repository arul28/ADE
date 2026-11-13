import { useEffect, useId, type RefObject } from "react";
import { CLOUD_LOGO_PATH } from "../../remoteTargets/cloudBrand";

/*
 * ADE Cloud's dusk sky, as on the website: stars, a violet and rose glow low
 * on the horizon, a gold moon, slow clouds drawn with the logo's outline and
 * a bank of clouds along the bottom. Plain elements and SVG, no image request.
 *
 * Motion is compositor only (the clouds drift with `transform`, a few stars
 * fade with `opacity`) and stops three ways: under reduced motion, while the
 * window is hidden, and while the sky is scrolled out of view
 * (`useStillWhenHidden`, which sets `data-still` on the surface).
 */

type Drift = { left: string; top: string; width: string; opacity: number; duration: number; delay: number; flip?: boolean };

const DRIFTS: Drift[] = [
  { left: "-8%", top: "4%", width: "30%", opacity: 0.5, duration: 90, delay: -20 },
  { left: "40%", top: "-6%", width: "22%", opacity: 0.34, duration: 120, delay: -70, flip: true },
  { left: "70%", top: "30%", width: "34%", opacity: 0.42, duration: 110, delay: -45 },
];

/** Fixed stars (left %, top %, size px, twinkles). The same sky on every visit. */
const STARS: Array<[number, number, number, boolean]> = [
  [4, 12, 1, false], [9, 38, 1, true], [14, 8, 2, false], [19, 56, 1, false], [23, 22, 1, true],
  [28, 6, 1, false], [33, 44, 1, false], [37, 16, 2, true], [42, 30, 1, false], [46, 4, 1, false],
  [51, 24, 1, true], [55, 50, 1, false], [59, 10, 1, false], [63, 36, 2, false], [67, 18, 1, true],
  [72, 6, 1, false], [76, 42, 1, false], [80, 14, 1, true], [85, 30, 1, false], [89, 8, 2, false],
  [93, 22, 1, true], [97, 48, 1, false], [2, 64, 1, false], [48, 62, 1, false], [31, 70, 1, true],
];

/** Widths of the bank's clouds, as shares of the row; the middle ones stand tallest. */
const BANK_BACK = [16, 22, 18, 26, 20, 24, 17];
const BANK_FRONT = [20, 15, 24, 19, 27, 16, 22];

/**
 * Sets `data-still="true"` on `ref` while it is out of view or the window is
 * hidden, so CSS pauses every animation under it. One observer per surface.
 */
export function useStillWhenHidden(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    let inView = true;
    const apply = () => {
      const still = !inView || document.visibilityState === "hidden";
      if (still) node.setAttribute("data-still", "true");
      else node.removeAttribute("data-still");
    };
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        apply();
      });
    observer?.observe(node);
    document.addEventListener("visibilitychange", apply);
    apply();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, [ref]);
}

function BankRow({ widths, gradient, rim, className, flipOdd }: { widths: number[]; gradient: string; rim: number; className: string; flipOdd?: boolean }) {
  return (
    <div className={`adecd-sky-bankrow ${className}`}>
      {widths.map((width, index) => (
        <svg
          key={index}
          viewBox="1 3 30 20"
          overflow="visible"
          preserveAspectRatio="none"
          style={{ width: `${width}%`, transform: flipOdd && index % 2 ? "scaleX(-1)" : undefined }}
        >
          <path d={CLOUD_LOGO_PATH} fill={`url(#${gradient})`} />
          <path d={CLOUD_LOGO_PATH} fill="none" stroke="#efe7ff" strokeOpacity={rim} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        </svg>
      ))}
    </div>
  );
}

/** The sky behind a surface: absolutely placed, under its content, never takes a pointer. */
export function CloudSky({ moon = true, bank = true, drift = true }: { moon?: boolean; bank?: boolean; drift?: boolean }) {
  const id = `adecd-sky-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <div className="adecd-sky" aria-hidden="true">
      <div className="adecd-sky-glow" />
      <div className="adecd-sky-stars">
        {STARS.map(([left, top, size, twinkle], index) => (
          <i
            key={index}
            data-twinkle={twinkle || undefined}
            style={{ left: `${left}%`, top: `${top}%`, width: size, height: size, animationDelay: `${(index % 5) * 0.9}s` }}
          />
        ))}
      </div>
      {moon ? <div className="adecd-sky-moon" /> : null}
      <svg width="0" height="0" className="adecd-sky-defs">
        <defs>
          <linearGradient id={`${id}-cloud`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d8ccff" stopOpacity="0.32" />
            <stop offset="45%" stopColor="#a78bfa" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
          </linearGradient>
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
      {drift
        ? DRIFTS.map((cloud, index) => (
          <div
            key={index}
            className="adecd-sky-drift"
            style={{ left: cloud.left, top: cloud.top, width: cloud.width, opacity: cloud.opacity, animationDuration: `${cloud.duration}s`, animationDelay: `${cloud.delay}s` }}
          >
            <svg viewBox="1 3 30 20" overflow="visible" style={cloud.flip ? { transform: "scaleX(-1)" } : undefined}>
              <path d={CLOUD_LOGO_PATH} fill={`url(#${id}-cloud)`} />
            </svg>
          </div>
        ))
        : null}
      {bank ? (
        <div className="adecd-sky-bank">
          <div className="adecd-sky-bankglow" />
          <BankRow widths={BANK_BACK} gradient={`${id}-back`} rim={0.2} className="adecd-sky-bankrow-back" flipOdd />
          <BankRow widths={BANK_FRONT} gradient={`${id}-front`} rim={0.28} className="adecd-sky-bankrow-front" />
        </div>
      ) : null}
    </div>
  );
}
