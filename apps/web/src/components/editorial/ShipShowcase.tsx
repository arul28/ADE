import { useCallback, useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

const ROTATE_MS = 18000;

type ShowcaseImage = {
  src: string;
  label: string;
  caption?: string;
  /** Filename hint for asset drops — shown when image is missing. */
  file: string;
};

type Shot = { src: string; label: string };

/** Hero-style device trio (desktop centerpiece + TUI + iPhone), same proportions as the fold. */
type DeviceTrio = {
  desktop: Shot;
  tui: Shot;
  mobile: Shot;
};

/**
 * Agent-chat composition. Desktop hero (largest) anchored by three supporting
 * shots: TUI (bottom-left, large), model picker (top-right) and a phone
 * (bottom-right).
 */
type ChatShots = {
  desktop: Shot;
  tui: Shot;
  picker: Shot;
  mobile: Shot;
};

/** Two-image PR composition: a dominant desktop hero + a phone bottom-right. */
type PrShots = {
  desktop: Shot;
  mobile: Shot;
};

/** Three desktop views: a hero on top, two smaller ones flanking the bottom. */
type ToolsShots = {
  hero: Shot;
  left: Shot;
  right: Shot;
};

type ShowcaseTab = {
  id: string;
  number: string;
  label: string;
  title: string;
  summary: string;
  bullets: string[];
  footnote: string;
  /** Real assets ready → render the hero-style device composition. */
  composition?: DeviceTrio;
  /** Four-image agent-chat composition. */
  chatComposition?: ChatShots;
  /** Two-image pull-request composition (desktop hero + phone). */
  prComposition?: PrShots;
  /** Three-desktop work-tools composition. */
  toolsComposition?: ToolsShots;
  /** Fallback deck: first image is the large primary, the rest are thumbnails. */
  images?: ShowcaseImage[];
};

/**
 * Drop final PNGs here (paths relative to `apps/web/public/`):
 *
 * sync/lanes/tui.png, desktop.png, mobile.png
 * sync/chat/tui.png, desktop.png, mobile.png, grid-view.png, model-picker.png
 * sync/prs/tui.png, desktop.png, mobile.png
 * sync/tools/browser.png, ios-sim.png, app-control.png, files.png
 */
const TABS: ShowcaseTab[] = [
  {
    id: "lanes",
    number: "01",
    label: "Worktrees",
    title: "Git worktrees on the fly.",
    summary: "Spin up an isolated branch and worktree in a single action.",
    bullets: [
      "Its own checkout, terminals, ports, and history.",
      "Stack worktrees on a graph; rebase when parents land.",
      "The same list in the terminal, desktop, and iOS.",
    ],
    footnote: "Create one once — it's in your terminal, desktop, and pocket instantly.",
    composition: {
      desktop: { src: "/images/secondPage/lanesDesktop.webp", label: "ADE on macOS — Lanes" },
      tui: { src: "/images/secondPage/lanesTUI.webp", label: "ADE Code — lanes in the terminal" },
      mobile: { src: "/images/secondPage/lanesMobile.webp", label: "ADE on iOS — a worktree in your pocket" },
    },
  },
  {
    id: "chat",
    number: "02",
    label: "Agent chat",
    title: "One prompt box. Every agent.",
    summary: "Claude Code, Codex, Cursor, OpenCode, Droid — one Work surface.",
    bullets: [
      "Launch an ADE chat or a headless CLI session.",
      "Grid view tiles every run side by side.",
      "Messages, tool calls, and proofs sync to every screen.",
    ],
    footnote: "Every turn stays mirrored — no copy-paste between surfaces.",
    chatComposition: {
      desktop: { src: "/images/secondPage/chatDesktop.webp", label: "ADE on macOS — agent chat across panes" },
      tui: { src: "/images/secondPage/chatTui.webp", label: "ADE Code — agent chat in the terminal" },
      picker: { src: "/images/secondPage/chatModelPicker.webp", label: "Model picker — every agent in one menu" },
      mobile: { src: "/images/secondPage/chatMobile.webp", label: "ADE on iOS — agent chat in your pocket" },
    },
  },
  {
    id: "prs",
    number: "03",
    label: "Pull requests",
    title: "Review and merge. No GitHub tab.",
    summary: "Open a PR from a finished chat and review it inside ADE.",
    bullets: [
      "Diff, CI, and review threads next to the worktree.",
      "Merge when green — synced on every client.",
    ],
    footnote: "The PR your agent opened is the same object everywhere.",
    prComposition: {
      desktop: { src: "/images/secondPage/prDesktop.webp", label: "ADE on macOS — pull requests" },
      mobile: { src: "/images/secondPage/prMobile.webp", label: "ADE on iOS — pull requests in your pocket" },
    },
  },
  {
    id: "tools",
    number: "04",
    label: "Work tools",
    title: "Browser, sim, tools — beside the chat.",
    summary: "The proof and control surfaces agents need, built in.",
    bullets: [
      "Shared browser pane for web QA and proof capture.",
      "iOS Simulator and App Control in the tools drawer.",
      "Every tool scoped to the active worktree.",
    ],
    footnote: "Agents get computer use; you get the same controls, one click away.",
    toolsComposition: {
      hero: { src: "/images/secondPage/workBrowser.webp", label: "ADE on macOS — built-in browser pane beside the chat" },
      left: { src: "/images/secondPage/workGit.webp", label: "ADE on macOS — Git pane" },
      right: { src: "/images/secondPage/workFiles.webp", label: "ADE on macOS — Files pane" },
    },
  },
];

function ImagePanel({
  image,
  primary = false,
}: {
  image: ShowcaseImage;
  primary?: boolean;
}) {
  const [missing, setMissing] = useState(false);

  return (
    <div
      className={cn(
        "group relative overflow-hidden border border-[color:var(--color-hairline-strong)] bg-[#07070b] ring-1 ring-white/[0.04]",
        primary
          ? "aspect-[16/10] rounded-[clamp(12px,1.1vw,18px)] shadow-[0_30px_60px_-24px_rgba(0,0,0,0.7)]"
          : "h-[clamp(66px,7vw,108px)] rounded-[clamp(8px,0.8vw,12px)]"
      )}
    >
      {/* Surface label chip */}
      <div className="pointer-events-none absolute left-2.5 top-2.5 z-10 flex items-center gap-1.5 rounded-full border border-[color:var(--color-hairline-strong)] bg-black/55 px-2.5 py-1 backdrop-blur-sm">
        <span className="h-1 w-1 rounded-full bg-[color:var(--color-violet-bright)] shadow-[0_0_6px_rgba(124,58,237,0.9)]" />
        <span className="text-[9px] uppercase tracking-[0.14em] text-[color:var(--color-cream)]">
          {image.label}
        </span>
        {image.caption ? (
          <span className="text-[9px] text-[color:var(--color-cream-faint)]">· {image.caption}</span>
        ) : null}
      </div>

      {!missing ? (
        <img
          src={image.src}
          alt={image.label}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover object-left-top transition-transform duration-500 ease-out motion-safe:group-hover:scale-[1.03]"
          onError={() => setMissing(true)}
        />
      ) : (
        <div
          className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center"
          style={{
            background:
              "radial-gradient(ellipse 80% 70% at 50% 40%, rgba(124,58,237,0.18) 0%, transparent 72%)",
          }}
        >
          <span
            className="font-serif italic text-[color:var(--color-violet-bright)]"
            style={{ fontSize: primary ? "clamp(20px,2.2vw,30px)" : "13px" }}
          >
            {image.label}
          </span>
          {primary ? (
            <code className="font-mono text-[10px] tracking-tight text-[color:var(--color-cream-faint)]">
              images/{image.file}
            </code>
          ) : null}
        </div>
      )}

      {/* violet sheen on hover */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: "linear-gradient(160deg, rgba(124,58,237,0.16), transparent 55%)" }}
      />
    </div>
  );
}

const compositionFrame =
  "overflow-hidden border border-[color:var(--color-hairline-strong)] bg-[#07070b] ring-1 ring-white/[0.04]";

/**
 * Hero-style device trio — desktop centerpiece with the TUI tucked into the
 * bottom-left and a bezeled iPhone bottom-right. Proportions mirror the fold's
 * DeviceComposition so the two read as the same product family.
 */
function ShowcaseComposition({ trio }: { trio: DeviceTrio }) {
  return (
    <div className="relative w-full self-center">
      {/* localized violet glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -m-8"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 50% 52%, rgba(124,58,237,0.42) 0%, rgba(124,58,237,0.1) 46%, transparent 78%)",
          zIndex: 0,
        }}
      />

      <div className="relative isolate w-full pb-[3%]">
        {/* Desktop — base layer; defines composition height */}
        <div
          className="relative z-0 motion-safe:transition-transform motion-safe:duration-500"
          style={{ boxShadow: "0 30px 56px rgba(0,0,0,0.6)" }}
        >
          <div className={`${compositionFrame} rounded-[clamp(8px,1vw,14px)]`}>
            <img
              src={trio.desktop.src}
              alt={trio.desktop.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* TUI — bottom-left corner */}
        <div
          className="absolute bottom-[12%] left-[-3%] z-20 w-[50%] origin-bottom-left -rotate-[2deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.06] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 22px 40px rgba(0,0,0,0.66)" }}
        >
          <div className={`${compositionFrame} rounded-[clamp(6px,0.7vw,10px)]`}>
            <img
              src={trio.tui.src}
              alt={trio.tui.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* iPhone — bottom-right corner, real bezel */}
        <div
          className="absolute bottom-[1%] right-[-1%] z-30 w-[18%] origin-bottom-right rotate-[3deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.08] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 24px 44px rgba(124,58,237,0.45)", borderRadius: "clamp(16px,1.9vw,30px)" }}
        >
          <div className="relative aspect-[9/19.5] overflow-hidden rounded-[clamp(16px,1.9vw,30px)] border-[clamp(3px,0.45vw,7px)] border-[#0c0c12] bg-black ring-1 ring-[color:var(--color-hairline-strong)]">
            <div
              aria-hidden
              className="absolute left-1/2 top-[clamp(3px,0.4vw,7px)] z-[2] h-[clamp(7px,0.9vw,16px)] w-[40%] -translate-x-1/2 rounded-full bg-black"
            />
            <img
              src={trio.mobile.src}
              alt={trio.mobile.label}
              loading="lazy"
              decoding="async"
              className="block h-full w-full object-cover object-top"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ boxShadow: "inset 0 0 26px rgba(124,58,237,0.26)" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Agent-chat composition — a dominant desktop hero anchored by three supporting
 * shots: a large TUI (bottom-left), the model picker (top-right) and a bezeled
 * iPhone (bottom-right). Mirrors the Worktrees composition's depth language.
 */
function ChatComposition({ shots }: { shots: ChatShots }) {
  return (
    <div className="relative w-full self-center">
      {/* localized violet glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -m-8"
        style={{
          background:
            "radial-gradient(ellipse 72% 62% at 50% 50%, rgba(124,58,237,0.42) 0%, rgba(124,58,237,0.1) 46%, transparent 78%)",
          zIndex: 0,
        }}
      />

      <div className="relative isolate w-full pb-[6%] pt-[3%]">
        {/* #6 Desktop — base hero; defines composition height (largest) */}
        <div
          className="relative z-0 mx-auto w-[95%] motion-safe:transition-transform motion-safe:duration-500"
          style={{ boxShadow: "0 30px 56px rgba(0,0,0,0.6)" }}
        >
          <div className={`${compositionFrame} rounded-[clamp(8px,1vw,14px)]`}>
            <img
              src={shots.desktop.src}
              alt={shots.desktop.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* #7 TUI — bottom-left (large) */}
        <div
          className="absolute bottom-[5%] left-[-1%] z-20 w-[48%] origin-bottom-left -rotate-[1deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.05] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 22px 40px rgba(0,0,0,0.66)" }}
        >
          <div className={`${compositionFrame} rounded-[clamp(6px,0.7vw,10px)]`}>
            <img
              src={shots.tui.src}
              alt={shots.tui.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* #4 Model picker — top-right accent (smallest card) */}
        <div
          className="absolute right-[-3%] top-[3%] z-40 w-[23%] origin-top-right rotate-[2deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:scale-[1.06] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 18px 34px rgba(124,58,237,0.38)" }}
        >
          <div className={`${compositionFrame} rounded-[clamp(5px,0.6vw,9px)]`}>
            <img
              src={shots.picker.src}
              alt={shots.picker.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* #8 iPhone — bottom-right bezel (mobile) */}
        <div
          className="absolute bottom-[2%] right-[0%] z-30 w-[16.5%] origin-bottom-right rotate-[2deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.08] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 24px 44px rgba(124,58,237,0.45)", borderRadius: "clamp(14px,1.6vw,26px)" }}
        >
          <div className="relative aspect-[9/19.5] overflow-hidden rounded-[clamp(14px,1.6vw,26px)] border-[clamp(3px,0.4vw,6px)] border-[#0c0c12] bg-black ring-1 ring-[color:var(--color-hairline-strong)]">
            <div
              aria-hidden
              className="absolute left-1/2 top-[clamp(3px,0.4vw,6px)] z-[2] h-[clamp(6px,0.8vw,14px)] w-[40%] -translate-x-1/2 rounded-full bg-black"
            />
            <img
              src={shots.mobile.src}
              alt={shots.mobile.label}
              loading="lazy"
              decoding="async"
              className="block h-full w-full object-cover object-top"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ boxShadow: "inset 0 0 22px rgba(124,58,237,0.26)" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Pull-request composition — a dominant desktop PR view with a bezeled iPhone
 * tucked into the bottom-right. Two surfaces, one PR object.
 */
function PrComposition({ shots }: { shots: PrShots }) {
  return (
    <div className="relative w-full self-center">
      {/* localized violet glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -m-8"
        style={{
          background:
            "radial-gradient(ellipse 72% 62% at 48% 50%, rgba(124,58,237,0.42) 0%, rgba(124,58,237,0.1) 46%, transparent 78%)",
          zIndex: 0,
        }}
      />

      <div className="relative isolate w-full pb-[5%]">
        {/* Desktop — hero (largest) */}
        <div
          className="relative z-0 mx-auto w-[97%] motion-safe:transition-transform motion-safe:duration-500"
          style={{ boxShadow: "0 30px 56px rgba(0,0,0,0.6)" }}
        >
          <div className={`${compositionFrame} rounded-[clamp(8px,1vw,14px)]`}>
            <img
              src={shots.desktop.src}
              alt={shots.desktop.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* iPhone — bottom-right bezel */}
        <div
          className="absolute bottom-[1%] right-[1%] z-30 w-[17.5%] origin-bottom-right rotate-[2deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.08] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 24px 44px rgba(124,58,237,0.45)", borderRadius: "clamp(14px,1.6vw,26px)" }}
        >
          <div className="relative aspect-[9/19.5] overflow-hidden rounded-[clamp(14px,1.6vw,26px)] border-[clamp(3px,0.4vw,6px)] border-[#0c0c12] bg-black ring-1 ring-[color:var(--color-hairline-strong)]">
            <div
              aria-hidden
              className="absolute left-1/2 top-[clamp(3px,0.4vw,6px)] z-[2] h-[clamp(6px,0.8vw,14px)] w-[40%] -translate-x-1/2 rounded-full bg-black"
            />
            <img
              src={shots.mobile.src}
              alt={shots.mobile.label}
              loading="lazy"
              decoding="async"
              className="block h-full w-full object-cover object-top"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ boxShadow: "inset 0 0 22px rgba(124,58,237,0.26)" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Work-tools composition — a dominant desktop hero (browser pane) with two
 * smaller desktop views flanking the bottom (Git + Files panes).
 */
function WorkToolsComposition({ shots }: { shots: ToolsShots }) {
  const frame = `${compositionFrame} rounded-[clamp(6px,0.8vw,12px)]`;
  return (
    <div className="relative w-full self-center">
      {/* localized violet glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -m-8"
        style={{
          background:
            "radial-gradient(ellipse 74% 64% at 50% 48%, rgba(124,58,237,0.42) 0%, rgba(124,58,237,0.1) 46%, transparent 78%)",
          zIndex: 0,
        }}
      />

      <div className="relative isolate w-full pb-[7%]">
        {/* Hero — browser pane (largest) */}
        <div
          className="relative z-0 mx-auto w-[88%] motion-safe:transition-transform motion-safe:duration-500"
          style={{ boxShadow: "0 30px 56px rgba(0,0,0,0.6)" }}
        >
          <div className={`${compositionFrame} rounded-[clamp(8px,1vw,14px)]`}>
            <img
              src={shots.hero.src}
              alt={shots.hero.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* Git pane — bottom-left */}
        <div
          className="absolute bottom-[2%] left-[-1%] z-20 w-[49%] origin-bottom-left -rotate-[1.5deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.05] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 22px 40px rgba(0,0,0,0.66)" }}
        >
          <div className={frame}>
            <img
              src={shots.left.src}
              alt={shots.left.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>

        {/* Files pane — bottom-right */}
        <div
          className="absolute bottom-[2%] right-[-1%] z-30 w-[49%] origin-bottom-right rotate-[1.5deg] motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out [@media(hover:hover)]:hover:z-40 [@media(hover:hover)]:hover:scale-[1.05] [@media(hover:hover)]:hover:rotate-0"
          style={{ boxShadow: "0 22px 40px rgba(0,0,0,0.66)" }}
        >
          <div className={frame}>
            <img
              src={shots.right.src}
              alt={shots.right.label}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageStage({ tab }: { tab: ShowcaseTab }) {
  if (tab.composition) {
    return (
      <div className="flex h-full items-center lg:pl-[clamp(6px,1.4vw,30px)]">
        <ShowcaseComposition trio={tab.composition} />
      </div>
    );
  }

  if (tab.chatComposition) {
    return (
      <div className="flex h-full items-center lg:pl-[clamp(6px,1.4vw,30px)]">
        <ChatComposition shots={tab.chatComposition} />
      </div>
    );
  }

  if (tab.prComposition) {
    return (
      <div className="flex h-full items-center lg:pl-[clamp(6px,1.4vw,30px)]">
        <PrComposition shots={tab.prComposition} />
      </div>
    );
  }

  if (tab.toolsComposition) {
    return (
      <div className="flex h-full items-center lg:pl-[clamp(6px,1.4vw,30px)]">
        <WorkToolsComposition shots={tab.toolsComposition} />
      </div>
    );
  }

  const [primary, ...rest] = tab.images ?? [];
  return (
    <div className="flex flex-col gap-[clamp(10px,1.2vw,16px)]">
      {primary ? <ImagePanel image={primary} primary /> : null}
      {rest.length > 0 ? (
        <div
          className="grid gap-[clamp(10px,1.2vw,16px)]"
          style={{ gridTemplateColumns: `repeat(${rest.length}, minmax(0,1fr))` }}
        >
          {rest.map((image) => (
            <ImagePanel key={image.file} image={image} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CopyPanel({ tab }: { tab: ShowcaseTab }) {
  return (
    <div className="flex flex-col justify-center">
      <p className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--color-violet-bright)]">
        {tab.number} · {tab.label}
      </p>
      <h3
        className="mt-3 font-serif font-normal tracking-[-0.015em] text-[color:var(--color-cream)]"
        style={{ fontSize: "clamp(28px,3.6vw,48px)", lineHeight: 1.04 }}
      >
        {tab.title}
      </h3>
      <p
        className="mt-4 max-w-[42ch] text-[color:var(--color-cream-muted)]"
        style={{ fontSize: "clamp(16px,1.5vw,19px)", lineHeight: 1.5 }}
      >
        {tab.summary}
      </p>
      <ul className="mt-7 space-y-3.5">
        {tab.bullets.map((bullet) => (
          <li
            key={bullet}
            className="flex gap-3 text-[15px] leading-snug text-[color:var(--color-cream-muted)]"
          >
            <span className="mt-[0.5em] h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-violet-bright)] shadow-[0_0_8px_rgba(124,58,237,0.85)]" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      <p className="mt-8 border-l-2 border-[color:var(--color-violet-bright)]/50 pl-4 font-serif text-[14px] italic leading-relaxed text-[color:var(--color-cream)]">
        {tab.footnote}
      </p>
    </div>
  );
}

export function ShipShowcase() {
  const reduceMotion = useReducedMotion() ?? true;
  const [active, setActive] = useState(0);
  // Tabs mount on first activation — plus the next tab in rotation, prefetched
  // a full cycle ahead so its images are fetched and decoded before the
  // crossfade — and stay mounted afterward. Bounds the initial image load to
  // two tabs instead of all four while keeping switches decode-jank-free.
  const [mountedTabs, setMountedTabs] = useState(() => new Set([0, 1]));

  useEffect(() => {
    setMountedTabs((prev) => {
      const upcoming = (active + 1) % TABS.length;
      if (prev.has(active) && prev.has(upcoming)) return prev;
      const grown = new Set(prev);
      grown.add(active);
      grown.add(upcoming);
      return grown;
    });
  }, [active]);

  const selectTab = useCallback((index: number) => {
    setActive(index);
  }, []);

  // Auto-advance only. The progress bar is a keyed CSS-transform animation
  // (see below) that restarts itself whenever `active` changes — no per-frame
  // React state, so switching tabs can't make the bar lag or run backwards.
  useEffect(() => {
    if (reduceMotion) return;

    const advance = window.setTimeout(() => {
      setActive((current) => (current + 1) % TABS.length);
    }, ROTATE_MS);

    return () => window.clearTimeout(advance);
  }, [active, reduceMotion]);

  return (
    <section
      id="ship-showcase"
      className="relative mx-auto w-full max-w-[1760px] pt-[clamp(6px,0.8vw,14px)]"
    >
      {/* gradient top rule — more color than a flat hairline */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(167,139,250,0.45) 28%, rgba(124,58,237,0.6) 50%, rgba(167,139,250,0.45) 72%, transparent)",
        }}
      />
      {/* layered violet + indigo glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[-12%] top-[6%] bottom-[-10%] -z-10"
        style={{
          background: [
            "radial-gradient(ellipse 50% 46% at 78% 42%, rgba(124,58,237,0.36) 0%, transparent 72%)",
            "radial-gradient(ellipse 44% 42% at 10% 72%, rgba(99,102,241,0.18) 0%, transparent 74%)",
          ].join(", "),
        }}
      />

      {/* Heading on the left, tab rail to its right so the whole section header
          fits one row on laptop screens and the stage starts higher. */}
      <div className="grid gap-x-[clamp(28px,3vw,56px)] gap-y-[clamp(24px,3vw,38px)] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <header className="max-w-[60ch]">
          <p className="text-[11px] uppercase tracking-[0.26em] text-[color:var(--color-violet-bright)]">
            One repo, every surface
          </p>
          <h2
            className="mt-4 font-serif font-normal tracking-[-0.02em] text-[color:var(--color-cream)]"
            style={{ fontSize: "clamp(34px, 3.4vw, 56px)", lineHeight: 1.02 }}
          >
            Ship code from{" "}
            <em className="bg-gradient-to-r from-[#b6a3ff] via-[#dcc9ff] to-[#7c3aed] bg-clip-text text-transparent">
              any screen.
            </em>
          </h2>
          <p
            className="mt-5 max-w-[48ch] text-[color:var(--color-cream-muted)]"
            style={{ fontSize: "clamp(16px, 1.6vw, 19px)", lineHeight: 1.55 }}
          >
            A terminal app, a desktop app, and an iOS companion — always in sync. Start on one,
            finish on another.
          </p>
        </header>

        {/* Tab rail — sits to the right of the headline, bottom-aligned with it */}
        <div className="w-full lg:w-auto lg:pb-1">
          <div
            role="tablist"
            aria-label="Product walkthrough"
            className="flex flex-wrap gap-2 sm:gap-3"
          >
          {TABS.map((item, index) => {
            const selected = index === active;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => selectTab(index)}
                className={cn(
                  "group relative overflow-hidden rounded-[8px] border px-4 py-3 text-left transition-all duration-300 sm:px-5 sm:py-3.5",
                  selected
                    ? "border-[color:var(--color-violet-bright)] bg-[color:var(--color-violet-bright)]/[0.12] text-[color:var(--color-cream)] shadow-[0_0_30px_-6px_rgba(124,58,237,0.6)]"
                    : "border-[color:var(--color-hairline-strong)] bg-transparent text-[color:var(--color-cream-muted)] hover:border-[color:var(--color-violet-bright)]/50 hover:text-[color:var(--color-cream)]"
                )}
              >
                <span
                  className={cn(
                    "block text-[11px] uppercase tracking-[0.18em] transition-colors",
                    selected
                      ? "text-[color:var(--color-violet-bright)]"
                      : "text-[color:var(--color-cream-faint)] group-hover:text-[color:var(--color-violet-bright)]"
                  )}
                >
                  {item.number}
                </span>
                <span className="mt-1 block text-[14px] font-medium sm:text-[15.5px]">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>

        <div
          className="mt-3 h-[2px] overflow-hidden rounded-full bg-[color:var(--color-hairline)]"
          aria-hidden
        >
          {/* Pure CSS fill — runs on the compositor, immune to main-thread jank. */}
          <div
            key={active}
            className="h-full w-full origin-left rounded-full bg-[color:var(--color-violet-bright)] shadow-[0_0_10px_rgba(124,58,237,0.7)]"
            style={{
              animation: reduceMotion ? "none" : `ship-progress ${ROTATE_MS}ms linear forwards`,
            }}
          />
        </div>
        </div>
      </div>

      {/* Stage — copy + big image deck. All four tabs stay mounted and stacked
          in the same grid cell; switching only crossfades opacity, so the big
          screenshots decode once instead of re-decoding on every tab change. */}
      <div className="relative mt-[clamp(12px,1.6vw,26px)] grid min-h-[clamp(460px,48vw,740px)]">
        {TABS.map((item, index) => {
          const selected = index === active;
          return (
            <div
              key={item.id}
              aria-hidden={!selected}
              className={cn(
                "col-start-1 row-start-1 grid gap-[clamp(18px,2.2vw,40px)] transition-[opacity,transform] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] lg:grid-cols-[minmax(0,0.44fr)_minmax(0,1.56fr)] lg:items-center",
                selected
                  ? "z-[1] opacity-100 motion-safe:translate-y-0"
                  : "z-0 pointer-events-none opacity-0 motion-safe:translate-y-[10px]"
              )}
            >
              {selected || mountedTabs.has(index) ? (
                <>
                  <CopyPanel tab={item} />
                  <ImageStage tab={item} />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
