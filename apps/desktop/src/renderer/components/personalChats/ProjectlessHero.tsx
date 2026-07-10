import type { ReactNode } from "react";
import { ChatCircleDots, WarningCircle } from "@phosphor-icons/react";

type HeroPrompt = { label: string; prefill: string };

const HERO_PROMPTS: readonly HeroPrompt[] = [
  { label: "Think through a decision", prefill: "Help me think through a decision I'm facing: " },
  { label: "Draft from a rough idea", prefill: "Help me draft this from a rough idea: " },
  { label: "Research a topic", prefill: "Research this topic with me: " },
  { label: "Plan from my notes", prefill: "Turn these notes into an action plan:\n" },
];

export function ProjectlessHero({
  composer,
  onSelectPrompt,
  providerUnavailable,
}: {
  composer: ReactNode;
  onSelectPrompt: (prefill: string) => void;
  providerUnavailable: boolean;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[660px]">
        <div className="text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[color:var(--chat-accent)]">
            <ChatCircleDots size={23} weight="duotone" />
          </span>
          <h1 className="mt-4 font-sans text-[24px] font-semibold tracking-[-0.025em] text-fg/88">What can I help with?</h1>
          <p className="mx-auto mt-2 max-w-[470px] font-sans text-[12px] leading-5 text-muted-fg/45">Think, write, research, or work through an idea with any agent already connected to ADE.</p>
        </div>

        {providerUnavailable ? (
          <div className="mx-auto mt-5 flex max-w-[470px] items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/[0.07] px-3 py-2.5 text-left font-sans text-[11px] leading-4 text-amber-200/80">
            <WarningCircle size={14} weight="fill" className="mt-px shrink-0 text-amber-300/80" />
            <span>No connected agent is available right now. Sign in to a provider from Settings to start a chat.</span>
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
            {HERO_PROMPTS.map((prompt) => (
              <button
                key={prompt.label}
                type="button"
                onClick={() => onSelectPrompt(prompt.prefill)}
                className="rounded-xl border border-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_7%,transparent)] px-3 py-2.5 text-left font-sans text-[11px] font-medium leading-4 text-fg/70 transition-colors hover:border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] hover:text-fg/90"
              >
                {prompt.label}
              </button>
            ))}
          </div>
        )}

        <div className="mt-4">{composer}</div>
      </div>
    </div>
  );
}
