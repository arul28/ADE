import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Camera,
  Cloud,
  Film,
  FoldHorizontal,
  GitFork,
  GitPullRequest,
  Globe,
  KeyRound,
  Layers,
  ListChecks,
  MessageSquare,
  Monitor,
  MousePointerClick,
  Network,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { AppleMark, GithubMark, LinearMark, LinuxMark, WindowsMark } from "./marks";

/*
 * What agents can do, as rows in the style of Cursor's feature rows: one
 * visual of the real app beside its words, alternating sides, straight on the
 * page. Every visual is ADE with a real agent at work:
 * - an agent testing the Crumb app on a folding iPhone simulator, beside a
 *   3D render of the Android emulator's Pixel (from the Android PR, #2069);
 * - a chat starting its private Mac screen and opening TextEdit there, with a
 *   Windows Desktop session and the three systems it runs on;
 * - one chat splitting a job across three agents on three models;
 * - a real pull request with its checks and a GitHub issue;
 * - ADE's browser with the download dialog an agent opened on ade-app.dev.
 * Clips play only while on screen; with reduced motion they show their poster.
 */

type Tone = "amber" | "sky" | "teal" | "emerald" | "violet";

/** The accent each row's label, points and link use. */
const ACCENTS: Record<Tone, string> = { amber: "#fdba74", sky: "#7dd3fc", teal: "#5eead4", emerald: "#6ee7b7", violet: "#c4b5fd" };

type Point = { icon: ReactNode; text: string };

const icon = "h-4 w-4";
const mark = "h-3.5 w-3.5";

export function ToolsSection() {
  return (
    <section aria-label="What agents can do" className="mx-auto flex max-w-[1240px] flex-col gap-[clamp(64px,8vw,128px)] px-5 pt-[clamp(24px,3vw,40px)] sm:px-8">
      <Row
        tone="amber"
        kicker={{ icons: [<AppleMark key="a" className={mark} />, <Smartphone key="s" className={mark} />], label: "Phones" }}
        title="Agents test on real phones."
        body="They run your app on an iPhone or Android simulator on any of your computers and tell you what broke."
        points={[
          { icon: <MousePointerClick className={icon} />, text: "Tap, type and scroll through every screen" },
          { icon: <FoldHorizontal className={icon} />, text: "Fold, turn and resize, down to the hinge angle" },
          { icon: <Film className={icon} />, text: "A recording of each run, attached to the chat" },
        ]}
        link={{ href: `${LINKS.docs}/tools/ios-simulator`, label: "How phone testing works" }}
        stage="aspect-[16/11]"
        visual={
          <>
            <Window className="absolute left-0 top-0 w-[86%]">
              <Clip src="/film/devices-iphone.mp4" poster="/film/devices-iphone.jpg" label="An agent in ADE testing the Crumb app on a folding iPhone simulator, folding and turning it" />
            </Window>
            <img
              src="/images/home/tools/android-pixel.webp"
              alt="The Android emulator's Pixel, as ADE renders it"
              width={700}
              height={1278}
              loading="lazy"
              decoding="async"
              className="absolute bottom-0 right-0 w-[24%] drop-shadow-[0_30px_40px_rgba(0,0,0,0.75)]"
            />
          </>
        }
      />
      <Row
        flip
        tone="sky"
        kicker={{
          icons: [<AppleMark key="a" className={mark} />, <WindowsMark key="w" className="h-3 w-3" />, <LinuxMark key="l" className={mark} />],
          label: "Desktops",
        }}
        title="A desktop of their own."
        body="Each agent gets a private Mac, Windows or Linux screen to open apps and click around in. Yours stays free."
        points={[
          { icon: <Monitor className={icon} />, text: "Its own display, pointer and keyboard" },
          { icon: <Layers className={icon} />, text: "Native apps, Safari, Xcode: anything with a window" },
          { icon: <Cloud className={icon} />, text: "Linux on your own boxes and on ADE Cloud computers" },
          { icon: <GitFork className={icon} />, text: "Drive any of your computers from any other" },
        ]}
        link={{ href: `${LINKS.docs}/computer-use/overview`, label: "How private desktops work" }}
        stage="aspect-[16/12]"
        visual={
          <>
            <Window className="absolute left-0 top-0 w-[80%]">
              <Clip src="/film/devices-mac.mp4" poster="/film/devices-mac.jpg" label="A chat in ADE starting its private Mac screen, then opening TextEdit there, with the Mac Desktop pane beside the chat" />
            </Window>
            <OsLogos className="absolute bottom-[5%] left-0" />
            <img
              src="/images/home/tools/slide-windows.webp"
              alt="ADE with an agent's private Windows desktop open in the Windows Desktop pane"
              width={2400}
              height={1447}
              decoding="async"
              className="absolute bottom-0 right-[-3%] w-[57%] drop-shadow-[0_30px_50px_rgba(0,0,0,0.7)]"
            />
          </>
        }
      />
      <Row
        tone="teal"
        kicker={{ icons: [<Network key="n" className={mark} />], label: "Orchestration" }}
        title="Coordinate every model from one chat."
        body="Hand parts of the job to Claude, GPT, DeepSeek or any model you use, watch them work side by side and get one report back."
        points={[
          { icon: <Sparkles className={icon} />, text: "A model for each part: one plans, a fast one writes the tests" },
          { icon: <MessageSquare className={icon} />, text: "Every agent's progress, live in the same chat" },
          { icon: <ListChecks className={icon} />, text: "One summary when they are all done" },
        ]}
        link={{ href: `${LINKS.docs}/concepts/subagents`, label: "How orchestration works" }}
        visual={
          <Window>
            <Clip src="/film/compose.mp4" poster="/film/compose-done.jpg" label="One chat in ADE splitting a job across three agents on three models, each reporting back" />
          </Window>
        }
      />
      <Row
        flip
        tone="emerald"
        kicker={{ icons: [<GithubMark key="g" className={mark} />, <LinearMark key="l" className="h-3 w-3" />], label: "Pull requests" }}
        title="Review, fix and merge from the chat."
        body="Open the PR, read its checks and reviews, have the agent fix what failed, then merge."
        points={[
          { icon: <GitPullRequest className={icon} />, text: "Checks, reviews and comments beside the chat" },
          { icon: <Layers className={icon} />, text: "Stacked PRs that merge in order" },
          { icon: <ListChecks className={icon} />, text: "Start work from GitHub, Linear or Jira issues" },
        ]}
        link={{ href: `${LINKS.docs}/tools/pull-requests`, label: "How pull requests work" }}
        visual={
          <img
            src="/images/home/tools/slide-work.webp"
            alt="A real pull request in ADE with its checks and merge panel, beside a GitHub issue"
            width={2400}
            height={1447}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full"
          />
        }
      />
      <Row
        tone="violet"
        kicker={{ icons: [<Globe key="b" className={mark} />], label: "Browser" }}
        title="A browser that's signed in as you."
        body="Agents open your site in ADE's browser with your sign-ins, click through it and show you what they found."
        points={[
          { icon: <KeyRound className={icon} />, text: "Your logins, without the agent ever seeing a password" },
          { icon: <MousePointerClick className={icon} />, text: "Clicks, forms and page reads" },
          { icon: <Camera className={icon} />, text: "Screenshots and recordings as proof" },
        ]}
        link={{ href: `${LINKS.docs}/tools/browser`, label: "How the browser works" }}
        visual={
          <img
            src="/images/home/tools/slide-browser.webp"
            alt="An agent's steps in ADE beside ADE's browser, showing the download dialog it opened on ade-app.dev"
            width={2400}
            height={1447}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full"
            style={{ filter: "brightness(1.35)" }}
          />
        }
      />
    </section>
  );
}

function Row({
  tone,
  kicker,
  title,
  body,
  points,
  link,
  visual,
  flip,
  stage,
}: {
  tone: Tone;
  kicker: { icons: ReactNode[]; label: string };
  title: string;
  body: string;
  points: Point[];
  link: { href: string; label: string };
  visual: ReactNode;
  flip?: boolean;
  /** An aspect class when the visual is a layout of absolutely placed pieces. */
  stage?: string;
}) {
  const accent = ACCENTS[tone];
  return (
    <div className={cn("grid items-center gap-8 lg:gap-14", flip ? "lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]" : "lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]")}>
      <div className={cn("relative", stage, flip && "lg:order-2")}>{visual}</div>
      <div className={cn("max-w-[30rem]", flip && "lg:order-1")}>
        <p className="inline-flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: accent }}>
          {kicker.icons}
          {kicker.label}
        </p>
        <h3 className="mt-3 text-[clamp(22px,2vw,28px)] font-medium leading-[1.25] tracking-[-0.02em] text-white">
          {title} <span className="text-white/50">{body}</span>
        </h3>
        <ul className="mt-6 flex flex-col gap-3 text-[15px] text-white/75">
          {points.map((point) => (
            <li key={point.text} className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0" style={{ color: accent }}>
                {point.icon}
              </span>
              {point.text}
            </li>
          ))}
        </ul>
        <a href={link.href} target="_blank" rel="noreferrer" className="focus-ring group mt-6 inline-flex items-center gap-1.5 rounded-md text-[15px] font-medium" style={{ color: accent }}>
          {link.label}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>
    </div>
  );
}

/** The three systems an agent's private screen runs on, as one floating card of their logos. */
function OsLogos({ className }: { className?: string }) {
  const systems = [
    { name: "macOS", logo: <AppleMark className="h-7 w-7 text-white" /> },
    { name: "Windows", logo: <WindowsMark className="h-6 w-6 text-[#3ea6ff]" /> },
    { name: "Linux", logo: <LinuxMark className="h-7 w-7 text-[#fcd34d]" /> },
  ];
  return (
    <div className={cn("flex gap-3 rounded-[20px] border border-white/[0.12] bg-[#12141f]/90 p-3 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-md", className)}>
      {systems.map((system) => (
        <div key={system.name} className="flex w-[clamp(64px,6vw,84px)] flex-col items-center gap-2 rounded-[14px] bg-white/[0.04] px-2 py-3">
          {system.logo}
          <span className="text-[12px] font-medium text-white/75">{system.name}</span>
        </div>
      ))}
    </div>
  );
}

/** A recording or shot framed as an app window, with the shadow a window casts. */
function Window({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-[10px] shadow-[0_30px_70px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.1)]", className)}>{children}</div>
  );
}

/** A silent loop that plays only while on screen; the poster alone for reduced motion. */
function Clip({ src, poster, label }: { src: string; poster: string; label: string }) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || reduceMotion) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setNear(true);
          void node.play().catch(() => undefined);
        } else node.pause();
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduceMotion]);

  if (reduceMotion) return <img src={poster} alt={label} width={1440} height={904} loading="lazy" className="block h-auto w-full" />;
  return (
    <video ref={ref} src={near ? src : undefined} poster={poster} muted loop playsInline autoPlay preload="none" aria-label={label} width={1440} height={904} className="block h-auto w-full" />
  );
}
