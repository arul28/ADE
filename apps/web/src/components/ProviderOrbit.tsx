import { useState, useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Container } from "./Container";
import { Reveal } from "./Reveal";
import { ADE_EASE_OUT } from "../lib/motion";

import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import deepseekColor from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import googleColor from "@lobehub/icons-static-svg/icons/google-color.svg";
import groq from "@lobehub/icons-static-svg/icons/groq.svg";
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import metaColor from "@lobehub/icons-static-svg/icons/meta-color.svg";
import mistralColor from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg";
import togetherColor from "@lobehub/icons-static-svg/icons/together-color.svg";
import vllmColor from "@lobehub/icons-static-svg/icons/vllm-color.svg";
import xai from "@lobehub/icons-static-svg/icons/xai.svg";

/**
 * Each icon is hand-placed as a percentage (x%, y%) within the container.
 * The positions are designed to look organically scattered within a
 * rough semi-circle / cloud shape — denser toward the center-top,
 * spreading outward toward the bottom-left and bottom-right.
 */
type Provider = {
  name: string;
  icon: string;
  invert?: boolean;
  /** [x%, y%] position within the container */
  pos: [number, number];
};

const PROVIDERS: Provider[] = [
  // Top cluster — tight
  { name: "Anthropic",  icon: anthropic,     invert: true,  pos: [38, 6] },
  { name: "OpenAI",     icon: openai,        invert: true,  pos: [56, 3] },
  { name: "Google",     icon: googleColor,                  pos: [48, 22] },

  // Mid band — a bit wider
  { name: "DeepSeek",   icon: deepseekColor,                pos: [27, 18] },
  { name: "Mistral",    icon: mistralColor,                 pos: [68, 14] },
  { name: "xAI",        icon: xai,           invert: true,  pos: [33, 38] },
  { name: "Groq",       icon: groq,          invert: true,  pos: [62, 34] },
  { name: "Meta",       icon: metaColor,                    pos: [49, 44] },

  // Outer spread — widest, lower
  { name: "Together",   icon: togetherColor,                pos: [16, 52] },
  { name: "OpenRouter",  icon: openrouter,   invert: true,  pos: [78, 48] },
  { name: "Ollama",     icon: ollama,        invert: true,  pos: [8, 72] },
  { name: "LM Studio",  icon: lmstudio,     invert: true,  pos: [88, 68] },
  { name: "vLLM",       icon: vllmColor,                    pos: [30, 70] },
];

export function ProviderOrbit() {
  const [width, setWidth] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  if (width === 0) return null;

  const baseWidth = Math.min(width * 0.7, 520);
  const aspectHeight = baseWidth * 0.52;

  const iconSize =
    width < 480
      ? Math.max(30, baseWidth * 0.075)
      : width < 768
      ? Math.max(34, baseWidth * 0.08)
      : Math.max(38, baseWidth * 0.085);

  return (
    <section className="relative overflow-hidden py-10 sm:py-14">
      {/* Background glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 60% 50% at 50% 60%, rgba(124,58,237,0.10) 0%, transparent 70%)",
            "radial-gradient(ellipse 40% 30% at 30% 70%, rgba(59,130,246,0.06) 0%, transparent 50%)",
          ].join(", "),
        }}
      />

      <Container className="relative">
        <Reveal>
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent/80">
              Providers
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
              Works with{" "}
              <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
                any AI model
              </span>
            </h2>
            <p className="mt-3 text-base text-muted-fg sm:text-lg">
              Bring your own API keys, use existing subscriptions, or run local models.
              ADE unifies them all in one workspace.
            </p>
          </div>
        </Reveal>

        <div className="mt-6 flex justify-center">
          <div
            className="relative"
            style={{ width: baseWidth, height: aspectHeight }}
          >
            {/* Radial glow behind icons */}
            <div className="pointer-events-none absolute inset-0 flex justify-center">
              <div
                className="rounded-full blur-3xl"
                style={{
                  width: baseWidth * 0.75,
                  height: aspectHeight * 1.1,
                  marginTop: -aspectHeight * 0.05,
                  background:
                    "radial-gradient(ellipse at 50% 30%, rgba(124,58,237,0.14) 0%, transparent 70%)",
                }}
              />
            </div>

            {PROVIDERS.map((p, i) => {
              const left = (p.pos[0] / 100) * baseWidth - iconSize / 2;
              const top = (p.pos[1] / 100) * aspectHeight - iconSize / 2;
              const tooltipAbove = p.pos[1] < 40;

              return (
                <motion.div
                  key={p.name}
                  className="absolute flex flex-col items-center group"
                  style={{ left, top, zIndex: 5 }}
                  initial={reduceMotion ? undefined : { opacity: 0, scale: 0.4 }}
                  whileInView={reduceMotion ? undefined : { opacity: 1, scale: 1 }}
                  viewport={{ once: true, amount: 0.1 }}
                  transition={{
                    duration: 0.5,
                    delay: i * 0.045,
                    ease: ADE_EASE_OUT,
                  }}
                >
                  <motion.div
                    animate={
                      reduceMotion
                        ? undefined
                        : { y: [0, -7, 0] }
                    }
                    transition={{
                      duration: 3 + (i % 3) * 0.7,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: i * 0.2,
                    }}
                  >
                    <div
                      className="flex items-center justify-center rounded-xl border border-border/50 bg-white/[0.06] p-2 transition-all duration-300 hover:scale-110 hover:border-accent/40 hover:bg-white/[0.12] hover:shadow-[0_0_24px_rgba(124,58,237,0.25)]"
                      style={{ width: iconSize, height: iconSize }}
                    >
                      <img
                        src={p.icon}
                        alt={p.name}
                        className="h-full w-full object-contain"
                        style={{
                          filter: p.invert
                            ? "invert(1) brightness(0.9)"
                            : undefined,
                        }}
                      />
                    </div>
                  </motion.div>

                  {/* Tooltip */}
                  <div
                    className={`absolute ${
                      tooltipAbove
                        ? "top-[calc(100%+8px)]"
                        : "bottom-[calc(100%+8px)]"
                    } hidden group-hover:block whitespace-nowrap rounded-lg bg-card border border-border/60 px-2.5 py-1 text-xs font-medium text-fg shadow-lg text-center`}
                  >
                    {p.name}
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-card border border-border/60 ${
                        tooltipAbove
                          ? "bottom-full -mb-1.5 border-b-0 border-r-0"
                          : "top-full -mt-1.5 border-t-0 border-l-0"
                      }`}
                    />
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </Container>
    </section>
  );
}
