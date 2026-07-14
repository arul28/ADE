import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Expand,
  Globe,
  GitBranchPlus,
  GitPullRequest,
  LayoutGrid,
  Network,
  Server,
  SquareTerminal,
  Workflow,
  X,
} from "lucide-react";
import { EDITORIAL_ISSUE } from "./issue";
import { MARKETING_FEATURES, type MarketingFeature } from "../../lib/marketingAnalytics";

/** Official Linear mark (from the desktop app's Linear integration). */
function LinearMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

type Demo = {
  label: string;
  blurb: string;
  /** /videos/<name>.mp4 — compressed, no audio. */
  video: string;
  /** /videos/<name>.webp — tiny first-frame poster. */
  poster: string;
  icon: ComponentType<{ className?: string }>;
  analyticsFeature: MarketingFeature;
  /** Brand icons keep their own colour; native ones inherit the accent. */
  brand?: string;
};

const DEMOS: Demo[] = [
  {
    label: "Grid view",
    blurb: "Tile every agent run side by side and watch them work in parallel.",
    video: "/videos/gridViewDemo.mp4",
    poster: "/videos/gridViewDemo.webp",
    icon: LayoutGrid,
    analyticsFeature: MARKETING_FEATURES.DEMO_GRID_VIEW,
  },
  {
    label: "Subagents",
    blurb: "Hand one lead a plan; it dispatches a fleet of workers and tracks each one live.",
    video: "/videos/subagentsDemo.mp4",
    poster: "/videos/subagentsDemo.webp",
    icon: Network,
    analyticsFeature: MARKETING_FEATURES.DEMO_SUBAGENTS,
  },
  {
    label: "Auto-create worktrees",
    blurb: "Describe a task — ADE spins up the branch and worktree for it, no git wrangling.",
    video: "/videos/autocreateLane.mp4",
    poster: "/videos/autocreateLane.webp",
    icon: GitBranchPlus,
    analyticsFeature: MARKETING_FEATURES.DEMO_AUTO_CREATE_WORKTREES,
  },
  {
    label: "PRs from a chat",
    blurb: "Turn a finished chat into a pull request — diff, checks, and merge, no GitHub tab.",
    video: "/videos/creatingPRfromChat.mp4",
    poster: "/videos/creatingPRfromChat.webp",
    icon: GitPullRequest,
    analyticsFeature: MARKETING_FEATURES.DEMO_PR_FROM_CHAT,
  },
  {
    label: "Worktree graph",
    blurb: "Every worktree as a stack — dependencies, conflict risk, and rebase order at a glance.",
    video: "/videos/graphsTab.mp4",
    poster: "/videos/graphsTab.webp",
    icon: Workflow,
    analyticsFeature: MARKETING_FEATURES.DEMO_WORKTREE_GRAPH,
  },
  {
    label: "ADE Code",
    blurb: "The whole workspace, terminal-native — chats, worktrees, and PRs in your shell.",
    video: "/videos/adecodeDemo.mp4",
    poster: "/videos/adecodeDemo.webp",
    icon: SquareTerminal,
    analyticsFeature: MARKETING_FEATURES.DEMO_ADE_CODE,
  },
  {
    label: "Built-in browser",
    blurb: "A shared browser pane for web QA, element inspection, and proof capture.",
    video: "/videos/browserInspect.mp4",
    poster: "/videos/browserInspect.webp",
    icon: Globe,
    analyticsFeature: MARKETING_FEATURES.DEMO_BROWSER,
  },
  {
    label: "Remote runtimes",
    blurb: "Point ADE at a remote machine and run agents there with full tool access.",
    video: "/videos/remoteConnect.mp4",
    poster: "/videos/remoteConnect.webp",
    icon: Server,
    analyticsFeature: MARKETING_FEATURES.DEMO_REMOTE_RUNTIMES,
  },
  {
    label: "Linear, connected",
    blurb: "Pull issues, move them through states, and link PRs — Linear without leaving ADE.",
    video: "/videos/linearConnection.mp4",
    poster: "/videos/linearConnection.webp",
    icon: LinearMark,
    analyticsFeature: MARKETING_FEATURES.DEMO_LINEAR,
    brand: "#5E6AD2",
  },
];

/**
 * One demo tile. Every clip auto-plays (muted loop) while it's anywhere near
 * the viewport — the whole grid running at once is the point of this section.
 * The mp4s are faststart-encoded so they render frames while still streaming,
 * and playback starts 300px before the tile scrolls in so the grid is already
 * alive when it lands. Offscreen tiles pause to give the bandwidth back.
 * Click opens the full clip in a lightbox. Posters carry the static first
 * frame for reduced-motion and pre-play.
 */
function DemoTile({
  demo,
  onOpen,
  reduceMotion,
}: {
  demo: Demo;
  onOpen: (d: Demo) => void;
  reduceMotion: boolean;
}) {
  const wrapRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (reduceMotion) return;
    const el = wrapRef.current;
    const v = videoRef.current;
    if (!el || !v) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.01, rootMargin: "300px 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      v.pause();
    };
  }, [reduceMotion]);

  const Icon = demo.icon;

  return (
    <div className="group block">
      <button
        ref={wrapRef}
        type="button"
        onClick={() => onOpen(demo)}
        aria-label={`Expand the ${demo.label} demo`}
        data-ade-analytics-feature={demo.analyticsFeature}
        className="relative block w-full cursor-pointer overflow-hidden rounded-[3px] border border-[color:var(--color-ink-hairline)] bg-[#0a0a0f] text-left shadow-[0_20px_44px_-26px_rgba(24,21,15,0.55)] outline-none ring-0 transition-[transform,box-shadow] duration-300 focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] motion-safe:group-hover:-translate-y-[4px] motion-safe:group-hover:shadow-[0_30px_60px_-28px_rgba(94,106,210,0.5)]"
      >
        <div className="relative aspect-video w-full">
          <video
            ref={videoRef}
            src={demo.video}
            poster={demo.poster}
            muted
            loop
            playsInline
            preload="none"
            tabIndex={-1}
            className="h-full w-full object-cover object-top"
          />
          {/* accent edge on hover */}
          <div className="pointer-events-none absolute inset-0 rounded-[3px] ring-1 ring-inset ring-transparent transition-colors duration-300 group-hover:ring-[color:var(--color-accent)]/40" />
          {/* expand affordance, appears on hover */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity duration-300 group-hover:bg-black/20 group-hover:opacity-100">
            <span className="flex items-center gap-2 rounded-full border border-white/25 bg-black/55 px-3.5 py-2 text-[10px] uppercase tracking-[0.18em] text-white backdrop-blur-sm">
              <Expand className="h-3.5 w-3.5" /> Expand
            </span>
          </div>
        </div>
      </button>

      <div className="mt-5 flex items-center gap-2.5">
        <span
          className="shrink-0 text-[color:var(--color-accent)]"
          style={demo.brand ? { color: demo.brand } : undefined}
        >
          <Icon className="h-[19px] w-[19px]" />
        </span>
        <h3
          className="font-serif font-normal text-[color:var(--color-ink)]"
          style={{ fontSize: "26px", lineHeight: 1 }}
        >
          {demo.label}
        </h3>
      </div>

      <p
        className="mt-2 max-w-[36ch] font-sans text-[color:var(--color-ink-muted)]"
        style={{ fontSize: "14.5px", lineHeight: 1.5 }}
      >
        {demo.blurb}
      </p>
    </div>
  );
}

/** Full-screen player opened on tile click. Esc / backdrop / button to close. */
function Lightbox({ demo, onClose }: { demo: Demo; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Modal a11y: move focus into the dialog, trap Tab inside it, and restore
    // focus to the trigger on close so keyboard users can't reach the page behind.
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button,[href],input,select,textarea,video,[tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      restoreFocusRef.current?.focus();
    };
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="dialog"
      aria-modal="true"
      aria-label={`${demo.label} demo`}
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-[clamp(16px,4vw,64px)] backdrop-blur-md"
    >
      <motion.div
        ref={dialogRef}
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 6 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[1180px]"
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute -top-11 right-0 flex items-center gap-1.5 text-[12px] uppercase tracking-[0.16em] text-white/70 transition-colors hover:text-white"
        >
          Close <X className="h-4 w-4" />
        </button>
        <video
          key={demo.video}
          src={demo.video}
          poster={demo.poster}
          autoPlay
          loop
          controls
          playsInline
          className="block max-h-[78vh] w-full rounded-[4px] border border-white/10 bg-black shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]"
        />
        <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h3 className="font-serif text-[22px] text-[color:var(--color-cream)]">{demo.label}</h3>
          <p className="text-[14px] text-[color:var(--color-cream-muted)]">{demo.blurb}</p>
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * "Catalog" — the rest of the IDE, as short looping demos that play as you
 * scroll. Click any tile to watch the full clip in a lightbox.
 */
export function FeatureGrid() {
  const reduceMotion = useReducedMotion() ?? true;
  const [active, setActive] = useState<Demo | null>(null);

  return (
    <section
      id="features"
      className="relative bg-[color:var(--color-paper)] text-[color:var(--color-ink)]"
    >
      <span id="catalog" className="sr-only" aria-hidden="true" />
      <div className="mx-auto max-w-[1520px] px-[clamp(20px,3vw,48px)] py-[clamp(44px,5.5vw,84px)]">
        {/* running head */}
        <div className="mb-10 flex items-baseline justify-between border-b border-[color:var(--color-ink-hairline)] pb-4 text-[11px] uppercase tracking-[0.24em] text-[color:var(--color-ink-muted)]">
          <span>ADE · {EDITORIAL_ISSUE.shortMonthYear}</span>
          <span className="hidden sm:block">Catalog</span>
          <span>{EDITORIAL_ISSUE.volume} · {EDITORIAL_ISSUE.version} · 32</span>
        </div>

        {/* folio */}
        <div className="mb-9 grid grid-cols-3 items-baseline gap-4 text-[11px] uppercase tracking-[0.26em]">
          <span className="font-medium text-[color:var(--color-accent)]">Catalog</span>
          <span className="text-center text-[color:var(--color-ink-muted)]">
            The rest of the IDE
          </span>
          <span className="text-right text-[color:var(--color-ink-muted)]">Page 32</span>
        </div>

        <motion.h2
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto mb-3 text-center font-serif font-normal tracking-[-0.02em] text-[color:var(--color-ink)]"
          style={{
            fontSize: "clamp(32px, 4.6vw, 64px)",
            lineHeight: 1.05,
            margin: "0 auto",
            paddingBottom: "0.08em",
          }}
        >
          The rest of the IDE.{" "}
          <em className="italic text-[color:var(--color-accent)]">In the same app.</em>
        </motion.h2>
        <motion.p
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="mx-auto mb-12 max-w-[52ch] text-center font-serif italic text-[color:var(--color-ink-muted)]"
          style={{ fontSize: "19px", lineHeight: 1.4 }}
        >
          Every tab you’d expect — and a few you wouldn’t.
          They play as you scroll; click any to watch.
        </motion.p>

        <div className="grid grid-cols-1 gap-x-8 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
          {DEMOS.map((demo, i) => (
            <motion.div
              key={demo.label}
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              transition={{
                duration: 0.6,
                delay: Math.min(i * 0.05, 0.35),
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <DemoTile demo={demo} onOpen={setActive} reduceMotion={reduceMotion} />
            </motion.div>
          ))}
        </div>
      </div>

      {active ? <Lightbox demo={active} onClose={() => setActive(null)} /> : null}
    </section>
  );
}
