import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { ArrowUpRight, BookOpen, Github, Smartphone, Terminal } from "lucide-react";
import { LINKS } from "../../lib/links";
import { MAC_INSTALL_COMMAND, WINDOWS_INSTALL_COMMAND } from "../../lib/installTargets";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
} from "../../lib/marketingAnalytics";
import { CopyButton } from "../CopyButton";
import { cn } from "../../lib/cn";
import { CompetitorEquation } from "../editorial/CompetitorEquation";
import { useInstallDialog } from "../install/InstallDialogProvider";
import { AppleMark, WindowsMark } from "./marks";
import { guessPlatform } from "./SiteNav";
import { LiveDemo } from "./LiveDemo";

const secondaryButton =
  "inline-flex h-11 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-5 text-[14px] font-medium text-white/85 transition-all hover:-translate-y-px hover:border-white/35 hover:bg-white/[0.08] hover:text-white";

const quietLink =
  "inline-flex items-center gap-1 text-white/55 underline decoration-white/15 underline-offset-4 transition-colors hover:text-white";

export function Hero() {
  return (
    <section className="relative overflow-x-clip">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(167,139,250,0.16) 0%, transparent 70%)",
            "radial-gradient(ellipse 70% 45% at 50% 72%, rgba(124,58,237,0.32) 0%, transparent 70%)",
            "radial-gradient(ellipse 35% 30% at 8% 30%, rgba(124,58,237,0.10) 0%, transparent 70%)",
            "radial-gradient(ellipse 35% 30% at 92% 40%, rgba(56,189,248,0.06) 0%, transparent 70%)",
          ].join(", "),
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.8) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "linear-gradient(to bottom, black 0%, black 55%, transparent 100%)",
        }}
      />

      <div className="relative mx-auto flex max-w-[1240px] flex-col items-center px-5 pt-[clamp(28px,4vw,52px)] text-center sm:px-8">
        <div className="ade-rise">
          <CompetitorEquation />
        </div>

        <h1
          className="ade-rise mt-[clamp(14px,2vw,24px)] font-serif font-normal text-white"
          style={{
            animationDelay: "60ms",
            fontSize: "clamp(44px, 6vw, 88px)",
            lineHeight: 1.0,
            letterSpacing: "-0.02em",
          }}
        >
          <em className="italic text-[color:var(--color-violet-bright)]">Every</em> AI coding tool.
          <br />
          <em className="italic text-[color:var(--color-violet-bright)]">One</em> app that runs{" "}
          <span className="ade-rainbow-text">everywhere</span>.
        </h1>

        <p
          className="ade-rise mt-5 max-w-[600px] text-[clamp(15px,1.2vw,17px)] leading-[1.55] text-white/65"
          style={{ animationDelay: "120ms" }}
        >
          One agentic development environment, synced across every machine you own. Desktop, web,
          and iPhone. Bring your own models.
        </p>

        <InstallBlock position={MARKETING_CTA_POSITIONS.HERO} animated />
      </div>

      <HeroDevices />
    </section>
  );
}

/** The download buttons, the install command, and the quiet links under them. */
export function InstallBlock({ position, animated }: { position: string; animated?: boolean }) {
  const { openInstall } = useInstallDialog();
  const windows = guessPlatform() === "windows";
  const installCommand = windows ? WINDOWS_INSTALL_COMMAND : MAC_INSTALL_COMMAND;
  return (
    <>
        <div
          className={cn(animated && "ade-rise", "mt-8 flex flex-wrap items-center justify-center gap-3")}
          style={animated ? { animationDelay: "180ms" } : undefined}
        >
          <button
            type="button"
            onClick={() => openInstall("mac")}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_MAC}
            data-ade-analytics-position={position}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-6 text-[14px] font-medium text-black shadow-[0_8px_40px_rgba(167,139,250,0.35)] transition-all hover:-translate-y-px hover:bg-white/90"
          >
            <AppleMark className="h-4 w-4" /> Download for Mac
          </button>
          <button
            type="button"
            onClick={() => openInstall("windows")}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS}
            data-ade-analytics-position={position}
            title="Windows 10/11 x64. Per-user installer, no administrator rights."
            className={secondaryButton}
          >
            <WindowsMark className="h-[14px] w-[14px]" /> Windows
          </button>
          <a
            href={LINKS.testflight}
            target="_blank"
            rel="noreferrer"
            data-ade-analytics-feature={MARKETING_FEATURES.DOWNLOAD_IOS}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_IOS}
            data-ade-analytics-position={position}
            className={secondaryButton}
          >
            <Smartphone className="h-4 w-4" /> iPhone
          </a>
        </div>

        <div
          className={cn(animated && "ade-rise", "mx-auto mt-5 flex w-fit max-w-full items-center gap-1 rounded-full border border-white/10 bg-black/40 py-1 pl-4 pr-1 font-mono text-[12.5px] text-white/70 backdrop-blur")}
          style={animated ? { animationDelay: "220ms" } : undefined}
        >
          <span className="select-none text-[color:var(--color-violet-bright)]">{windows ? ">" : "$"}</span>
          <code className="truncate px-1.5">{installCommand}</code>
          <CopyButton
            value={installCommand}
            compact
            label="Copy the install command"
            analyticsFeature={
              windows ? MARKETING_FEATURES.COPY_INSTALL_COMMAND_WINDOWS : MARKETING_FEATURES.COPY_INSTALL_COMMAND_MAC
            }
            className="h-7 w-7 justify-center rounded-full border-0 bg-transparent px-0 text-white/50 hover:bg-white/10 hover:text-white [&_svg]:h-3.5 [&_svg]:w-3.5"
          />
        </div>

        <p
          className={cn(animated && "ade-rise", "mt-4 flex flex-wrap items-center justify-center gap-x-2.5 text-[13px] text-white/30")}
          style={animated ? { animationDelay: "260ms" } : undefined}
        >
          <button type="button" onClick={() => openInstall("linux")} className={quietLink}>
            <Terminal className="h-3.5 w-3.5" aria-hidden /> Linux
          </button>
          <span aria-hidden>·</span>
          <a
            href={LINKS.github}
            target="_blank"
            rel="noreferrer"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_GITHUB}
            className={quietLink}
          >
            <Github className="h-3.5 w-3.5" /> GitHub
          </a>
          <span aria-hidden>·</span>
          <a
            href={LINKS.docs}
            target="_blank"
            rel="noreferrer"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOCS}
            className={quietLink}
          >
            <BookOpen className="h-3.5 w-3.5" /> Docs <ArrowUpRight className="h-3 w-3" />
          </a>
        </p>
    </>
  );
}

/**
 * One chat, two screens: the Mac app and the iPhone app, captured at the
 * same moment. The group starts tilted back and settles flat as it scrolls
 * into view; the phone drifts in from the side, ends straight, and then
 * floats. Every size is a percentage of one container, so the overlap holds
 * at every width.
 */
function HeroDevices() {
  const reduceMotion = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "start 25%"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [reduceMotion ? 0 : 22, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [reduceMotion ? 1 : 0.9, 1]);
  const phoneX = useTransform(scrollYProgress, [0, 1], [reduceMotion ? "0%" : "14%", "0%"]);
  // The phone starts tilted and ends exactly straight once the group is in view.
  const phoneRotate = useTransform(scrollYProgress, [0, 1], [reduceMotion ? 0 : 7, 0]);

  return (
    <figure
      ref={ref}
      className="relative mx-auto mt-[clamp(40px,5vw,72px)] max-w-[1640px] px-4 sm:px-8"
      style={{ perspective: "1800px" }}
    >
      <motion.div className="relative pb-[8%]" style={{ rotateX, scale, transformOrigin: "50% 0%" }}>
        {/* Desktop: the real app, live. The Mac screenshot shows until it loads. */}
        <div className="relative mx-auto w-[86%]">
          <LiveDemo poster="/images/home/demo-poster.jpg" className="shadow-[0_40px_90px_rgba(124,58,237,0.35)]" />
        </div>

        {/* iPhone: the same chat. */}
        <motion.div className="pointer-events-none absolute bottom-0 right-[0%] z-30 w-[16.5%] origin-bottom-right" style={{ x: phoneX, rotate: phoneRotate }}>
          <div className="ade-float">
            <img
              src="/images/hero-v2/phone.webp"
              alt="The same chat in the ADE iPhone app"
              width={1206}
              height={2622}
              loading="eager"
              className="block h-auto w-full rounded-[clamp(14px,2.4vw,38px)] shadow-[0_30px_80px_rgba(0,0,0,0.8)]"
            />
          </div>
        </motion.div>
      </motion.div>
    </figure>
  );
}
