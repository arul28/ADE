import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Globe } from "lucide-react";
import { cn } from "../../lib/cn";
import { AppleMark, ElectronMark, GithubMark, LinearMark, WindowsMark } from "./marks";

/*
 * "Power up your agents": sticky steps over real screenshots. Every picture
 * is the real ADE app at 140% zoom, on a test copy of ADE's own repo, while
 * real agents worked: they checked ade-app.dev in ADE's browser, on an iPhone
 * simulator and on a Mac desktop, used a Windows desktop, drove an Electron app with App Control, and
 * edited the docs on a worktree. Slides that cover several tools layer them. The text
 * steps scroll; the picture beside them stays in the middle of the screen and
 * changes with the step.
 */

/** `icons` sit above the title, each in a small app-icon tile. */
type Step = { icons: ReactNode[]; title: string; body: string; src: string; width: number; height: number; alt: string };

const STEPS: Step[] = [
  {
    icons: [<AppleMark key="apple" className="h-[22px] w-[22px] text-white" />],
    title: "Apple dev tools",
    body: "Agents run and record simulators, and they get their own Mac desktop.",
    src: "/images/home/tools/slide-apple.webp",
    width: 2400,
    height: 1447,
    alt: "An agent's report in ADE beside a live iPhone simulator, with its private Mac desktop showing the same site in Safari",
  },
  {
    icons: [<WindowsMark key="windows" className="h-5 w-5 text-[#3ea6ff]" />],
    title: "Windows dev tools",
    body: "Agents get their own private Windows desktop to control, and send you proof from it.",
    src: "/images/home/tools/slide-windows.webp",
    width: 2400,
    height: 1447,
    alt: "An agent's screenshot of its private Windows desktop in ADE, beside the live Windows Desktop pane",
  },
  {
    icons: [<Globe key="browser" className="h-6 w-6 text-[#22d3ee]" strokeWidth={1.8} />],
    title: "ADE Browser",
    body: "Agents record and screenshot your site in ADE's own browser. Pick any element to add it to the chat. Your sign-ins come with you.",
    src: "/images/home/tools/slide-browser.webp",
    width: 2400,
    height: 1447,
    alt: "An agent's steps in ADE beside ADE's browser, showing the download dialog it opened on ade-app.dev",
  },
  {
    icons: [<ElectronMark key="electron" className="h-6 w-6 text-[#9feaf9]" />],
    title: "Electron Inspector",
    body: "Agents run and control your Electron app, and record videos and screenshots of it.",
    src: "/images/home/tools/slide-appc.webp",
    width: 2400,
    height: 1447,
    alt: "ADE's App Control pane driving a small Electron app that shows ADE's v1.2.112 release notes",
  },
  {
    icons: [<GithubMark key="github" className="h-[22px] w-[22px] text-white" />, <LinearMark key="linear" className="h-5 w-5 text-[#8b93ff]" />],
    title: "PRs, Git and issue tracking",
    body: "Review, fix and merge, all beside the chat.",
    src: "/images/home/tools/slide-work.webp",
    width: 2400,
    height: 1447,
    alt: "A real ADE pull request with its checks and merge panel, the worktree's commit history, and a GitHub issue, layered",
  },
];

export function ToolsSection() {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<Array<HTMLDivElement | null>>([]);

  // The step whose middle is nearest the middle of the screen is the active one.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = stepRefs.current.indexOf(entry.target as HTMLDivElement);
          if (index >= 0) setActive(index);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const el of stepRefs.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section data-story="tools" className="relative pt-24">
      <div className="mx-auto max-w-[760px] px-5 text-center">
        <h2 className="font-serif text-white" style={{ fontSize: "clamp(34px, 4vw, 56px)", lineHeight: 1.04, letterSpacing: "-0.02em" }}>
          Power up your agents.
        </h2>
        <p className="mx-auto mt-3 max-w-[560px] text-[clamp(14px,1.1vw,17px)] leading-[1.55] text-white/55">
          Every agent gets the tools it needs to check its own work.
        </p>
      </div>

      {/*
        Wide screens: the text steps scroll past on the left; the picture stays in
        the middle of the screen on the right. Each step is one screen tall with
        its text in the middle, so the text and the picture always line up.
      */}
      <div className="mx-auto hidden max-w-[1680px] grid-cols-[minmax(300px,380px)_1fr] gap-12 px-8 lg:grid">
        <div>
          {STEPS.map((step, i) => (
            <div key={step.title} ref={(el) => { stepRefs.current[i] = el; }} className="flex h-screen flex-col justify-center">
              <div className={cn("transition-opacity duration-500", active === i ? "opacity-100" : "opacity-30")}>
                <StepIcons icons={step.icons} />
                <h3 className="mt-5 text-[clamp(30px,2.6vw,40px)] font-semibold leading-[1.08] tracking-[-0.025em] text-white">{step.title}</h3>
                <p className="mt-4 text-[clamp(18px,1.35vw,21px)] font-medium leading-[1.4] tracking-[-0.01em] text-white/55">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="relative">
          <div className="sticky top-0 flex h-screen items-center justify-center">
            <div
              className="relative w-full"
              style={{ aspectRatio: "2400 / 1447", maxWidth: "calc((100vh - 96px) * 1.6586)" }}
            >
              {STEPS.map((step, i) => (
                <img
                  key={step.src}
                  src={step.src}
                  alt={step.alt}
                  width={step.width}
                  height={step.height}
                  loading="lazy"
                  decoding="async"
                  className={cn(
                    "absolute inset-0 h-full w-full object-cover object-left-top transition-[opacity,transform] duration-700 ease-out",
                    active === i ? "scale-100 opacity-100" : "scale-[1.015] opacity-0",
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Narrow screens: each step with its picture. */}
      <div className="mx-auto mt-12 grid max-w-[760px] gap-14 px-5 pb-24 lg:hidden">
        {STEPS.map((step, i) => (
          <div key={step.title}>
            <StepIcons icons={step.icons} />
            <h3 className="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-white">{step.title}</h3>
            <p className="mt-2 text-[17px] font-medium leading-[1.4] text-white/55">{step.body}</p>
            <img src={step.src} alt={step.alt} width={step.width} height={step.height} loading="lazy" className="mt-5 w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

function StepIcons({ icons }: { icons: ReactNode[] }) {
  return (
    <div className="flex gap-2.5">
      {icons.map((icon, i) => (
        <span key={i} className="grid h-12 w-12 place-items-center rounded-[13px] border border-white/10 bg-gradient-to-b from-[#26262e] to-[#15151a] shadow-[0_8px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]">
          {icon}
        </span>
      ))}
    </div>
  );
}
