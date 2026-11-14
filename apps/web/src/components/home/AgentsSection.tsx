import { Plus } from "lucide-react";
import { AGENTS, MODEL_SOURCES, OPENCODE_PROVIDERS, ProviderMark, ProviderTile, providerById } from "./providers";

/*
 * Right under the hero, whose live demo already plays a chat that hands work
 * to three models: every agent and model ADE runs, as one wall of logos, and
 * the pairings a person can build from them. One screen, no scroll film.
 */

type Part = { id: string; name: string };
/** Each one is a route ADE can take: a harness, where its model comes from, and the model. */
const PAIRINGS: Array<{ harness: Part; source: Part; model: Part }> = [
  { harness: { id: "claude", name: "Claude Code" }, source: { id: "opencode", name: "OpenCode Go" }, model: { id: "deepseek", name: "DeepSeek V4.1 Flash" } },
  { harness: { id: "codex", name: "Codex" }, source: { id: "x-anthropic", name: "Claude plan" }, model: { id: "x-anthropic", name: "Claude Opus 5.5" } },
  { harness: { id: "droid", name: "Droid" }, source: { id: "openrouter", name: "OpenRouter key" }, model: { id: "kimi", name: "Kimi K2.7 Code" } },
];

const WALL = [...AGENTS, ...MODEL_SOURCES, ...OPENCODE_PROVIDERS];

export function AgentsSection() {
  return (
    <section aria-labelledby="agents-title" className="relative mx-auto max-w-[1240px] px-5 pb-[clamp(72px,9vw,128px)] pt-[clamp(72px,9vw,120px)] sm:px-8">
      <div className="grid items-center gap-[clamp(40px,6vw,88px)] lg:grid-cols-[1fr_1fr]">
        <div>
          <h2
            id="agents-title"
            className="font-serif font-normal text-white"
            style={{ fontSize: "clamp(36px, 4.4vw, 64px)", lineHeight: 1.02, letterSpacing: "-0.02em" }}
          >
            Every plan you
            <br />
            <em className="italic text-[color:var(--color-violet-bright)]">already pay for.</em>
          </h2>
          <p className="mt-5 max-w-[30rem] text-[clamp(15px,1.2vw,17px)] leading-[1.6] text-white/60">
            {AGENTS.length} coding agents and 200+ model providers, in one picker. Mention any of them in a message and they
            work together, the way the chat above does.
          </p>

          <div className="mt-8">
            <p className="text-[13px] font-medium text-white/45">Or pair them your own way</p>
            <ul className="mt-3 flex flex-col gap-2">
              {PAIRINGS.map((pairing) => (
                <li
                  key={pairing.model.name}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[13.5px] text-white/80"
                >
                  <Chip part={pairing.harness} />
                  <Plus className="h-3 w-3 text-white/30" aria-hidden />
                  <Chip part={pairing.source} />
                  <Plus className="h-3 w-3 text-white/30" aria-hidden />
                  <Chip part={pairing.model} strong />
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div>
          <ul aria-label="Agents and model sources ADE runs" className="grid grid-cols-6 gap-2 sm:grid-cols-9 lg:grid-cols-8">
            {WALL.slice(0, 40).map((provider) => (
              <li key={provider.id} className="aspect-square">
                <ProviderTile provider={provider} size="fill" />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-right text-[13px] text-white/40">And every model on models.dev, through OpenCode.</p>
        </div>
      </div>
    </section>
  );
}

function Chip({ part, strong }: { part: Part; strong?: boolean }) {
  return (
    <span className={strong ? "inline-flex items-center gap-1.5 font-semibold text-white" : "inline-flex items-center gap-1.5"}>
      <ProviderMark provider={providerById(part.id)} className="h-4 w-4" />
      {part.name}
    </span>
  );
}
