import { useEffect, useRef, useState } from "react";
import { useMotionValueEvent, useReducedMotion, useScroll } from "framer-motion";
import { cn } from "../../lib/cn";

/*
 * One short scroll clip of the real app: a prompt that names three models is
 * typed and sent, and the lead agent starts the other two as its subagents.
 * The scroll picks the frame, so nothing plays on its own; the camera starts
 * on the composer and pulls back to the whole window once the prompt is in.
 * The film is `/film/compose.mp4` (1512×982 at 2×, 30 fps), recorded by
 * `apps/desktop/scripts/demo/encode-film.mjs`.
 */

const FPS = 30;
const FRAMES = 254;
const APP_W = 1512;
const APP_H = 982;
/** How much of the window's height the frame shows: the bottom of the finished chat is empty, so the frame stops above it. */
const VIEW_H = 780;
/** The composer, where the camera starts, in the app's own pixels. */
const START_CAM: [number, number, number, number] = [471, 254, 900, 520];
/** The camera pulls back to the whole window over these frames. */
const PULL_BACK: [number, number] = [93, 111];

const BEATS = [
  { from: 0, title: "Mention any model.", sub: "Type @ and pick any agent and model you use." },
  { from: 100, title: "Hand out the work.", sub: "Claude starts GPT-6 Luna and DeepSeek as its own subagents." },
  { from: 175, title: "They report back.", sub: "Three providers, one chat, one pull request." },
] as const;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function cameraAt(frame: number): string {
  const t = easeInOut(Math.min(1, Math.max(0, (frame - PULL_BACK[0]) / (PULL_BACK[1] - PULL_BACK[0]))));
  const [x, y, w] = START_CAM.map((value, i) => value + ([0, 0, APP_W, APP_H][i]! - value) * t) as [number, number, number, number];
  const scale = APP_W / w;
  return `scale(${scale}) translate(${(-x / APP_W) * 100}%, ${(-y / APP_H) * 100}%)`;
}

export function OrchestrateClip() {
  const reduceMotion = useReducedMotion() ?? false;
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <section aria-labelledby="orchestrate-title" className="relative">
      {wide && !reduceMotion ? <ScrubbedClip /> : <StillClip />}
    </section>
  );
}

function Heading() {
  return (
    <h2
      id="orchestrate-title"
      className="text-center font-display text-white"
      style={{ fontSize: "clamp(32px, 3.6vw, 52px)", lineHeight: 1.04, letterSpacing: "-0.04em" }}
    >
      Every model, <span className="text-white/45">one team.</span>
    </h2>
  );
}

function ScrubbedClip() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [beat, setBeat] = useState(0);
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start start", "end end"] });

  const show = (progress: number) => {
    const frame = Math.round(Math.min(1, Math.max(0, progress)) * (FRAMES - 1));
    const video = videoRef.current;
    if (video && video.readyState >= 1) video.currentTime = frame / FPS;
    if (frameRef.current) frameRef.current.style.transform = cameraAt(frame);
    let next = 0;
    BEATS.forEach((entry, i) => {
      if (frame >= entry.from) next = i;
    });
    setBeat(next);
  };
  useMotionValueEvent(scrollYProgress, "change", show);
  useEffect(() => show(scrollYProgress.get()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = BEATS[beat]!;
  return (
    <div ref={sectionRef} style={{ height: "190vh" }}>
      <div className="sticky top-0 flex h-screen flex-col items-center justify-center px-8 pt-[60px]">
        <Heading />
        <div className="mt-4 flex h-[72px] flex-col items-center text-center">
          <p key={current.title} className="ade-pop-in text-[clamp(17px,1.4vw,21px)] font-semibold text-white">
            {current.title} <span className="font-normal text-white/55">{current.sub}</span>
          </p>
          <ol className="mt-3 flex gap-1.5 text-[12.5px]" aria-label="Steps">
            {BEATS.map((entry, i) => (
              <li
                key={entry.title}
                aria-current={i === beat ? "step" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 transition-colors duration-300",
                  i === beat ? "border-white/30 bg-white/[0.08] text-white" : i < beat ? "border-white/10 text-white/55" : "border-white/[0.06] text-white/35",
                )}
              >
                {i + 1}. {entry.title.replace(/\.$/, "")}
              </li>
            ))}
          </ol>
        </div>
        <div
          className="relative mt-4 w-full max-w-[1180px] overflow-hidden rounded-[18px] border border-white/10 bg-[#0b0b10] shadow-[0_40px_120px_-20px_rgba(124,58,237,0.5)]"
          style={{ aspectRatio: `${APP_W} / ${VIEW_H}`, maxHeight: "calc(100vh - 240px)" }}
        >
          <div ref={frameRef} className="absolute inset-x-0 top-0 origin-top-left will-change-transform" style={{ aspectRatio: `${APP_W} / ${APP_H}`, transform: cameraAt(0) }}>
            <video
              ref={videoRef}
              src="/film/compose.mp4"
              poster="/film/compose.jpg"
              muted
              playsInline
              preload="auto"
              disablePictureInPicture
              aria-label="ADE: a prompt that names three models starts two of them as subagents of the first"
              className="absolute inset-0 h-full w-full bg-[#0b0b10] object-cover"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Phones, narrow windows and reduced motion: the finished chat, still, with the three beats under it. */
function StillClip() {
  return (
    <div className="mx-auto max-w-[760px] px-5 py-20">
      <Heading />
      <img
        src="/film/compose-done.jpg"
        alt="An ADE chat where Claude started GPT-6 Luna and DeepSeek as subagents, and all three reported back"
        loading="lazy"
        className="mt-8 w-full rounded-[14px] border border-white/10"
      />
      <ol className="mt-6 grid gap-3">
        {BEATS.map((entry) => (
          <li key={entry.title} className="text-[15px] text-white/60">
            <span className="font-semibold text-white">{entry.title}</span> {entry.sub}
          </li>
        ))}
      </ol>
    </div>
  );
}
