export type SuggestionPrompt = { label: string; prefill: string };

/**
 * Ways to start a new project-less chat, under the empty composer. A chip fills
 * the draft; the user finishes the sentence. The Chats page and the Browser
 * tab's docked chat each pass their own prompts.
 */
export function SuggestionChips({
  prompts,
  onSelect,
}: {
  prompts: ReadonlyArray<SuggestionPrompt>;
  onSelect: (prefill: string) => void;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5" aria-label="Suggestions">
      {prompts.map((prompt) => (
        <button
          key={prompt.label}
          type="button"
          onClick={() => onSelect(prompt.prefill)}
          className="h-7 rounded-full border border-fg/[0.08] bg-fg/[0.03] px-3 font-sans text-[11px] text-fg/65 transition-colors hover:border-fg/[0.14] hover:bg-fg/[0.06] hover:text-fg/85"
        >
          {prompt.label}
        </button>
      ))}
    </div>
  );
}
