import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { AppWindow, Cloud, GitPullRequest, Globe, Monitor, Users } from "lucide-react";
import { cn } from "../../lib/cn";
import { AndroidMark, AppleMark, GithubMark, LinearMark, WindowsMark } from "./marks";

/*
 * Everything an agent can reach, as tabs beside one large stage (the feature
 * tabs Linear and Raycast use) instead of a scroll-pinned film or a wall of
 * tiles. The tabs advance on their own while the section is on screen, until
 * the visitor picks one. Every picture is the real ADE app with real agents
 * at work; the layered shots are transparent so they float on the stage. The
 * Android phone is a 1080×2400 frame of ade-app.dev in Chrome on an emulator
 * ADE started.
 */

const ROTATE_MS = 7000;

type Where = { label: string; cloud?: boolean; soon?: boolean };

type Tab = {
  id: string;
  icons: ReactNode[];
  name: string;
  line: string;
  chips: string[];
  where: Where[];
  /** Tints the stage while the tab shows. */
  glow: string;
  stage: (active: boolean) => ReactNode;
};

const iconClass = "h-[17px] w-[17px]";

const TABS: Tab[] = [
  {
    id: "phones",
    icons: [<AppleMark key="a" className={cn(iconClass, "text-white")} />, <AndroidMark key="g" className={cn(iconClass, "text-[#3ddc84]")} />],
    name: "iPhone and Android",
    line: "Agents build your app, run it on a simulator or emulator, tap through it and send you the recording.",
    chips: ["iOS Simulator", "Android emulator", "SwiftUI and Compose previews", "Foldables"],
    where: [{ label: "Any of your computers" }, { label: "Android on ADE Cloud", cloud: true }, { label: "iOS on ADE Cloud", soon: true }],
    glow: "rgba(61,220,132,0.16)",
    stage: () => (
      <>
        <Shot src="/images/home/tools/slide-apple.webp" alt="An agent's report in ADE beside a live iPhone simulator, with its private Mac desktop showing the same site in Safari" place={[2, 5, 120]} />
        <figure className="absolute bottom-[7%] left-[4%] w-[19%] overflow-hidden rounded-[22px] border-[5px] border-[#1d1d24] bg-black shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.08)]">
          <img src="/images/home/tools/android-chrome.webp" alt="ade-app.dev open in Chrome on an Android emulator ADE started" width={540} height={1200} loading="lazy" decoding="async" className="block h-auto w-full" />
        </figure>
      </>
    ),
  },
  {
    id: "desktops",
    icons: [<Monitor key="m" className={cn(iconClass, "text-white")} strokeWidth={1.8} />, <WindowsMark key="w" className="h-[15px] w-[15px] text-[#3ea6ff]" />],
    name: "Private desktops",
    line: "Each agent gets its own Mac, Windows or Linux screen to click around in. Yours stays free.",
    chips: ["macOS", "Windows", "Linux", "Screenshots and video"],
    where: [{ label: "Any of your computers" }, { label: "Linux on ADE Cloud", cloud: true }],
    glow: "rgba(59,130,246,0.2)",
    stage: () => <Shot src="/images/home/tools/slide-windows.webp" alt="An agent's screenshot of its private Windows desktop in ADE, beside the live Windows Desktop pane" place={[2, 5, 118]} />,
  },
  {
    id: "browser",
    icons: [<Globe key="b" className={cn(iconClass, "text-[#22d3ee]")} strokeWidth={1.8} />],
    name: "ADE Browser",
    line: "Agents open your site in a browser that is signed in as you, click through it and screenshot what they find.",
    chips: ["Your sign-ins", "Clicks and forms", "Page reads", "Screenshots"],
    where: [{ label: "Any of your computers" }, { label: "ADE Cloud", cloud: true }],
    glow: "rgba(34,211,238,0.16)",
    stage: () => <Shot src="/images/home/tools/slide-browser.webp" alt="An agent's steps in ADE beside ADE's browser, showing the download dialog it opened on ade-app.dev" bright={1.45} place={[-76, -6, 170]} />,
  },
  {
    id: "app",
    icons: [<AppWindow key="e" className={cn(iconClass, "text-[#9feaf9]")} strokeWidth={1.8} />],
    name: "Your own app",
    line: "App Control launches your Electron or desktop app, drives it, reads its logs and records it.",
    chips: ["Launch or attach", "Click and type", "Logs", "Video"],
    where: [{ label: "Any of your computers" }],
    glow: "rgba(159,234,249,0.14)",
    stage: () => <Shot src="/images/home/tools/slide-appc.webp" alt="ADE's App Control pane driving a small Electron app that shows ADE's v1.2.112 release notes" place={[-77, -5, 170]} />,
  },
  {
    id: "ship",
    icons: [<GithubMark key="g" className={cn(iconClass, "text-white")} />, <LinearMark key="l" className="h-[15px] w-[15px] text-[#8b93ff]" />],
    name: "PRs and issues",
    line: "Open, review, fix failing checks and merge, next to the chat that wrote the code.",
    chips: ["Pull requests", "Stacked PRs", "Checks and reviews", "Linear, Jira, GitHub issues"],
    where: [{ label: "Any of your computers" }, { label: "ADE Cloud", cloud: true }],
    glow: "rgba(16,185,129,0.16)",
    stage: () => <Shot src="/images/home/tools/slide-work.webp" alt="A real ADE pull request with its checks and merge panel, and a GitHub issue, layered" place={[2, 5, 118]} />,
  },
  {
    id: "team",
    icons: [<Users key="u" className={cn(iconClass, "text-[#c4b5fd]")} strokeWidth={1.8} />, <GitPullRequest key="p" className={cn(iconClass, "text-white/80")} strokeWidth={1.8} />],
    name: "Agent teams",
    line: "One chat hands parts of the job to other agents on other models, then reports back.",
    chips: ["Subagents", "Mix models", "A CTO that remembers"],
    where: [{ label: "Any of your computers" }, { label: "ADE Cloud", cloud: true }],
    glow: "rgba(167,139,250,0.2)",
    stage: (active) => <TeamFilm active={active} />,
  },
];

export function ToolsSection() {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const [inView, setInView] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const rotating = auto && inView && !reduceMotion;
  useEffect(() => {
    if (!rotating) return;
    const timer = window.setTimeout(() => setActive((index) => (index + 1) % TABS.length), ROTATE_MS);
    return () => window.clearTimeout(timer);
  }, [rotating, active]);

  const pick = (index: number) => {
    setAuto(false);
    setActive(index);
  };
  const tab = TABS[active]!;

  return (
    <section ref={sectionRef} aria-labelledby="tools-title" className="mx-auto max-w-[1320px] px-5 pt-[clamp(24px,3vw,48px)] sm:px-8">
      <div className="mx-auto max-w-[780px] text-center">
        <h2 id="tools-title" className="font-display text-white" style={{ fontSize: "clamp(32px, 3.6vw, 52px)", lineHeight: 1.04, letterSpacing: "-0.04em" }}>
          Everything your agents can reach.
          <br />
          <span className="text-white/45">On your computers, or ours.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-[44rem] text-[clamp(15px,1.2vw,17px)] leading-[1.6] text-white/60">
          Phones, desktops, browsers and your own app, on any computer you own or an ADE Cloud one. Any computer can use another's: drive your
          Mac's iPhone simulator from a Windows laptop.
        </p>
      </div>

      <div className="mt-[clamp(32px,4vw,56px)] grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]" onMouseEnter={() => setAuto(false)}>
        <div role="tablist" aria-label="What agents can reach" aria-orientation="vertical" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
          {TABS.map((item, index) => {
            const selected = index === active;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`tool-tab-${item.id}`}
                aria-selected={selected}
                aria-controls="tool-stage"
                onClick={() => pick(index)}
                className={cn(
                  "focus-ring relative shrink-0 overflow-hidden rounded-[18px] border text-left transition-colors lg:w-full",
                  selected ? "border-white/[0.12] bg-white/[0.055]" : "border-transparent hover:bg-white/[0.03]",
                )}
              >
                <span className="flex items-center gap-3 px-4 py-3 lg:py-3.5">
                  <span className="flex shrink-0 items-center gap-1.5">
                    {item.icons.map((icon, i) => (
                      <span key={i} className="grid h-8 w-8 place-items-center rounded-[9px] border border-white/10 bg-gradient-to-b from-[#26262e] to-[#15151a]">
                        {icon}
                      </span>
                    ))}
                  </span>
                  <span className={cn("whitespace-nowrap text-[15px] font-semibold transition-colors", selected ? "text-white" : "text-white/60")}>{item.name}</span>
                </span>
                {selected && (
                  <span className="hidden px-4 pb-4 lg:block">
                    <TabDetails tab={item} />
                  </span>
                )}
                {selected && rotating && (
                  <span key={`${item.id}-${active}`} aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-white/40" style={{ animation: `ade-tab-progress ${ROTATE_MS}ms linear forwards` }} />
                )}
              </button>
            );
          })}
        </div>

        <div
          id="tool-stage"
          role="tabpanel"
          aria-labelledby={`tool-tab-${tab.id}`}
          className="relative aspect-[16/10] overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,#15141c,#0d0c12)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
        >
          {TABS.map((item, index) => (
            <div
              key={item.id}
              aria-hidden={index !== active}
              className={cn("absolute inset-0 transition-opacity duration-500 ease-out", index === active ? "opacity-100" : "pointer-events-none opacity-0")}
            >
              <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(80% 70% at 70% 100%, ${item.glow}, transparent 70%)` }} />
              {item.stage(index === active)}
            </div>
          ))}
        </div>

        <div className="lg:hidden">
          <p className="text-[17px] font-semibold text-white">{tab.name}</p>
          <div className="mt-2">
            <TabDetails tab={tab} />
          </div>
        </div>
      </div>
    </section>
  );
}

function TabDetails({ tab }: { tab: Tab }) {
  return (
    <>
      <span className="block text-[14px] leading-[1.55] text-white/65">{tab.line}</span>
      <span className="mt-3 flex flex-wrap gap-1.5">
        {tab.chips.map((chip) => (
          <span key={chip} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12.5px] text-white/75">
            {chip}
          </span>
        ))}
      </span>
      <span className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[12.5px]">
        {tab.where.map((where) => (
          <span key={where.label} className={cn("inline-flex items-center gap-1.5", where.soon ? "text-white/40" : where.cloud ? "text-[#c4b5fd]" : "text-white/55")}>
            {where.cloud || where.soon ? <Cloud className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            {where.label}
            {where.soon && <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-[11px] text-white/50">soon</span>}
          </span>
        ))}
      </span>
    </>
  );
}

/**
 * A transparent, layered capture on the stage, large enough to read and
 * bleeding off the stage's edges. `place` is its left and top edge and its
 * width, as percentages of the stage.
 */
function Shot({ src, alt, bright, place }: { src: string; alt: string; bright?: number; place: [number, number, number] }) {
  const [left, top, width] = place;
  return (
    <img
      src={src}
      alt={alt}
      width={2400}
      height={1447}
      loading="lazy"
      decoding="async"
      className="absolute h-auto max-w-none"
      style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, filter: bright ? `brightness(${bright})` : undefined }}
    />
  );
}

/** The orchestration film, looping while its tab shows; a still for reduced motion. */
function TeamFilm({ active }: { active: boolean }) {
  const reduceMotion = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const node = video.current;
    if (!node) return;
    if (active) {
      node.currentTime = 0;
      void node.play().catch(() => undefined);
    } else node.pause();
  }, [active]);

  const frame = "absolute inset-[5%] overflow-hidden rounded-[16px] border border-white/10 shadow-[0_30px_80px_-24px_rgba(0,0,0,0.9)]";
  if (reduceMotion) {
    return (
      <div className={frame}>
        <img src="/film/compose-done.jpg" alt="A chat in ADE that split one job across three agents on three models, each reporting back" width={3024} height={1964} loading="lazy" className="h-full w-full object-cover object-top" />
      </div>
    );
  }
  return (
    <div className={frame}>
      <video
        ref={video}
        src="/film/compose.mp4"
        poster="/film/compose-done.jpg"
        muted
        loop
        playsInline
        preload="none"
        aria-label="A chat in ADE that splits one job across three agents on three models, each reporting back"
        className="h-full w-full object-cover object-top"
      />
    </div>
  );
}
