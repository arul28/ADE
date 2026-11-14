import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { AGENTS, MODEL_SOURCES, OPENCODE_PROVIDERS, ProviderMark, ProviderTile, providerById } from "./providers";

/*
 * Every agent and model ADE runs, as one wide wall of logos. Under it, one
 * plain example of what that means: any model inside any agent, such as
 * DeepSeek V4.1 Flash inside Claude Code, turning over every few seconds.
 */

type Part = { id: string; name: string };
/** Each one is a route ADE can take: a model, running inside an agent's harness. */
const PAIRINGS: Array<{ model: Part; harness: Part; via: string }> = [
  { model: { id: "deepseek", name: "DeepSeek V4.1 Flash" }, harness: { id: "claude", name: "Claude Code" }, via: "OpenCode Go" },
  { model: { id: "x-anthropic", name: "Claude Opus 5.5" }, harness: { id: "codex", name: "Codex" }, via: "your Claude plan" },
  { model: { id: "kimi", name: "Kimi K2.7 Code" }, harness: { id: "droid", name: "Droid" }, via: "an OpenRouter key" },
  { model: { id: "x-openai", name: "GPT-6 Luna" }, harness: { id: "opencode", name: "OpenCode" }, via: "your ChatGPT plan" },
];

const WALL = [...AGENTS, ...MODEL_SOURCES, ...OPENCODE_PROVIDERS].slice(0, 47);
const TURN_MS = 3200;

export function AgentsSection() {
  return (
    <section aria-labelledby="agents-title" className="relative mx-auto max-w-[1320px] px-5 pt-[clamp(64px,7vw,104px)] sm:px-8">
      <div className="mx-auto max-w-[760px] text-center">
        <h2
          id="agents-title"
          className="font-display text-white"
          style={{ fontSize: "clamp(36px, 4.4vw, 64px)", lineHeight: 1.02, letterSpacing: "-0.04em" }}
        >
          Every plan you <span className="text-white/45">already pay for.</span>
        </h2>
        <p className="mx-auto mt-4 text-[clamp(15px,1.2vw,17px)] leading-[1.6] text-white/60">
          {AGENTS.length} coding agents and 200+ model providers, in one picker.
        </p>
      </div>

      <ul aria-label="Agents and model sources ADE runs" className="mt-[clamp(32px,4vw,48px)] grid grid-cols-6 gap-2 sm:grid-cols-8 lg:grid-cols-12">
        {WALL.map((provider) => (
          <li key={provider.id} className="aspect-square">
            <ProviderTile provider={provider} size="fill" />
          </li>
        ))}
        <li className="grid aspect-square place-items-center rounded-[28%] border border-dashed border-white/15 text-[12px] font-medium text-white/55">
          and more…
        </li>
      </ul>

      <MixCard />
    </section>
  );
}

/** "Any model, inside any agent": one pairing at a time, said as a sentence and drawn as two logos. */
function MixCard() {
  const reduceMotion = useReducedMotion() ?? false;
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % PAIRINGS.length), TURN_MS);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);
  const pairing = PAIRINGS[index]!;

  return (
    <div className="relative mt-3 overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,#17161f,#0f0e15)] px-6 py-6 sm:px-9">
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(70% 120% at 0% 50%, rgba(236,72,153,0.14), transparent 60%), radial-gradient(70% 120% at 100% 50%, rgba(139,92,246,0.16), transparent 60%)" }} />
      <div className="relative flex flex-col items-center gap-6 md:flex-row md:justify-between">
        <div className="min-w-0 text-center md:text-left">
          <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-white/45">Mix your own</p>
          <p key={index} className="ade-pop-in mt-2 whitespace-nowrap text-[clamp(18px,1.8vw,26px)] font-semibold tracking-[-0.01em] text-white">
            Run {pairing.model.name} inside {pairing.harness.name}.
          </p>
          <p className="mt-1 text-[14px] text-white/50">Any model, in any agent, through {pairing.via}.</p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <LogoTile part={pairing.model} turn={index} />
          <ArrowRight className="h-6 w-6 text-white/35" aria-hidden />
          <LogoTile part={pairing.harness} turn={index} />
          <div className="ml-3 flex gap-1.5" role="tablist" aria-label="Examples">
            {PAIRINGS.map((entry, i) => (
              <button
                key={entry.model.name}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`${entry.model.name} inside ${entry.harness.name}`}
                onClick={() => setIndex(i)}
                className={cn("focus-ring h-2 rounded-full transition-all", i === index ? "w-5 bg-white" : "w-2 bg-white/25 hover:bg-white/45")}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LogoTile({ part, turn }: { part: Part; turn: number }) {
  return (
    <div key={`${turn}-${part.id}`} title={part.name} className="ade-pop-in grid h-[72px] w-[72px] place-items-center rounded-[22px] border border-white/12 bg-[#1a1824] shadow-[0_14px_40px_rgba(0,0,0,0.5)]">
      <ProviderMark provider={providerById(part.id)} className="h-9 w-9" />
    </div>
  );
}
