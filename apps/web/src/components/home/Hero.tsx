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
import { CompetitorEquation } from "../editorial/CompetitorEquation";
import { useInstallDialog } from "../install/InstallDialogProvider";
import { AppleMark, WindowsMark } from "./marks";
import { guessPlatform } from "./SiteNav";

const secondaryButton =
  "inline-flex h-11 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-5 text-[14px] font-medium text-white/85 transition-all hover:-translate-y-px hover:border-white/35 hover:bg-white/[0.08] hover:text-white";

const quietLink =
  "inline-flex items-center gap-1 text-white/55 underline decoration-white/15 underline-offset-4 transition-colors hover:text-white";

export function Hero() {
  const { openInstall } = useInstallDialog();
  const windows = guessPlatform() === "windows";
  const installCommand = windows ? WINDOWS_INSTALL_COMMAND : MAC_INSTALL_COMMAND;

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
          terminal, and iPhone. Bring your own models.
        </p>

        <div
          className="ade-rise mt-8 flex flex-wrap items-center justify-center gap-3"
          style={{ animationDelay: "180ms" }}
        >
          <button
            type="button"
            onClick={() => openInstall("mac")}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_MAC}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HERO}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-6 text-[14px] font-medium text-black shadow-[0_8px_40px_rgba(167,139,250,0.35)] transition-all hover:-translate-y-px hover:bg-white/90"
          >
            <AppleMark className="h-4 w-4" /> Download for Mac
          </button>
          <button
            type="button"
            onClick={() => openInstall("windows")}
            data-ade-analytics-cta={MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HERO}
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
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HERO}
            className={secondaryButton}
          >
            <Smartphone className="h-4 w-4" /> iPhone
          </a>
        </div>

        <div
          className="ade-rise mt-5 flex max-w-full items-center gap-1 rounded-full border border-white/10 bg-black/40 py-1 pl-4 pr-1 font-mono text-[12.5px] text-white/70 backdrop-blur"
          style={{ animationDelay: "220ms" }}
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
          className="ade-rise mt-4 flex flex-wrap items-center justify-center gap-x-2.5 text-[13px] text-white/30"
          style={{ animationDelay: "260ms" }}
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
      </div>

      <HeroDevices />
    </section>
  );
}

/**
 * One chat, three screens: the Mac app, `ade code` in a terminal, and the
 * iPhone app, all captured at the same moment. The group starts tilted back
 * and settles flat as it scrolls into view; the terminal and phone drift in
 * from the sides, end straight, and then float. Every size is a percentage of one container,
 * so the overlap holds at every width.
 */
function HeroDevices() {
  const reduceMotion = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "start 25%"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [reduceMotion ? 0 : 22, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [reduceMotion ? 1 : 0.9, 1]);
  const termX = useTransform(scrollYProgress, [0, 1], [reduceMotion ? "0%" : "-10%", "0%"]);
  const phoneX = useTransform(scrollYProgress, [0, 1], [reduceMotion ? "0%" : "14%", "0%"]);
  // The side devices start tilted and end exactly straight once the group is in view.
  const termRotate = useTransform(scrollYProgress, [0, 1], [reduceMotion ? 0 : -6, 0]);
  const phoneRotate = useTransform(scrollYProgress, [0, 1], [reduceMotion ? 0 : 7, 0]);

  return (
    <figure
      ref={ref}
      className="relative mx-auto mt-[clamp(40px,5vw,72px)] max-w-[1480px] px-4 sm:px-8"
      style={{ perspective: "1800px" }}
    >
      <motion.div className="relative pb-[12%]" style={{ rotateX, scale, transformOrigin: "50% 0%" }}>
        {/* Desktop: the screenshot carries its own macOS window chrome. */}
        <div className="relative mx-auto w-[92%]">
          <img
            src="/images/hero-v2/desktop.webp"
            alt="The ADE app on macOS with a chat open"
            width={2224}
            height={1250}
            loading="eager"
            fetchPriority="high"
            className="block h-auto w-full drop-shadow-[0_40px_90px_rgba(124,58,237,0.35)]"
          />
        </div>

        {/* Terminal: `ade code`, the same chat. */}
        <motion.div className="absolute bottom-[1%] left-[-1%] z-20 w-[42%] origin-bottom-left" style={{ x: termX, rotate: termRotate }}>
          <div className="origin-bottom-left transition-transform duration-500 ease-out [@media(hover:hover)]:hover:scale-[1.06]">
            <div className="ade-float" style={{ animationDelay: "-2s" }}>
              <div className="overflow-hidden rounded-[clamp(6px,0.8vw,12px)] border border-white/12 bg-[#1e2021] shadow-[0_30px_70px_rgba(0,0,0,0.75)]">
                <div className="flex h-[clamp(14px,1.9vw,26px)] items-center gap-[clamp(3px,0.45vw,6px)] border-b border-white/[0.06] bg-[#2a2c2d] px-[clamp(6px,0.9vw,12px)]">
                  <span className="aspect-square h-[42%] rounded-full bg-[#ff5f57]" />
                  <span className="aspect-square h-[42%] rounded-full bg-[#febc2e]" />
                  <span className="aspect-square h-[42%] rounded-full bg-[#28c840]" />
                  <span className="mx-auto -translate-x-[clamp(10px,2vw,30px)] font-mono text-[clamp(6px,0.75vw,11px)] text-white/45">
                    ade code
                  </span>
                </div>
                <img
                  src="/images/hero-v2/terminal.webp"
                  alt="The same chat in ADE Code, the terminal app"
                  width={2228}
                  height={1166}
                  loading="eager"
                  className="block h-auto w-full"
                />
              </div>
            </div>
          </div>
        </motion.div>

        {/* iPhone: the same chat. */}
        <motion.div className="absolute bottom-0 right-0 z-30 w-[17%] origin-bottom-right" style={{ x: phoneX, rotate: phoneRotate }}>
          <div className="origin-bottom-right transition-transform duration-500 ease-out [@media(hover:hover)]:hover:scale-[1.06]">
            <div className="ade-float">
              <div className="rounded-[clamp(18px,3vw,46px)] bg-[#0b0b0e] p-[clamp(3px,0.45vw,7px)] shadow-[0_30px_80px_rgba(124,58,237,0.45),0_0_0_1px_rgba(255,255,255,0.14)]">
                <img
                  src="/images/hero-v2/phone.webp"
                  alt="The same chat in the ADE iPhone app"
                  width={1206}
                  height={2622}
                  loading="eager"
                  className="block h-auto w-full rounded-[clamp(15px,2.6vw,40px)]"
                />
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </figure>
  );
}
