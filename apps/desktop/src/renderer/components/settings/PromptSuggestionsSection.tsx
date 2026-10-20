import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useChatConfigToggle } from "./useChatConfigToggle";

/**
 * Whether ADE suggests the next prompt for providers that do not suggest one
 * themselves. Claude Code always shows its own. Saved to this project's
 * `.ade/local.yaml`, so it is per project and per machine.
 */
export function PromptSuggestionsSection() {
  const { onWeb, status, saving, enabled, save } = useChatConfigToggle("promptSuggestionsEnabled");
  if (onWeb) return null;

  return (
    <ModernSection group="Composer" title="Next prompt" hint="A one-line guess at your next message in the empty prompt box. Tab fills it in.">
      <ModernRows>
        <ModernRow
          anchor="prompt-suggestions"
          title="Suggest the next prompt for every provider"
          hint={status === "loading"
            ? "Loading…"
            : status === "failed"
              ? "Couldn't load the configuration. The switch stays off until it loads."
              : "Claude Code suggests its own. Other providers get one from their small model, one short call per finished turn."}
          control={(
            <SettingsToggle
              label="Suggest the next prompt for every provider"
              checked={enabled}
              disabled={status !== "loaded" || saving}
              onChange={(value) => void save(value)}
            />
          )}
        />
      </ModernRows>
    </ModernSection>
  );
}
