import { AgentBadge } from "./AgentBadge";

// `inset` = horizontal distance from the viewport edge. Varying it per badge
// scatters them across the gutter instead of stacking them in one straight line.
const LEFT_AGENTS = [
  // Vertical positions are intentionally uneven (not an even column) and the
  // insets alternate deep/shallow so the badges scatter through the gutter.
  // The bottom badge is pulled up off the corner into its own gap. Mid-height
  // rows (headline band) keep shallow insets so they never cover the headline.
  { src: "/images/models/claude-color.svg", name: "Claude", className: "top-[8%]", inset: "clamp(140px,16vw,340px)", rotate: -8, delay: 0.75, floatPhase: 0 },
  { src: "/images/models/openai.svg", name: "OpenAI", className: "top-[19%]", inset: "clamp(40px,5vw,116px)", rotate: 5, delay: 0.82, floatPhase: 0.6 },
  { src: "/images/models/grok.svg", name: "Grok", className: "top-[37%]", inset: "clamp(84px,9.5vw,196px)", rotate: -5, delay: 0.96, floatPhase: 1.8 },
  { src: "/images/models/anthropic.svg", name: "Anthropic", className: "top-[51%]", inset: "clamp(150px,16vw,332px)", rotate: -3, delay: 1.1, floatPhase: 3 },
  { src: "/images/models/mistral-color.svg", name: "Mistral", className: "top-[65%]", inset: "clamp(32px,4vw,88px)", rotate: 4, delay: 1.17, floatPhase: 3.6 },
  { src: "/images/models/cohere-color.svg", name: "Cohere", className: "top-[78%]", inset: "clamp(112px,12.5vw,262px)", rotate: -4, delay: 1.31, floatPhase: 4.8 },
] as const;

const RIGHT_AGENTS = [
  { src: "/images/models/gemini-color.svg", name: "Gemini", className: "top-[5%]", inset: "clamp(48px,6.5vw,132px)", rotate: 10, delay: 0.89, floatPhase: 1.2 },
  { src: "/images/models/deepseek-color.svg", name: "DeepSeek", className: "top-[22%]", inset: "clamp(150px,16vw,332px)", rotate: 7, delay: 1.03, floatPhase: 2.4 },
  { src: "/images/models/ollama.svg", name: "Ollama", className: "top-[35%]", inset: "clamp(70px,8vw,176px)", rotate: 6, delay: 1.52, floatPhase: 6.6 },
  { src: "/images/models/meta-color.svg", name: "Meta Llama", className: "top-[53%]", inset: "clamp(150px,16vw,344px)", rotate: -6, delay: 1.24, floatPhase: 4.2 },
  { src: "/images/models/perplexity-color.svg", name: "Perplexity", className: "top-[64%]", inset: "clamp(28px,3.5vw,76px)", rotate: -7, delay: 1.45, floatPhase: 6 },
  { src: "/images/models/qwen-color.svg", name: "Qwen", className: "top-[77%]", inset: "clamp(120px,13vw,284px)", rotate: 8, delay: 1.38, floatPhase: 5.4 },
] as const;

/**
 * Model badges sit in viewport side gutters beside the device stack only.
 */
export function HeroAgentBadges() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-1/2 z-50 hidden w-screen max-w-[100vw] -translate-x-1/2 lg:block"
    >
      {LEFT_AGENTS.map((agent) => (
        <AgentBadge
          key={agent.name}
          src={agent.src}
          name={agent.name}
          anchor="left"
          className={`pointer-events-auto ${agent.className}`}
          style={{ left: agent.inset }}
          rotate={agent.rotate}
          variant="hero"
          delay={agent.delay}
          floatPhase={agent.floatPhase}
        />
      ))}
      {RIGHT_AGENTS.map((agent) => (
        <AgentBadge
          key={agent.name}
          src={agent.src}
          name={agent.name}
          anchor="right"
          className={`pointer-events-auto ${agent.className}`}
          style={{ right: agent.inset }}
          rotate={agent.rotate}
          variant="hero"
          delay={agent.delay}
          floatPhase={agent.floatPhase}
        />
      ))}
    </div>
  );
}
