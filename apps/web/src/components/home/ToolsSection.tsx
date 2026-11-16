import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "../../lib/cn";

/*
 * What agents can do on real devices, as rows in the style of Cursor's
 * feature rows: one visual of the real app beside a white line and a grey
 * sentence, alternating sides. Every visual is a recording of ADE with a real
 * agent at work: testing the Crumb app on a folding iPhone simulator, opening
 * TextEdit on its private Mac screen, a Windows Desktop session, and one chat
 * splitting a job across three agents. Clips play only while on screen; with
 * reduced motion they show their poster.
 */

export function ToolsSection() {
  return (
    <section aria-label="What agents can do" className="mx-auto flex max-w-[1240px] flex-col gap-[clamp(56px,7vw,112px)] px-5 pt-[clamp(24px,3vw,40px)] sm:px-8">
      <Row
        title="Agents test on real phones."
        body="They run your app on an iPhone or Android simulator on any of your computers, fold it, tap through it and tell you what broke."
        visual={<Window><Clip src="/film/devices-iphone.mp4" poster="/film/devices-iphone.jpg" label="An agent in ADE testing the Crumb app on a folding iPhone simulator, folding and turning it" /></Window>}
      />
      <Row
        flip
        title="A desktop of their own."
        body="Each agent gets a private Mac or Windows screen to open apps and click around in. Yours stays free."
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
        tall
      />
      <Row
        title="One chat, a team of agents."
        body="A chat hands parts of the job to agents on other models, watches them work and reports back when they are done."
        visual={<Window><Clip src="/film/compose.mp4" poster="/film/compose-done.jpg" label="One chat in ADE splitting a job across three agents on three models, each reporting back" /></Window>}
      />
    </section>
  );
}

function Row({ title, body, visual, flip, tall }: { title: string; body: string; visual: ReactNode; flip?: boolean; tall?: boolean }) {
  return (
    <div className={cn("grid items-center gap-8 lg:gap-14", flip ? "lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]" : "lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]")}>
      <div
        className={cn(
          "relative overflow-hidden rounded-[18px] border border-white/[0.06] bg-[radial-gradient(120%_90%_at_30%_0%,#2a2146_0%,#15131f_55%,#0e0d14_100%)]",
          tall ? "aspect-[16/12]" : "p-[5%]",
          flip && "lg:order-2",
        )}
      >
        {visual}
      </div>
      <div className={cn("max-w-[30rem]", flip && "lg:order-1")}>
        <h3 className="text-[clamp(22px,2vw,28px)] font-medium leading-[1.25] tracking-[-0.02em] text-white">
          {title} <span className="text-white/50">{body}</span>
        </h3>
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
