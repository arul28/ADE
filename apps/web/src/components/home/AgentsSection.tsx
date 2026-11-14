import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Plus } from "lucide-react";
import { cn } from "../../lib/cn";
import { AGENTS, MODEL_SOURCES, OPENCODE_PROVIDERS, ProviderMark, ProviderTile, providerById } from "./providers";

/*
 * Right under the hero, whose live demo already plays a chat that hands work
 * to three models. Two cards of one height side by side: on the left, the
 * pairings a person can build (an agent, where its model comes from, and the
 * model), turning over every few seconds; on the right, every logo.
 */

type Part = { id: string; name: string };
/** Each one is a route ADE can take: a harness, where its model comes from, and the model. */
const PAIRINGS: Array<{ harness: Part; source: Part; model: Part }> = [
  { harness: { id: "claude", name: "Claude Code" }, source: { id: "opencode", name: "OpenCode Go" }, model: { id: "deepseek", name: "DeepSeek V4.1 Flash" } },
  { harness: { id: "codex", name: "Codex" }, source: { id: "x-anthropic", name: "Claude plan" }, model: { id: "x-anthropic", name: "Claude Opus 5.5" } },
  { harness: { id: "droid", name: "Droid" }, source: { id: "openrouter", name: "OpenRouter key" }, model: { id: "kimi", name: "Kimi K2.7 Code" } },
  { harness: { id: "opencode", name: "OpenCode" }, source: { id: "x-openai", name: "ChatGPT plan" }, model: { id: "x-openai", name: "GPT-6 Luna" } },
];

const WALL = [...AGENTS, ...MODEL_SOURCES, ...OPENCODE_PROVIDERS].slice(0, 39);
const TURN_MS = 3200;

const card = "relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#111018] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";

export function AgentsSection() {
  return (
    <section aria-labelledby="agents-title" className="relative mx-auto max-w-[1320px] px-5 pb-0 pt-[clamp(48px,6vw,80px)] sm:px-8">
      <div className="mx-auto max-w-[760px] text-center">
        <h2
          id="agents-title"
          className="font-serif font-normal text-white"
          style={{ fontSize: "clamp(36px, 4.4vw, 64px)", lineHeight: 1.02, letterSpacing: "-0.02em" }}
        >
          Every plan you <em className="italic text-[color:var(--color-violet-bright)]">already pay for.</em>
        </h2>
        <p className="mx-auto mt-4 max-w-[36rem] text-[clamp(15px,1.2vw,17px)] leading-[1.6] text-white/60">
          {AGENTS.length} coding agents and 200+ model providers in one picker. Mention any of them and they work together.
        </p>
      </div>

      <div className="mt-[clamp(36px,4vw,56px)] grid gap-3 lg:grid-cols-[1fr_1.15fr]">
        <PairingCard />
        <div className={cn(card, "p-5 sm:p-7")}>
          <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(90% 70% at 100% 0%, rgba(139,92,246,0.16), transparent 60%)" }} />
          <p className="relative text-[13px] font-medium text-white/55">Agents and model providers</p>
          <ul aria-label="Agents and model sources ADE runs" className="relative mt-4 grid grid-cols-6 gap-2 sm:grid-cols-8">
            {WALL.map((provider) => (
              <li key={provider.id} className="aspect-square">
                <ProviderTile provider={provider} size="fill" />
              </li>
            ))}
            <li className="grid aspect-square place-items-center rounded-[28%] border border-dashed border-white/15 text-[12px] font-medium text-white/55">
              and more…
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/** "Make your own": three logo slots that add up to one model in one agent, turning over every few seconds. */
function PairingCard() {
  const reduceMotion = useReducedMotion() ?? false;
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % PAIRINGS.length), TURN_MS);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);
  const pairing = PAIRINGS[index]!;

  return (
    <div className={cn(card, "flex flex-col p-5 sm:p-7")}>
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(90% 80% at 0% 100%, rgba(236,72,153,0.14), transparent 60%)" }} />
      <p className="relative text-[13px] font-medium text-white/55">Or make your own</p>

      <div className="relative my-auto flex items-start justify-between gap-2 py-8">
        <Slot label="Agent" part={pairing.harness} turn={index} />
        <Plus className="mt-[42px] h-6 w-6 shrink-0 text-white/30" aria-hidden />
        <Slot label="Plan or key" part={pairing.source} turn={index} />
        <Plus className="mt-[42px] h-6 w-6 shrink-0 text-white/30" aria-hidden />
        <Slot label="Model" part={pairing.model} turn={index} />
      </div>

      <div className="relative flex items-center justify-between gap-4 rounded-2xl border border-white/[0.08] bg-black/30 px-4 py-3">
        <p key={index} className="min-w-0 truncate text-[15px] text-white/80">
          <span className="font-semibold text-white">{pairing.model.name}</span> in {pairing.harness.name}
        </p>
        <div className="flex shrink-0 gap-1.5" role="tablist" aria-label="Pairings">
          {PAIRINGS.map((entry, i) => (
            <button
              key={entry.model.name}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`${entry.model.name} in ${entry.harness.name}`}
              onClick={() => setIndex(i)}
              className={cn("focus-ring h-2 rounded-full transition-all", i === index ? "w-5 bg-white" : "w-2 bg-white/25 hover:bg-white/45")}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Slot({ label, part, turn }: { label: string; part: Part; turn: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center text-center">
      <div key={`${turn}-${part.id}`} className="ade-pop-in grid h-[104px] w-[104px] place-items-center rounded-[28px] border border-white/12 bg-[#1a1824] shadow-[0_14px_40px_rgba(0,0,0,0.5)]">
        <ProviderMark provider={providerById(part.id)} className="h-12 w-12" />
      </div>
      <span className="mt-3 text-[11px] font-medium uppercase tracking-[0.12em] text-white/40">{label}</span>
      <span className="mt-1 w-full truncate text-[14px] font-medium text-white">{part.name}</span>
    </div>
  );
}
