import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, useScroll, useSpring } from "framer-motion";
import { ALL_PROVIDERS, OPENCODE_PROVIDERS, ProviderMark, ProviderTile, providerById, type Provider } from "./providers";
import { useWideScreen } from "./story";
import { jumpTo, useStepScroll } from "./stepScroll";
import {
  APP,
  PAGE_UNITS,
  SCREEN_SHOTS,
  buildTimeline,
  clamp01,
  easeOut,
  markUnit,
  mixRect,
  pointerAt,
  segmentAt,
  shotCamera,
  shotEndCamera,
  shotMark,
  span,
  useFilmManifest,
  type Film,
  type FilmShot,
  type Rect,
  type Segment,
} from "./film";

/*
 * The story, as a film of the real app that the scroll plays.
 *
 *   01 Bring your own  – every provider logo sits in a ring around ADE. On
 *                        scroll the rings close in and fold into the ADE icon,
 *                        and the icon grows into the app's New Chat page. The
 *                        model picker walks its providers and shows the Custom
 *                        tab beside an equation: any harness + source + model.
 *   02 Orchestrate     – a prompt is typed through the `@` menu and sent; the
 *                        lead starts three subagents, two of them as their own
 *                        chats in the sidebar.
 *   03 Every machine   – "@Mac Studio and @Windows PC": the camera pulls back to
 *                        the three machines joined to ADE, and a chat starts on
 *                        each of the other two. Then the story ends.
 *
 * Frames come from `/film/` (see film.ts). One scroll position is one moment:
 * the page seeks the videos and moves the camera from the same number, so
 * nothing plays on its own. Resting points between the steps stop a hard
 * flick at the next step instead of letting it skip several.
 */

/* ── World layout: the app's window is (0, 0, 1512, 982) ─────────────── */

const MACBOOK: Rect = APP;
/**
 * The three machines sit on one circle around ADE: the MacBook at the bottom,
 * the Mac Studio and the Windows PC above it to either side. Nothing overlaps
 * and nothing is turned, so every screen reads.
 */
const STUDIO: Rect = [-1080, -1120, 1512, 982];
const WINDOWS: Rect = [1080, -1120, 1512, 982];
/** ADE, at the middle of the circle: every machine connects through the account. */
const HUB: [number, number] = [756, -560];
const FAN_CAM: Rect = [756 - 2150, -1225, 4300, 2300];
/** The ring of providers, around the middle of the app's window. */
const RING_CENTER: [number, number] = [756, 470];

const PX_PER_UNIT = 7;

/* ── Captions ────────────────────────────────────────────────────────── */

type Beat = { title: string; sub: string; at: (segments: Segment[]) => number };

const BEATS: Beat[] = [
  {
    title: "Every plan you already pay for.",
    sub: "Every supported agent and model provider, in one picker.",
    at: () => 0,
  },
  {
    title: "Or make your own.",
    sub: "Pair any harness with any source and any model.",
    at: (s) => markUnit(s, "start", "custom") - 8,
  },
  {
    title: "Delegate to any agent.",
    sub: "Mention any agent in a message and give it a task. Coordinate the work however you want.",
    at: (s) => markUnit(s, "compose", "start"),
  },
  {
    title: "Orchestrate all your agents.",
    sub: "Here Claude starts Codex and DeepSeek as its own subagents, and they report back to it.",
    at: (s) => markUnit(s, "compose", "sent"),
  },
  {
    title: "Work across all your machines.",
    sub: "Give a task, a new agent, or a whole chat to any of your computers.",
    at: (s) => markUnit(s, "machines", "typing") - 10,
  },
  {
    title: "Every machine, one account.",
    sub: "Your computers connect through your ADE account, so every agent can reach every machine.",
    at: (s) => segmentStart(s, "network") + 10,
  },
];

const CHAPTERS = [
  { label: "Bring your own", from: (_: Segment[]) => 0 },
  { label: "Orchestrate", from: (s: Segment[]) => markUnit(s, "compose", "start") },
  { label: "Every machine", from: (s: Segment[]) => markUnit(s, "machines", "typing") - 10 },
];

/** Where the scroll comes to rest: a hard flick stops at the next of these instead of skipping past it. */
function restingPoints(segments: Segment[]): number[] {
  const ring = segments.find((s) => s.kind === "ring");
  const points = [
    ring ? ring.start + ring.units : 0,
    markUnit(segments, "start", "custom"),
    markUnit(segments, "compose", "start"),
    markUnit(segments, "compose", "sent") + 40,
    markUnit(segments, "machines", "typing") - 10,
    segmentStart(segments, "network") + 56,
  ];
  return points.filter((point, i) => point > 0 && points.indexOf(point) === i);
}

function segmentStart(segments: Segment[], kind: Segment["kind"]): number {
  return segments.find((s) => s.kind === kind)?.start ?? 0;
}

/* ── Custom provider pairings (each one a route ADE can take) ───────── */

type Part = { id: string; name: string };
const COMBOS: Array<{ harness: Part; source: Part; model: Part; result: string }> = [
  { harness: { id: "claude", name: "Claude Code" }, source: { id: "opencode", name: "OpenCode Go" }, model: { id: "deepseek", name: "DeepSeek V4.1 Flash" }, result: "DeepSeek V4.1 Flash in Claude Code" },
  { harness: { id: "codex", name: "Codex" }, source: { id: "x-anthropic", name: "Claude plan" }, model: { id: "x-anthropic", name: "Claude Opus 5.5" }, result: "Claude Opus 5.5 in Codex" },
  { harness: { id: "droid", name: "Droid" }, source: { id: "openrouter", name: "OpenRouter key" }, model: { id: "kimi", name: "Kimi K2.7 Code" }, result: "Kimi K2.7 Code in Droid" },
  { harness: { id: "opencode", name: "OpenCode" }, source: { id: "x-openai", name: "ChatGPT plan" }, model: { id: "x-openai", name: "GPT-6 Luna" }, result: "GPT-6 Luna in OpenCode" },
];

/* ── The opening ring ────────────────────────────────────────────────── */

const ALL_CLOUD: Provider[] = [...ALL_PROVIDERS, ...OPENCODE_PROVIDERS];
/**
 * ADE's own agents and sources on the inner ring, the providers OpenCode
 * reaches on the outer one. `close` (0..1) pulls both rings in toward ADE.
 */
function ringSlot(slot: number, turn: number, close = 0): [number, number, number] {
  const inner = slot < ALL_PROVIDERS.length;
  const count = inner ? ALL_PROVIDERS.length : OPENCODE_PROVIDERS.length;
  const index = inner ? slot : slot - ALL_PROVIDERS.length;
  const angle = (index / count) * Math.PI * 2 + (inner ? -turn : turn) - Math.PI / 2;
  const [rx, ry] = inner ? [330, 262] : [560, 420];
  const r = 1 - close;
  return [RING_CENTER[0] + Math.cos(angle) * rx * r, RING_CENTER[1] + Math.sin(angle) * ry * r, inner ? 76 : 54];
}

/* ── Section ─────────────────────────────────────────────────────────── */

export function StorySection() {
  const wide = useWideScreen();
  const reduceMotion = useReducedMotion() ?? false;
  const film = useFilmManifest();
  if (!wide || reduceMotion) return <StackedStory />;
  if (!film) return <section className="h-[100vh]" aria-busy />;
  return <FilmStory film={film} />;
}

type Els = {
  stage: HTMLDivElement | null;
  world: HTMLDivElement | null;
  appWindow: HTMLDivElement | null;
  videos: Record<string, HTMLVideoElement | null>;
  posters: Record<string, HTMLImageElement | null>;
  cursor: HTMLDivElement | null;
  ripple: HTMLDivElement | null;
  logos: Array<HTMLDivElement | null>;
  hub: HTMLDivElement | null;
  diagram: HTMLDivElement | null;
  connector: SVGPathElement | null;
  bezel: HTMLDivElement | null;
  monitors: Array<HTMLDivElement | null>;
  names: HTMLDivElement | null;
  beams: SVGSVGElement | null;
  mapHub: HTMLDivElement | null;
  beamBase: Array<SVGPathElement | null>;
  chapterFills: Array<HTMLDivElement | null>;
  chapterLabels: Array<HTMLDivElement | null>;
};

function FilmStory({ film }: { film: Film }) {
  const { segments, total } = useMemo(() => buildTimeline(film), [film]);
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // A light spring: it smooths a mouse wheel's steps without lagging far behind the scroll.
  const progress = useSpring(scrollYProgress, { stiffness: 260, damping: 38, mass: 0.35 });

  const els = useRef<Els>({
    stage: null, world: null, appWindow: null, videos: {}, posters: {}, cursor: null, ripple: null, logos: [], hub: null,
    diagram: null, connector: null, bezel: null, monitors: [], names: null, beams: null, mapHub: null, beamBase: [],
    chapterFills: [], chapterLabels: [],
  }).current;
  const stageSize = useRef({ w: 1200, h: 700 });
  const [beat, setBeat] = useState(0);
  const [combo, setCombo] = useState(0);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const beatStarts = useMemo(() => BEATS.map((b) => b.at(segments)), [segments]);
  const chapterStarts = useMemo(() => CHAPTERS.map((c) => c.from(segments)), [segments]);
  const mainShots = useMemo(() => film.shots.filter((s) => !SCREEN_SHOTS.includes(s.name)), [film]);
  const screenShots = useMemo(() => Object.fromEntries(film.shots.filter((s) => SCREEN_SHOTS.includes(s.name)).map((s) => [s.name, s])) as Record<string, FilmShot>, [film]);

  // Where each segment's camera starts: where the previous one left off.
  const camStarts = useMemo(() => {
    const starts: Rect[] = [];
    let at: Rect = APP;
    for (const segment of segments) {
      starts.push(at);
      if (segment.kind === "shot") at = shotEndCamera(segment.shot, at);
      if (segment.kind === "network") at = FAN_CAM;
    }
    return starts;
  }, [segments]);

  const customRow = useMemo(() => shotMark<number[]>(film, "start", "custom", "row"), [film]);
  const diagramAt = useMemo<[number, number]>(() => {
    const picker = shotMark<number[]>(film, "start", "custom", "picker");
    return picker ? [picker[0]! + picker[2]! + 70, picker[1]! + 20] : [1000, 300];
  }, [film]);
  const customStart = markUnit(segments, "start", "custom");
  const customEnd = markUnit(segments, "start", "custom-end");
  const beams = useMemo(() => beamPaths(), []);
  const rests = useMemo(() => restingPoints(segments), [segments]);

  const restsPx = useMemo(() => rests.map((unit) => Math.round(unit * PX_PER_UNIT)), [rests]);
  useStepScroll(ref, restsPx);

  const render = useCallback(
    (p: number) => {
      const u = clamp01(p) * total;
      const { segment, local, index } = segmentAt(segments, u);
      const { w: sw, h: sh } = stageSize.current;
      const networkStart = segmentStart(segments, "network");
      const net = u < networkStart ? -1 : u - networkStart;
      const afterNet = u > networkStart + PAGE_UNITS.network;

      /* Camera */
      let cam: Rect = camStarts[index]!;
      if (segment.kind === "shot") cam = shotCamera(segment.shot, local, camStarts[index]!);
      if (segment.kind === "network") {
        cam = mixRect(camStarts[index]!, FAN_CAM, span(local, 0, 44));
      }
      const k = Math.min(sw / cam[2], sh / cam[3]) * 0.97;
      const tx = sw / 2 - (cam[0] + cam[2] / 2) * k;
      const ty = sh / 2 - (cam[1] + cam[3] / 2) * k;
      if (els.world) els.world.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${k})`;

      /* The app: which shot shows, at which frame */
      const shotSegments = segments.filter((s): s is Extract<Segment, { kind: "shot" }> => s.kind === "shot");
      let active = shotSegments[0]!;
      let frame = 0;
      if (segment.kind === "shot") {
        active = segment;
        frame = Math.min(segment.shot.frames - 1, local);
      } else if (segment.start > shotSegments[0]!.start) {
        // A page segment holds the last frame of the shot before it.
        active = shotSegments.filter((s) => s.start < segment.start).pop() ?? shotSegments[0]!;
        frame = active.shot.frames - 1;
      }
      for (const s of shotSegments) {
        const video = els.videos[s.shot.name];
        const poster = els.posters[s.shot.name];
        const on = s === active;
        if (video) {
          video.style.opacity = on ? "1" : "0";
          if (on) seek(video, frame, film.fps);
        }
        if (poster) poster.style.opacity = on && !video?.dataset.ready ? "1" : "0";
      }
      // The other machines' screens play the chats the MacBook started there.
      for (const name of SCREEN_SHOTS) {
        const shot = screenShots[name];
        const video = els.videos[name];
        if (!shot || !video) continue;
        const t = afterNet ? 1 : net < 0 ? 0 : span(net, 18, 54);
        seek(video, t * (shot.frames - 1), film.fps);
      }

      /* Pointer */
      if (els.cursor && els.ripple) {
        if (segment.kind === "shot") {
          const ptr = pointerAt(segment.shot, local);
          const s = 1 / k;
          els.cursor.style.opacity = ptr.visible ? "1" : "0";
          els.cursor.style.transform = `translate3d(${ptr.x}px, ${ptr.y}px, 0) scale(${s})`;
          const click = ptr.click >= 0 && ptr.click <= 1 ? ptr.click : -1;
          els.ripple.style.opacity = click >= 0 ? String(0.7 * (1 - click)) : "0";
          els.ripple.style.transform = `translate3d(${ptr.x}px, ${ptr.y}px, 0) scale(${s * (0.4 + click * 1.4)})`;
        } else {
          els.cursor.style.opacity = "0";
          els.ripple.style.opacity = "0";
        }
      }

      /* The ring: the rings close in on ADE, fold into the icon, and the icon
         grows into the app's window. Every scroll step moves something. */
      const ringLocal = segment.kind === "ring" ? local : 999;
      const close = easeOut(clamp01(ringLocal / 46)) * 0.55;
      const turn = Math.min(ringLocal, 70) * 0.018;
      const grow = span(ringLocal, 58, 92);
      if (els.appWindow) {
        const scale = 0.11 + 0.89 * grow;
        els.appWindow.style.opacity = String(span(ringLocal, 56, 64));
        els.appWindow.style.transform = `scale(${scale})`;
        els.appWindow.style.borderRadius = `${14 + (1 - grow) * 120}px`;
      }
      if (els.hub) {
        // The icon grows with the window that comes out of it, and fades as it does.
        const pulse = 1 + 0.12 * span(ringLocal, 20, 52) - 0.12 * span(ringLocal, 52, 58);
        const withWindow = (0.11 + 0.89 * grow) / 0.11;
        els.hub.style.opacity = String(1 - span(ringLocal, 57, 66));
        els.hub.style.transform = `translate3d(${RING_CENTER[0]}px, ${RING_CENTER[1]}px, 0) translate(-50%, -50%) scale(${pulse * withWindow})`;
      }
      els.logos.forEach((el, i) => {
        if (!el) return;
        const delay = (i % 10) * 0.8;
        const fold = easeOut(clamp01((ringLocal - 40 - delay) / 16));
        const [x, y, size] = ringSlot(i, turn, close + (1 - close) * fold);
        const scale = 1 - 0.75 * fold;
        el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
        el.style.opacity = String(fold >= 1 ? 0 : 1 - clamp01((fold - 0.6) / 0.4));
        void size;
      });

      /* The custom provider equation, beside the picker's Custom tab */
      if (els.diagram) {
        const inT = span(u, customStart - 6, customStart + 4);
        const outT = span(u, customEnd - 1, customEnd + 4);
        const t = inT * (1 - outT);
        els.diagram.style.opacity = String(t);
        els.diagram.style.transform = `translate3d(${diagramAt[0] + (1 - inT) * 40}px, ${diagramAt[1]}px, 0)`;
        if (els.connector) {
          els.connector.style.opacity = String(t);
          els.connector.style.strokeDashoffset = String(1 - span(u, customStart, customStart + 8));
        }
        const next = Math.min(COMBOS.length - 1, Math.max(0, Math.floor(((u - customStart) / Math.max(1, customEnd - customStart)) * COMBOS.length)));
        setCombo((current) => (current === next ? current : next));
      }

      /* Machines */
      const machineIn = span(net, 6, 36);
      if (els.bezel) els.bezel.style.opacity = String(machineIn);
      if (els.names) els.names.style.opacity = String(machineIn);
      if (els.beams) els.beams.style.opacity = String(machineIn);
      els.monitors.forEach((el, i) => {
        if (!el) return;
        const t = span(net, 6 + i * 6, 36 + i * 6);
        el.style.opacity = String(t);
        el.style.transform = `translate3d(0, ${(1 - easeOut(t)) * 120}px, 0)`;
      });
      if (els.mapHub) {
        const t = span(net, 14, 34);
        els.mapHub.style.opacity = String(t);
        els.mapHub.style.transform = `translate(-50%, -50%) scale(${0.6 + 0.4 * easeOut(t)})`;
      }
      els.beamBase.forEach((path) => {
        if (path) path.style.strokeDashoffset = String(1 - span(net, 16, 34));
      });

      /* Captions and chapters */
      let nextBeat = 0;
      beatStarts.forEach((start, i) => {
        if (u >= start) nextBeat = i;
      });
      setBeat((current) => (current === nextBeat ? current : nextBeat));
      chapterStarts.forEach((start, i) => {
        const end = chapterStarts[i + 1] ?? total;
        const fill = clamp01((u - start) / (end - start));
        const fillEl = els.chapterFills[i];
        if (fillEl) fillEl.style.transform = `scaleX(${fill})`;
        const label = els.chapterLabels[i];
        if (label) label.style.opacity = u >= start && (u < end || i === chapterStarts.length - 1) ? "1" : "0.42";
      });
    },
    [beatStarts, camStarts, chapterStarts, customEnd, customStart, diagramAt, els, film.fps, screenShots, segments, total],
  );

  // One render per scroll change, and again when the stage resizes or a video becomes ready.
  useEffect(() => progress.on("change", render), [progress, render]);
  useLayoutEffect(() => {
    const stage = els.stage;
    if (!stage) return;
    const fit = () => {
      stageSize.current = { w: stage.clientWidth, h: stage.clientHeight };
      render(progress.get());
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [els, progress, render]);
  useEffect(() => render(progress.get()), [ready, progress, render]);

  // The videos load whole, as blobs, once the section is near, so seeking never waits on the network.
  useEffect(() => {
    const section = ref.current;
    if (!section) return;
    let started = false;
    const urls: string[] = [];
    const start = () => {
      if (started) return;
      started = true;
      for (const shot of film.shots) {
        fetch(`/film/${shot.name}.mp4`)
          .then((response) => response.blob())
          .then((blob) => {
            const video = els.videos[shot.name];
            if (!video) return;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            video.addEventListener("loadeddata", () => {
              video.dataset.ready = "1";
              setReady((current) => ({ ...current, [shot.name]: true }));
            }, { once: true });
            video.src = url;
          })
          .catch(() => {});
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) start();
    }, { rootMargin: "150% 0px" });
    observer.observe(section);
    return () => {
      observer.disconnect();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [els, film.shots]);

  const b = BEATS[beat]!;
  return (
    <section ref={ref} data-story="story" className="relative" style={{ height: `calc(${Math.round(total * PX_PER_UNIT)}px + 100vh)` }}>

      <div className="sticky top-0 flex h-screen flex-col items-center overflow-hidden pt-[68px]">
        <div className="flex items-center gap-6">
          {CHAPTERS.map((chapter, i) => (
            <button
              type="button"
              key={chapter.label}
              ref={(el) => { els.chapterLabels[i] = el as unknown as HTMLDivElement; }}
              onClick={() => {
                const section = ref.current;
                if (!section) return;
                const top = section.getBoundingClientRect().top + window.scrollY;
                jumpTo(top + Math.round(chapterStarts[i]! * PX_PER_UNIT) + (i === 0 ? 0 : 4));
              }}
              className="flex w-[150px] cursor-pointer flex-col gap-2 text-left transition-opacity duration-300 hover:!opacity-100"
            >
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-white/70">
                <span className="text-[color:var(--color-violet-bright)]">0{i + 1}</span> {chapter.label}
              </div>
              <div className="h-px overflow-hidden bg-white/10">
                <div ref={(el) => { els.chapterFills[i] = el; }} className="h-full origin-left bg-[color:var(--color-violet-bright)]" style={{ transform: "scaleX(0)" }} />
              </div>
            </button>
          ))}
        </div>

        <div className="relative mt-7 h-[clamp(74px,9.5vh,96px)] w-full max-w-[980px] text-center">
          <AnimatePresence initial={false}>
            <motion.div
              key={beat}
              className="absolute inset-x-0 top-0"
              initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <h2 className="font-serif font-normal text-white" style={{ fontSize: "clamp(28px, 3vw, 44px)", lineHeight: 1.04, letterSpacing: "-0.02em" }}>
                {b.title}
              </h2>
              <p className="mx-auto mt-1.5 max-w-[720px] text-[clamp(13px,0.95vw,15px)] leading-[1.5] text-white/55">{b.sub}</p>
            </motion.div>
          </AnimatePresence>
        </div>

        <div ref={(el) => { els.stage = el; }} className="relative mb-3 w-[min(97vw,1560px)] flex-1 overflow-hidden rounded-[18px]">
          <div ref={(el) => { els.world = el; }} className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ width: APP[2], height: APP[3] }}>
            <MachineMap els={els} beams={beams} />

            {/* The app's own window: the film. */}
            <div
              ref={(el) => { els.appWindow = el; }}
              className="absolute z-20 overflow-hidden rounded-[14px] bg-[#0b0b10] shadow-[0_0_0_1.5px_rgba(255,255,255,0.1),0_40px_120px_rgba(0,0,0,0.6),0_0_90px_rgba(124,58,237,0.16)]"
              style={{ left: 0, top: 0, width: APP[2], height: APP[3], opacity: 0, transformOrigin: `${RING_CENTER[0]}px ${RING_CENTER[1]}px` }}
            >
              {mainShots.map((shot) => (
                <img key={`poster-${shot.name}`} ref={(el) => { els.posters[shot.name] = el; }} src={`/film/${shot.name}.jpg`} alt="" aria-hidden className="absolute inset-0 h-full w-full" style={{ opacity: 0 }} />
              ))}
              {mainShots.map((shot) => (
                <video key={shot.name} ref={(el) => { els.videos[shot.name] = el; }} muted playsInline preload="auto" disablePictureInPicture aria-label={`ADE: ${shot.name}`} className="absolute inset-0 h-full w-full" style={{ opacity: 0 }} />
              ))}
            </div>

            {/* The ring: ADE in the middle, every provider around it */}
            <div ref={(el) => { els.hub = el; }} className="pointer-events-none absolute left-0 top-0 z-30" style={{ transform: `translate3d(${RING_CENTER[0]}px, ${RING_CENTER[1]}px, 0) translate(-50%, -50%)` }}>
              <div className="relative grid place-items-center">
                <div className="absolute h-[520px] w-[520px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(124,58,237,0.45), rgba(124,58,237,0.08) 60%, transparent)" }} />
                <img src="/images/home/ade-icon.png" alt="ADE" className="relative h-[170px] w-[170px] drop-shadow-[0_20px_60px_rgba(124,58,237,0.6)]" />
              </div>
            </div>
            {ALL_CLOUD.map((provider, i) => (
              <div key={provider.id} ref={(el) => { els.logos[i] = el; }} className="pointer-events-none absolute left-0 top-0 z-30" style={{ transform: `translate3d(${ringSlot(i, 0)[0]}px, ${ringSlot(i, 0)[1]}px, 0)` }}>
                <div className="-translate-x-1/2 -translate-y-1/2">
                  <ProviderTile provider={provider} size={ringSlot(i, 0)[2]} />
                </div>
              </div>
            ))}

            {/* The custom provider equation */}
            {customRow ? (
              <svg className="pointer-events-none absolute left-0 top-0 z-30 overflow-visible" width={1} height={1}>
                <path
                  ref={(el) => { els.connector = el; }}
                  d={`M ${customRow[0]! + customRow[2]! - 30} ${customRow[1]! + customRow[3]! / 2} C ${diagramAt[0] - 40} ${customRow[1]! + customRow[3]! / 2}, ${diagramAt[0] - 50} ${diagramAt[1] + 330}, ${diagramAt[0]} ${diagramAt[1] + 330}`}
                  pathLength={1}
                  fill="none"
                  stroke="url(#ade-connector)"
                  strokeWidth={2.5}
                  strokeDasharray="1"
                  style={{ strokeDashoffset: 1, opacity: 0 }}
                />
                <defs>
                  <linearGradient id="ade-connector" x1="0" x2="1">
                    <stop offset="0" stopColor="#c4b5fd" stopOpacity="0.2" />
                    <stop offset="1" stopColor="#c4b5fd" stopOpacity="0.9" />
                  </linearGradient>
                </defs>
              </svg>
            ) : null}
            <div ref={(el) => { els.diagram = el; }} className="pointer-events-none absolute left-0 top-0 z-30 w-[560px]" style={{ opacity: 0 }}>
              <ProviderEquation combo={combo} />
            </div>

            {/* Pointer and its click */}
            <div ref={(el) => { els.ripple = el; }} className="pointer-events-none absolute left-0 top-0 z-40" style={{ opacity: 0 }}>
              <div className="h-[44px] w-[44px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[rgba(196,181,253,0.95)]" />
            </div>
            <div ref={(el) => { els.cursor = el; }} className="pointer-events-none absolute left-0 top-0 z-40 origin-top-left" style={{ opacity: 0 }}>
              <PointerGlyph />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Asks the video for a frame, at most one seek at a time; the newest request wins. */
function seek(video: HTMLVideoElement, frame: number, fps: number) {
  const target = (Math.round(frame) + 0.3) / fps;
  video.dataset.target = String(target);
  if (!video.dataset.ready) return;
  if (video.seeking) {
    if (!video.dataset.pump) {
      video.dataset.pump = "1";
      video.addEventListener("seeked", () => {
        delete video.dataset.pump;
        const next = Number(video.dataset.target);
        if (Math.abs(video.currentTime - next) > 0.4 / fps) video.currentTime = next;
      }, { once: true });
    }
    return;
  }
  if (Math.abs(video.currentTime - target) > 0.4 / fps) video.currentTime = target;
}

function PointerGlyph() {
  return (
    <svg width="26" height="30" viewBox="0 0 26 30" className="drop-shadow-[0_3px_6px_rgba(0,0,0,0.55)]">
      <path d="M3 2 L3 24 L8.6 18.8 L12.4 27.6 L16.2 26 L12.5 17.4 L20.5 17.2 Z" fill="#0b0b10" stroke="white" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

/* ── The custom provider equation: harness + source + model = provider ─ */

function ProviderEquation({ combo }: { combo: number }) {
  const c = COMBOS[combo]!;
  return (
    <div className="rounded-[22px] border border-white/12 bg-[#100e17]/94 px-7 pb-7 pt-6 shadow-[0_30px_90px_rgba(0,0,0,0.6),0_0_70px_rgba(124,58,237,0.2)] backdrop-blur">
      <div className="text-center font-mono text-[12.5px] uppercase tracking-[0.2em] text-[color:var(--color-violet-bright)]">
        Any harness · any source · any model
      </div>
      <div className="mt-6 flex items-start justify-between">
        <Slot label="Harness" part={c.harness} combo={combo} order={0} />
        <Operator>+</Operator>
        <Slot label="Source" part={c.source} combo={combo} order={1} />
        <Operator>+</Operator>
        <Slot label="Model" part={c.model} combo={combo} order={2} />
      </div>
      <div className="my-5 flex items-center gap-4">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/25" />
        <span className="text-[26px] leading-none text-white/45">=</span>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/25" />
      </div>
      <div className="relative h-[64px] overflow-hidden">
        <AnimatePresence initial={false}>
          <motion.div
            key={combo}
            initial={{ y: 70, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -70, opacity: 0 }}
            transition={{ duration: 0.45, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 flex items-center gap-3 rounded-[14px] border border-[color:var(--color-violet-bright)]/45 bg-[color:var(--color-violet-bright)]/[0.1] px-4"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/[0.08]">
              <ProviderMark provider={providerById(c.model.id)} className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[19px] font-medium text-white">{c.result}</span>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** One part of the equation: a logo that rolls to the next pairing, with its name under it. */
function Slot({ label, part, combo, order }: { label: string; part: Part; combo: number; order: number }) {
  return (
    <div className="flex w-[136px] flex-col items-center">
      <div className="font-mono text-[11.5px] uppercase tracking-[0.18em] text-white/40">{label}</div>
      <div className="relative mt-3 h-[96px] w-[96px] overflow-hidden rounded-[26px] border border-white/12 bg-[#191722] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
        <AnimatePresence initial={false}>
          <motion.div
            key={combo}
            initial={{ y: 96 }}
            animate={{ y: 0 }}
            exit={{ y: -96 }}
            transition={{ duration: 0.5, delay: order * 0.07, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 grid place-items-center"
          >
            <ProviderMark provider={providerById(part.id)} className="h-12 w-12" />
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="relative mt-3 h-[22px] w-full overflow-hidden text-center">
        <AnimatePresence initial={false}>
          <motion.div
            key={combo}
            initial={{ y: 22, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -22, opacity: 0 }}
            transition={{ duration: 0.4, delay: order * 0.07 }}
            className="absolute inset-0 truncate text-[15px] text-white/80"
          >
            {part.name}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Operator({ children }: { children: ReactNode }) {
  return <div className="mt-[62px] text-[26px] leading-none text-white/35">{children}</div>;
}

/* ── The machines ────────────────────────────────────────────────────── */

type Beam = { d: string };

/** Where each name sits: on the top edge of its screen. The links leave from the MacBook's. */
const NAME_Y = { top: STUDIO[1] - 30, macbook: -34 };

/** One link from the MacBook up through ADE to each of the other two machines. */
function beamPaths(): Beam[] {
  const sy = NAME_Y.macbook - 44;
  const y = STUDIO[1] + STUDIO[3] / 2;
  const link = (ex: number, cx: number) => `M ${HUB[0]} ${sy} C ${HUB[0]} ${y - 10}, ${cx} ${y}, ${ex} ${y}`;
  return [
    { d: link(STUDIO[0] + STUDIO[2] + 46, HUB[0] - 136) },
    { d: link(WINDOWS[0] - 46, HUB[0] + 136) },
  ];
}

function MachineMap({ els, beams }: { els: Els; beams: Beam[] }) {
  return (
    <>
      {/* The links: each machine joins ADE */}
      <svg ref={(el) => { els.beams = el; }} className="pointer-events-none absolute z-10 overflow-visible" style={{ left: 0, top: 0, opacity: 0 }} width={1} height={1}>
        <defs>
          <linearGradient id="ade-beam" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#c4b5fd" />
            <stop offset="1" stopColor="#67e8f9" />
          </linearGradient>
        </defs>
        {beams.map((beam, i) => (
          <g key={i}>
            <path ref={(el) => { els.beamBase[i] = el; }} d={beam.d} pathLength={1} strokeDasharray="1" fill="none" stroke="rgba(196,181,253,0.55)" strokeWidth={4} strokeLinecap="round" style={{ strokeDashoffset: 1 }} />
          </g>
        ))}
      </svg>

      {/* ADE, in the middle of the circle */}
      <div ref={(el) => { els.mapHub = el; }} className="pointer-events-none absolute z-[12]" style={{ left: HUB[0], top: HUB[1], opacity: 0 }}>
        <div className="relative grid place-items-center">
          <div className="absolute h-[620px] w-[620px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(124,58,237,0.5), rgba(124,58,237,0.1) 55%, transparent)" }} />
          <img src="/images/home/ade-icon.png" alt="" aria-hidden className="relative h-[230px] w-[230px] drop-shadow-[0_24px_70px_rgba(124,58,237,0.7)]" />
        </div>
      </div>

      <SideMachine index={0} rect={STUDIO} shot="studio" name="Mac Studio" els={els} kind="studio" />
      <SideMachine index={1} rect={WINDOWS} shot="windows" name="Windows PC" els={els} kind="windows" />

      {/* The MacBook around the app's window */}
      <div ref={(el) => { els.bezel = el; }} className="pointer-events-none absolute left-0 top-0 z-[15]" style={{ opacity: 0 }}>
        <div className="absolute rounded-[40px] border-[3px] border-white/10 bg-[#07070a]" style={{ left: -34, top: -34, width: MACBOOK[2] + 68, height: MACBOOK[3] + 68 }} />
        <div className="absolute rounded-b-[30px] bg-gradient-to-b from-[#c9ccd2] via-[#9a9ea6] to-[#5c6068]" style={{ left: -170, top: MACBOOK[3] + 34, width: MACBOOK[2] + 340, height: 40 }} />
        <div className="absolute rounded-b-[12px] bg-[#4a4d54]" style={{ left: MACBOOK[2] / 2 - 120, top: MACBOOK[3] + 34, width: 240, height: 12 }} />
      </div>

      <div ref={(el) => { els.names = el; }} className="pointer-events-none absolute left-0 top-0 z-[25]" style={{ opacity: 0 }}>
        <MachineName x={MACBOOK[0] + MACBOOK[2] / 2} y={NAME_Y.macbook} name="MacBook Pro" />
        <div className="absolute left-0 top-0">
          <TrafficLights />
        </div>
      </div>
    </>
  );
}

/**
 * One of the other machines, facing front. The Mac Studio is a silver Studio
 * Display with the Mac Studio box beside its foot; the Windows PC is a black
 * monitor with a tower. Each screen plays the chat the MacBook started there.
 */
function SideMachine({ index, rect, shot, name, els, kind }: { index: number; rect: Rect; shot: string; name: string; els: Els; kind: "studio" | "windows" }) {
  const mac = kind === "studio";
  const [w, h] = [rect[2], rect[3]];
  return (
    <div
      ref={(el) => { els.monitors[index] = el; }}
      className="pointer-events-none absolute"
      style={{ left: rect[0], top: rect[1], width: w, height: h, opacity: 0, zIndex: 14 }}
    >
      {mac ? (
        <>
          {/* Studio Display: aluminium frame, thin black border, silver stand */}
          <div className="absolute rounded-[34px] bg-gradient-to-b from-[#e3e5e9] via-[#c3c6cc] to-[#9da1a8] shadow-[0_60px_150px_rgba(0,0,0,0.7)]" style={{ inset: -30 }} />
          <div className="absolute rounded-[24px] bg-[#050506]" style={{ inset: -14 }} />
          <div className="absolute left-1/2 -translate-x-1/2 bg-gradient-to-b from-[#b9bcc2] to-[#8d9198]" style={{ top: h + 30, width: 240, height: 150, clipPath: "polygon(12% 0, 88% 0, 100% 100%, 0 100%)" }} />
          <div className="absolute left-1/2 -translate-x-1/2 rounded-[10px] bg-gradient-to-b from-[#d4d6db] to-[#9b9fa6]" style={{ top: h + 176, width: 400, height: 22 }} />
          {/* Mac Studio */}
          <div className="absolute rounded-[26px] bg-gradient-to-b from-[#e2e4e8] to-[#a8acb3] shadow-[0_30px_70px_rgba(0,0,0,0.6)]" style={{ left: 40, top: h + 58, width: 280, height: 140 }}>
            <div className="absolute bottom-[22px] left-[34px] flex gap-[14px]">
              <span className="h-[10px] w-[26px] rounded-full bg-[#6b6f76]" />
              <span className="h-[10px] w-[26px] rounded-full bg-[#6b6f76]" />
              <span className="h-[16px] w-[8px] rounded-[3px] bg-[#6b6f76]" />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* A black monitor with a chin, on a V stand */}
          <div className="absolute rounded-[16px] bg-[#0d0d10] shadow-[0_60px_150px_rgba(0,0,0,0.75)] ring-2 ring-white/[0.08]" style={{ left: -16, top: -16, right: -16, bottom: -54 }} />
          <div className="absolute left-1/2 h-[6px] w-[60px] -translate-x-1/2 rounded-full bg-white/[0.12]" style={{ top: h + 18 }} />
          <div className="absolute left-1/2 -translate-x-1/2 bg-gradient-to-b from-[#26262c] to-[#141418]" style={{ top: h + 54, width: 90, height: 120 }} />
          <div className="absolute left-1/2 -translate-x-1/2 bg-[#1b1b20]" style={{ top: h + 166, width: 440, height: 20, clipPath: "polygon(6% 0, 94% 0, 100% 100%, 0 100%)" }} />
          {/* The tower */}
          <div className="absolute rounded-[14px] bg-gradient-to-b from-[#1d1d23] to-[#0f0f13] shadow-[0_40px_100px_rgba(0,0,0,0.7)] ring-2 ring-white/[0.08]" style={{ left: w + 56, top: h - 440, width: 210, height: 626 }}>
            <div className="absolute inset-y-[40px] left-[24px] w-[8px] rounded-full bg-gradient-to-b from-[#22d3ee] via-[#8b5cf6] to-[#22d3ee] shadow-[0_0_30px_rgba(34,211,238,0.7)]" />
            <div className="absolute right-[24px] top-[36px] h-[16px] w-[16px] rounded-full bg-white/20" />
            <div className="absolute bottom-[40px] left-[56px] right-[24px] top-[86px] rounded-[8px] opacity-40" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.35) 1.5px, transparent 1.5px)", backgroundSize: "14px 14px" }} />
          </div>
        </>
      )}
      <div className="absolute inset-0 overflow-hidden rounded-[6px] bg-[#0b0b10]">
        <img src={`/film/${shot}.jpg`} alt="" aria-hidden className="absolute inset-0 h-full w-full" loading="lazy" />
        <video ref={(el) => { els.videos[shot] = el; }} muted playsInline preload="auto" disablePictureInPicture aria-label={`ADE on the ${name}`} className="absolute inset-0 h-full w-full" />
        {mac ? <TrafficLights /> : null}
      </div>
      <MachineName x={w / 2} y={mac ? -30 : -16} name={name} />
    </div>
  );
}

/** macOS window buttons, in the space ADE leaves for them at the left of its top bar. */
function TrafficLights() {
  return (
    <div className="absolute left-[18px] top-[13px] flex gap-[8px]">
      <span className="h-[12px] w-[12px] rounded-full bg-[#ff5f57]" />
      <span className="h-[12px] w-[12px] rounded-full bg-[#febc2e]" />
      <span className="h-[12px] w-[12px] rounded-full bg-[#28c840]" />
    </div>
  );
}

/** A machine's name, in a pill on the top edge of its screen. */
function MachineName({ x, y, name }: { x: number; y: number; name: string }) {
  return (
    <div className="absolute z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border-[3px] border-white/15 bg-[#121118] px-[44px] py-[14px] text-[54px] font-medium leading-none tracking-[-0.01em] text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]" style={{ left: x, top: y }}>
      {name}
    </div>
  );
}

/* ── Phones, narrow windows and reduced motion: the same story, stacked ─ */

function StackedStory() {
  const items: Array<{ chapter: number; beat: number; src: string; alt: string }> = [
    { chapter: 0, beat: 1, src: "/film/start-custom.jpg", alt: "ADE's model picker with a custom provider" },
    { chapter: 1, beat: 2, src: "/film/compose-typed.jpg", alt: "A prompt in ADE that names three models" },
    { chapter: 1, beat: 3, src: "/film/compose-done.jpg", alt: "Three subagents on three providers in an ADE chat" },
    { chapter: 2, beat: 4, src: "/film/machines-typed.jpg", alt: "A message in ADE that names two other machines" },
  ];
  return (
    <section className="mx-auto grid max-w-[760px] gap-14 px-5 py-20">
      <div>
        <Kicker index={0} />
        <Title beat={BEATS[0]!} />
        <div className="mt-6 flex flex-wrap gap-2">
          {ALL_CLOUD.map((p) => (
            <ProviderTile key={p.id} provider={p} size={34} />
          ))}
        </div>
      </div>
      {items.map((item) => (
        <div key={item.src}>
          <Kicker index={item.chapter} />
          <Title beat={BEATS[item.beat]!} />
          <img src={item.src} alt={item.alt} loading="lazy" className="mt-6 w-full rounded-[12px] border border-white/10" />
        </div>
      ))}
    </section>
  );
}

function Kicker({ index }: { index: number }) {
  return (
    <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-violet-bright)]">
      0{index + 1} · {CHAPTERS[index]!.label}
    </div>
  );
}

function Title({ beat }: { beat: Beat }) {
  return (
    <>
      <h2 className="mt-3 font-serif text-[34px] leading-[1.05] text-white">{beat.title}</h2>
      <p className="mt-3 text-[15px] leading-[1.55] text-white/55">{beat.sub}</p>
    </>
  );
}
