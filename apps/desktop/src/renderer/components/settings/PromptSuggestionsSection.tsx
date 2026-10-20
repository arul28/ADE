import { useCallback, useEffect, useState } from "react";
import { isWebClientMode } from "../../lib/webClientMode";
import { showToast } from "../app/toast/toastStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

/**
 * Whether ADE suggests the next prompt for providers that do not suggest one
 * themselves. Claude Code always shows its own. Saved to this project's
 * `.ade/local.yaml`, so it is per project and per machine.
 */
export function PromptSuggestionsSection() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);

  // The setting is the host's project configuration, which the hosted client cannot write.
  const onWeb = isWebClientMode();

  useEffect(() => {
    if (onWeb) return;
    let cancelled = false;
    setLoaded(false);
    void window.ade.projectConfig.get(pin)
      .then((snapshot) => {
        if (cancelled) return;
        setEnabled(snapshot.effective.ai?.chat?.promptSuggestionsEnabled === true);
        setLoaded(true);
      })
      .catch(() => {
        // The toggle stays off-limits until the configuration loads.
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWeb, pinKey]);

  /** Saves optimistically; a failed save puts the toggle back and says so. */
  const save = useCallback(async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    setEnabled(value);
    try {
      await window.ade.ai.updateConfig({ chat: { promptSuggestionsEnabled: value } }, pin);
    } catch (error) {
      setEnabled(!value);
      showToast({
        title: "Couldn't save the setting",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }, [pin, saving]);

  if (onWeb) return null;

  return (
    <ModernSection group="Composer" title="Next prompt" hint="A one-line guess at your next message, shown in the empty prompt box. Tab fills it in.">
      <ModernRows>
        <ModernRow
          anchor="prompt-suggestions"
          title="Suggest the next prompt for every provider"
          hint={loaded
            ? "Claude Code always suggests its own. With this on, other providers get one too, from their small model (Luna, Composer) or the chat's own model at its lowest effort: one short call after each finished turn. This project, on this computer."
            : "Loading…"}
          control={(
            <SettingsToggle
              label="Suggest the next prompt for every provider"
              checked={enabled}
              disabled={!loaded || saving}
              onChange={(value) => void save(value)}
            />
          )}
        />
      </ModernRows>
    </ModernSection>
  );
}
