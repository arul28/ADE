import { cn } from "../../lib/cn";

/*
 * ADE Cloud's picture: a night sky over a city. A lit window is an agent at
 * work; a dark one is a computer asleep. Everything is drawn with plain
 * elements from a fixed seed, so it looks the same on every visit and costs no
 * image request.
 */

/** A small seeded random source (mulberry32), so the city never changes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Star = { left: number; top: number; size: number; twinkle: boolean; delay: number };
type Tower = { width: number; height: number; cols: number; windows: Array<{ lit: boolean; delay: number }> };

function makeStars(count: number, seed: number): Star[] {
  const rand = seeded(seed);
  return Array.from({ length: count }, () => ({
    left: rand() * 100,
    top: rand() * 70,
    size: rand() < 0.15 ? 2 : 1,
    twinkle: rand() < 0.35,
    delay: rand() * 4.5,
  }));
}

/** Sizes of one window and the gaps around it, for a city drawn at `scale`. */
function windowMetrics(scale: number) {
  const size = Math.max(6, Math.round(10 * scale));
  return { size, gap: Math.max(4, Math.round(7 * scale)), pad: Math.max(6, Math.round(10 * scale)) };
}

function makeTowers(count: number, seed: number, scale: number): Tower[] {
  const rand = seeded(seed);
  const { size, gap, pad } = windowMetrics(scale);
  return Array.from({ length: count }, (_, index) => {
    // Taller in the middle, lower at the edges, like a skyline seen head on.
    const middle = 1 - Math.abs(index - (count - 1) / 2) / ((count - 1) / 2);
    const cols = rand() < 0.4 ? 4 : 3;
    const height = Math.round((120 + middle * 120 + rand() * 90) * scale);
    const rows = Math.max(3, Math.floor((height - pad * 2) / (size + gap)));
    const windowWidth = Math.round(size * 1.35);
    return {
      width: pad * 2 + cols * windowWidth + (cols - 1) * gap + Math.round(rand() * 6 * scale),
      height,
      cols,
      windows: Array.from({ length: rows * cols }, () => ({ lit: rand() < 0.22, delay: rand() * 7 })),
    };
  });
}

export function NightSky({ className, seed = 7 }: { className?: string; seed?: number }) {
  const stars = makeStars(54, seed);
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {stars.map((star, index) => (
        <span
          key={index}
          className={cn("absolute rounded-full bg-white", star.twinkle ? "ade-twinkle" : "opacity-40")}
          style={{
            left: `${star.left}%`,
            top: `${star.top}%`,
            width: star.size,
            height: star.size,
            animationDelay: `${star.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

export function Moon({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute", className)}>
      <div
        className="h-full w-full rounded-full"
        style={{
          background: "radial-gradient(circle at 36% 34%, var(--color-lamp-soft) 0%, var(--color-lamp) 78%)",
          boxShadow: "0 0 60px 10px rgba(255,210,122,0.28), 0 0 160px 40px rgba(255,210,122,0.10)",
        }}
      />
    </div>
  );
}

/**
 * The skyline. On narrow screens the outer towers drop away so the windows
 * stay a readable size.
 */
export function City({ className, seed = 11, count = 15, scale = 1 }: { className?: string; seed?: number; count?: number; scale?: number }) {
  const towers = makeTowers(count, seed, scale);
  const { size, gap, pad } = windowMetrics(scale);
  const hideFrom = Math.floor((count - 7) / 2);
  return (
    <div aria-hidden className={cn("pointer-events-none flex items-end justify-center gap-[clamp(6px,1vw,14px)]", className)}>
      {towers.map((tower, index) => {
        const outer = index < hideFrom || index >= count - hideFrom;
        return (
          <div
            key={index}
            className={cn(
              "shrink-0 rounded-t-[6px] bg-[#100d2b] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
              outer && "hidden sm:block",
            )}
            style={{ width: tower.width, height: tower.height, padding: `${pad}px ${pad}px 0` }}
          >
            <div className="grid" style={{ gap, gridTemplateColumns: `repeat(${tower.cols}, minmax(0, 1fr))` }}>
              {tower.windows.map((window, w) => (
                <span
                  key={w}
                  className={cn("rounded-[2px]", window.lit ? "ade-window bg-[color:var(--color-lamp)]" : "bg-[#211d52]")}
                  style={
                    window.lit
                      ? { height: size, animationDelay: `${window.delay}s`, boxShadow: "0 0 8px rgba(255,210,122,0.65)" }
                      : { height: size }
                  }
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}


/**
 * One tower for a plan card: more floors and more lit windows for a bigger
 * plan, so the four cards read as a small skyline.
 */
export function PlanTower({ floors, litShare, seed, className }: { floors: number; litShare: number; seed: number; className?: string }) {
  const rand = seeded(seed);
  const cols = 3;
  const windows = Array.from({ length: floors * cols }, () => ({ lit: rand() < litShare, delay: rand() * 7 }));
  return (
    <div
      aria-hidden
      className={cn("rounded-t-[5px] bg-[#100d2b] px-[7px] pt-[7px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]", className)}
    >
      <div className="grid grid-cols-3 gap-[5px]">
        {windows.map((window, index) => (
          <span
            key={index}
            className={cn("h-[7px] w-[10px] rounded-[1.5px]", window.lit ? "ade-window bg-[color:var(--color-lamp)]" : "bg-[#262160]")}
            style={window.lit ? { animationDelay: `${window.delay}s`, boxShadow: "0 0 6px rgba(255,210,122,0.6)" } : undefined}
          />
        ))}
      </div>
    </div>
  );
}
