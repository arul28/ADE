import { useEffect, useState } from "react";
import type { AiChatConfig } from "../../../shared/types";
import { isWebClientMode } from "../../lib/webClientMode";
import { showToast } from "../app/toast/toastStore";
import { ModernRow, ModernRows, ModernSection, SettingsSegmented } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

type HintMode = NonNullable<AiChatConfig["modelHintMode"]>;

const OPTIONS: ReadonlyArray<{ value: HintMode; label: string }> = [
  { value: "model_and_effort", label: "Model and effort" },
  { value: "effort_only", label: "Effort only" },
  { value: "off", label: "Off" },
];

/**
 * Jev's model and effort hint in the composer, under Smart decisions (it asks
 * the same Jev). Shown only on a machine with an OpenCode Zen sign-in, like
 * Smart decisions. Saved to this project's `.ade/local.yaml` on the machine
 * this settings page is scoped to.
 */
export function ModelHintSection() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const onWeb = isWebClientMode();
  const [relevant, setRelevant] = useState(false);
  const [mode, setMode] = useState<HintMode | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (onWeb) return;
    let cancelled = false;
    setMode(null);
    void Promise.all([
      window.ade.ai.jevStatus(pin),
      window.ade.projectConfig.get(pin).catch(() => null),
    ]).then(([jev, config]) => {
      if (cancelled) return;
      setRelevant(jev != null && jev.reason !== "not_signed_in");
      setMode(config ? config.effective.ai?.chat?.modelHintMode ?? "model_and_effort" : null);
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWeb, pinKey]);

  if (onWeb || !relevant) return null;

  const save = async (next: HintMode) => {
    const previous = mode;
    setSaving(true);
    setMode(next);
    try {
      await window.ade.ai.updateConfig({ chat: { modelHintMode: next } }, pin);
    } catch (error) {
      setMode(previous);
      showToast({
        title: "Couldn't save the setting",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModernSection group="Smart decisions" title="Model hint" hint="A suggestion beside the model picker while you type a prompt.">
      <ModernRows>
        <ModernRow
          anchor="model-hint"
          title="Suggest a model and effort while typing"
          hint={mode == null
            ? "Loading…"
            : "Jev reads the prompt, and ADE suggests the cheapest model and effort that do it well. A model you picked yourself is kept: then only its effort is suggested. Needs Smart decisions on."}
          control={(
            <SettingsSegmented
              ariaLabel="Suggest a model and effort while typing"
              value={mode ?? "model_and_effort"}
              options={OPTIONS}
              disabled={mode == null || saving}
              onChange={(next) => void save(next)}
            />
          )}
        />
      </ModernRows>
    </ModernSection>
  );
}
