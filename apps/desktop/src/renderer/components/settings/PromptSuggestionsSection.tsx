import { Sparkle } from "@phosphor-icons/react";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useChatConfigToggle } from "./useChatConfigToggle";

/**
 * Whether ADE suggests the next prompt for providers that do not suggest one
 * themselves. Claude Code always shows its own. Codex has its own switch, on
 * by default; every other provider shares one, off by default. Saved to this
 * project's `.ade/local.yaml`, so it is per project and per machine.
 */
export function PromptSuggestionsSection() {
  const codex = useChatConfigToggle("codexPromptSuggestionsEnabled", { defaultOn: true });
  const others = useChatConfigToggle("promptSuggestionsEnabled");
  if (others.onWeb) return null;

  const hintFor = (status: "loading" | "loaded" | "failed", loaded: string) => status === "loading"
    ? "Loading…"
    : status === "failed"
      ? "Couldn't load the configuration. The switch keeps its default until it loads."
      : loaded;

  return (
    <ModernSection
      group="Composer"
      title="Next prompt"
      hint="A one-line guess at your next message in the empty prompt box. Tab fills it in. Claude Code suggests its own."
      icon={<Sparkle size={16} weight="bold" />}
      tone="teal"
    >
      <ModernRows>
        <ModernRow
          anchor="prompt-suggestions-codex"
          title="Suggest the next prompt in Codex chats"
          hint={hintFor(codex.status, "One short call on Codex's small model per finished turn. If that fails, the chat's own model answers, which costs more.")}
          control={(
            <SettingsToggle
              label="Suggest the next prompt in Codex chats"
              checked={codex.enabled}
              disabled={codex.status !== "loaded" || codex.saving}
              onChange={(value) => void codex.save(value)}
            />
          )}
        />
        <ModernRow
          anchor="prompt-suggestions"
          title="Suggest the next prompt for other providers"
          hint={hintFor(others.status, "One short call on each provider's small model per finished turn.")}
          control={(
            <SettingsToggle
              label="Suggest the next prompt for other providers"
              checked={others.enabled}
              disabled={others.status !== "loaded" || others.saving}
              onChange={(value) => void others.save(value)}
            />
          )}
        />
      </ModernRows>
    </ModernSection>
  );
}
