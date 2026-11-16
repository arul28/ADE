import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { ArrowRight, Film, FoldHorizontal, GitFork, Layers, ListChecks, Monitor, MousePointerClick, Smartphone, Sparkles, Users } from "lucide-react";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { AppleMark, WindowsMark } from "./marks";

/*
 * What agents can do on real devices, as rows in the style of Cursor's
 * feature rows: one recording beside its words, alternating sides. Every
 * visual is ADE with a real agent at work: testing the Crumb app on a folding
 * iPhone simulator, opening TextEdit on its private Mac screen, a Windows
 * Desktop session, and one chat splitting a job across three agents. Each
 * row has its own grainy colour field behind the recording and an accent
 * colour for its label, points and link. The fields are our own CSS: the
 * desktop app's scene pictures carry no recorded licence, so they stay off
 * the public site. Clips play only while on screen; with reduced motion they
 * show their poster.
 */

type Tone = "amber" | "sky" | "teal";

/** Each row's colour field and the accent its words use. */
const TONES: Record<Tone, { field: string; accent: string }> = {
  amber: {
    field:
      "radial-gradient(70% 80% at 15% 10%, rgba(251,146,60,0.55), transparent 60%), radial-gradient(60% 70% at 95% 95%, rgba(244,63,94,0.4), transparent 60%), linear-gradient(160deg, #2a1a12, #140d0c)",
    accent: "#fdba74",
  },
  sky: {
    field:
      "radial-gradient(70% 80% at 85% 5%, rgba(56,189,248,0.5), transparent 60%), radial-gradient(60% 70% at 5% 95%, rgba(99,102,241,0.45), transparent 60%), linear-gradient(160deg, #0f1a2c, #0b0e18)",
    accent: "#7dd3fc",
  },
  teal: {
    field:
      "radial-gradient(70% 80% at 10% 5%, rgba(45,212,191,0.42), transparent 60%), radial-gradient(60% 70% at 95% 95%, rgba(168,85,247,0.42), transparent 60%), linear-gradient(160deg, #0d1c1d, #0c0c14)",
    accent: "#5eead4",
  },
};

/** Film grain, so the colour fields read as texture rather than flat gradients. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E\")";

type Point = { icon: ReactNode; text: string };

export function ToolsSection() {
  const icon = "h-4 w-4";
  return (
    <section aria-label="What agents can do" className="mx-auto flex max-w-[1240px] flex-col gap-[clamp(56px,7vw,112px)] px-5 pt-[clamp(24px,3vw,40px)] sm:px-8">
      <Row
        tone="amber"
        kicker={{ icons: [<AppleMark key="a" className="h-3.5 w-3.5" />, <Smartphone key="s" className="h-3.5 w-3.5" />], label: "Phones" }}
        title="Agents test on real phones."
        body="They run your app on an iPhone or Android simulator on any of your computers and tell you what broke."
        points={[
          { icon: <MousePointerClick className={icon} />, text: "Tap, type and scroll through every screen" },
          { icon: <FoldHorizontal className={icon} />, text: "Fold, turn and resize, down to the hinge angle" },
          { icon: <Film className={icon} />, text: "A recording of each run, attached to the chat" },
        ]}
        link={{ href: `${LINKS.docs}/tools/ios-simulator`, label: "How phone testing works" }}
        visual={
          <Window>
            <Clip src="/film/devices-iphone.mp4" poster="/film/devices-iphone.jpg" label="An agent in ADE testing the Crumb app on a folding iPhone simulator, folding and turning it" />
          </Window>
        }
      />
      <Row
        flip
        tall
        tone="sky"
        kicker={{ icons: [<AppleMark key="a" className="h-3.5 w-3.5" />, <WindowsMark key="w" className="h-3 w-3" />], label: "Desktops" }}
        title="A desktop of their own."
        body="Each agent gets a private Mac or Windows screen to open apps and click around in. Yours stays free."
        points={[
          { icon: <Monitor className={icon} />, text: "Its own display, pointer and keyboard" },
          { icon: <Layers className={icon} />, text: "Native apps, Safari, Xcode: anything with a window" },
          { icon: <GitFork className={icon} />, text: "Use any of your computers from any other" },
        ]}
        link={{ href: `${LINKS.docs}/computer-use/overview`, label: "How private desktops work" }}
        visual={
          <>
            <Window className="absolute left-[5%] top-[7%] w-[74%]">
              <Clip src="/film/devices-mac.mp4" poster="/film/devices-mac.jpg" label="An agent opening TextEdit on its private Mac screen, shown in ADE's Mac Desktop pane" />
            </Window>
            <img
              src="/images/home/tools/slide-windows.webp"
              alt="ADE with an agent's private Windows desktop open in the Windows Desktop pane"
              width={2400}
              height={1447}
              loading="lazy"
              decoding="async"
              className="absolute bottom-[3%] right-[1%] w-[64%] drop-shadow-[0_30px_50px_rgba(0,0,0,0.7)]"
            />
          </>
        }
      />
      <Row
        tone="teal"
        kicker={{ icons: [<Users key="u" className="h-3.5 w-3.5" />], label: "Agent teams" }}
        title="One chat, a team of agents."
        body="A chat hands parts of the job to agents on other models, watches them work and reports back."
        points={[
          { icon: <Sparkles className={icon} />, text: "Mix models: one plans, a fast one writes the tests" },
          { icon: <Users className={icon} />, text: "Every subagent's progress, live in one chat" },
          { icon: <ListChecks className={icon} />, text: "One summary when they are all done" },
        ]}
        link={{ href: `${LINKS.docs}/concepts/subagents`, label: "How agent teams work" }}
        visual={
          <Window>
            <Clip src="/film/compose.mp4" poster="/film/compose-done.jpg" label="One chat in ADE splitting a job across three agents on three models, each reporting back" />
          </Window>
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
  tall,
}: {
  tone: Tone;
  kicker: { icons: ReactNode[]; label: string };
  title: string;
  body: string;
  points: Point[];
  link: { href: string; label: string };
  visual: ReactNode;
  flip?: boolean;
  tall?: boolean;
}) {
  const { field, accent } = TONES[tone];
  return (
    <div className={cn("grid items-center gap-8 lg:gap-14", flip ? "lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]" : "lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]")}>
      <div className={cn("relative overflow-hidden rounded-[18px]", tall ? "aspect-[16/12]" : "p-[5%]", flip && "lg:order-2")} style={{ background: field }}>
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.35] mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
        {tall ? visual : <div className="relative">{visual}</div>}
      </div>
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

/** A recording framed as an app window, with the shadow a window casts. */
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
