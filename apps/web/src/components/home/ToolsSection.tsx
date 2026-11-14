import type { ReactNode } from "react";
import { Globe } from "lucide-react";
import { cn } from "../../lib/cn";
import { AppleMark, ElectronMark, GithubMark, LinearMark, WindowsMark } from "./marks";

/*
 * What agents can do on your own computers, as one grid of large pictures.
 * Every picture is the real ADE app at 140% zoom, on a test copy of ADE's own
 * repo, while real agents worked: they checked ade-app.dev in ADE's browser,
 * on an iPhone simulator and on a Mac desktop, used a Windows desktop, drove
 * an Electron app with App Control, and reviewed a pull request. The two
 * widest pictures lead; the other three share the row under them.
 */

/** `glow` tints the tile from its lower corner, so each tile has its own colour. */
/**
 * `crop` frames the part of the screenshot that shows the tool at work, as
 * fractions of the full picture: its left and top edge, and its width.
 */
type Tool = { icons: ReactNode[]; title: string; body: string; src: string; alt: string; glow: string; crop: [number, number, number]; bright?: number };

const TOOLS: Tool[] = [
  {
    icons: [<AppleMark key="apple" className="h-[18px] w-[18px] text-white" />],
    title: "Apple dev tools",
    body: "Simulators and a Mac desktop, for agents.",
    glow: "rgba(148,163,184,0.22)",
    src: "/images/home/tools/slide-apple.webp",
    crop: [0.4, 0.12, 0.5],
    alt: "An agent's report in ADE beside a live iPhone simulator, with its private Mac desktop showing the same site in Safari",
  },
  {
    icons: [<GithubMark key="github" className="h-[18px] w-[18px] text-white" />, <LinearMark key="linear" className="h-4 w-4 text-[#8b93ff]" />],
    title: "PRs, Git and issues",
    body: "Review, fix and merge, beside the chat.",
    glow: "rgba(16,185,129,0.2)",
    src: "/images/home/tools/slide-work.webp",
    crop: [0.335, 0.03, 0.3],
    alt: "A real ADE pull request with its checks and merge panel, the worktree's commit history, and a GitHub issue, layered",
  },
  {
    icons: [<Globe key="browser" className="h-[18px] w-[18px] text-[#22d3ee]" strokeWidth={1.8} />],
    title: "ADE Browser",
    body: "Test your site, signed in.",
    glow: "rgba(34,211,238,0.2)",
    src: "/images/home/tools/slide-browser.webp",
    crop: [0.46, 0.34, 0.4],
    bright: 1.6,
    alt: "An agent's steps in ADE beside ADE's browser, showing the download dialog it opened on ade-app.dev",
  },
  {
    icons: [<WindowsMark key="windows" className="h-4 w-4 text-[#3ea6ff]" />],
    title: "Windows desktop",
    body: "A private Windows desktop.",
    glow: "rgba(59,130,246,0.24)",
    src: "/images/home/tools/slide-windows.webp",
    crop: [0.45, 0.08, 0.5],
    alt: "An agent's screenshot of its private Windows desktop in ADE, beside the live Windows Desktop pane",
  },
  {
    icons: [<ElectronMark key="electron" className="h-[18px] w-[18px] text-[#9feaf9]" />],
    title: "Electron apps",
    body: "Drive and record your app.",
    glow: "rgba(159,234,249,0.16)",
    src: "/images/home/tools/slide-appc.webp",
    crop: [0.46, 0.02, 0.52],
    alt: "ADE's App Control pane driving a small Electron app that shows ADE's v1.2.112 release notes",
  },
];

export function ToolsSection() {
  return (
    <section aria-labelledby="tools-title" className="mx-auto max-w-[1320px] px-5 pt-[clamp(24px,3vw,48px)] sm:px-8">
      <div className="mx-auto max-w-[760px] text-center">
        <h2
          id="tools-title"
          className="font-display text-white"
          style={{ fontSize: "clamp(32px, 3.6vw, 52px)", lineHeight: 1.04, letterSpacing: "-0.04em" }}
        >
          Your machines, or ours.
          <br />
          <span className="text-white/45">Full control.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-[44rem] text-[clamp(15px,1.2vw,17px)] leading-[1.6] text-white/60">
          Agents get full control of every computer, yours or a cloud one, and check their own work.
        </p>
      </div>

      <div className="mt-[clamp(36px,4vw,56px)] grid gap-3 md:grid-cols-6">
        {TOOLS.map((tool, i) => (
          <ToolTile key={tool.title} tool={tool} wide={i < 2} />
        ))}
      </div>
    </section>
  );
}

function ToolTile({ tool, wide }: { tool: Tool; wide: boolean }) {
  return (
    <figure
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,#17161f,#0f0e15)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        wide ? "md:col-span-3" : "md:col-span-2",
      )}
    >
      <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(110% 80% at 100% 100%, ${tool.glow}, transparent 62%)` }} />
      <figcaption className="relative z-10 px-6 pb-5 pt-6 sm:px-7">
        <div className="flex items-center gap-2">
          {tool.icons.map((icon, i) => (
            <span key={i} className="grid h-8 w-8 place-items-center rounded-[9px] border border-white/10 bg-gradient-to-b from-[#26262e] to-[#15151a]">
              {icon}
            </span>
          ))}
          <span className="ml-1 text-[13px] font-medium text-white/55">{tool.title}</span>
        </div>
        <p className="mt-2.5 truncate text-[clamp(18px,1.5vw,22px)] font-semibold leading-[1.2] tracking-[-0.015em] text-white">{tool.body}</p>
      </figcaption>
      <div className={cn("relative mx-5 mb-5 mt-auto overflow-hidden rounded-[14px] border border-white/10 bg-[#0b0b10] sm:mx-6 sm:mb-6", wide ? "h-[clamp(240px,26vw,360px)]" : "h-[clamp(200px,17vw,250px)]")}>
        <img
          src={tool.src}
          alt={tool.alt}
          width={2400}
          height={1447}
          loading="lazy"
          decoding="async"
          className="absolute left-0 top-0 h-auto max-w-none"
          style={{ width: `${100 / tool.crop[2]}%`, transform: `translate(-${tool.crop[0] * 100}%, -${tool.crop[1] * 100}%)`, filter: `brightness(${tool.bright ?? 1.15}) contrast(1.05)` }}
        />
      </div>
    </figure>
  );
}
