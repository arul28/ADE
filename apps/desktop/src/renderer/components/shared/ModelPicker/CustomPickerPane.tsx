import { useCallback, useMemo } from "react";
import { GearSix } from "@phosphor-icons/react";
import {
  harnessPresetMatchesQuery,
  type HarnessPreset,
} from "../../../../shared/harnessPresets";
import { cliPresetGateReason } from "../../../../shared/harnessPresetCliGate";
import { launchModelIdFor } from "../../settings/harnesses/harnessReach";
import { useHarnessPresets } from "../../settings/harnesses/useHarnessPresets";
import { HarnessPresetList } from "./HarnessPresetList";

/**
 * The picker's Custom tab: the Custom providers you already saved, and a way to
 * go and change them.
 *
 * A picker picks. Building one — choosing a harness, a source, a model, a
 * thinking level — is a form with five steps and a live catalog, and it has a
 * whole page of its own under Settings › Providers › Custom. Putting a second,
 * weaker copy of that builder behind a tab in a model dropdown made the same
 * list appear in two places, with two different sets of controls, and the
 * picker's copy could not save anything it produced.
 *
 * So this tab is one list plus one link. Everything a saved provider carries —
 * its model, its effort, its subagent settings, its harness — arrives with the
 * click, because the preset is the whole launch configuration.
 */

export function CustomPickerPane({
  query,
  value,
  activePresetId,
  mode,
  catalogScopeKey,
  onSelect,
  onOpenHarnessSettings,
}: {
  query: string;
  /** The picker's current model id. */
  value: string;
  /** The preset id the surface runs on, if any. */
  activePresetId: string | null;
  mode: "chat" | "cli";
  catalogScopeKey?: string;
  onSelect: (modelId: string, presetId: string | undefined) => void;
  /** Opens Settings › Providers › Custom. */
  onOpenHarnessSettings?: () => void;
}) {
  const { presets } = useHarnessPresets();

  const visiblePresets = useMemo<HarnessPreset[]>(
    () => presets.filter((preset) => harnessPresetMatchesQuery(preset, query)),
    [presets, query],
  );

  const handlePreset = useCallback((preset: HarnessPreset) => {
    onSelect(launchModelIdFor(preset.harness, preset.source, preset.model), preset.id);
  }, [onSelect]);

  const presetDisabledReason = useCallback(
    (preset: HarnessPreset) => (mode === "cli" ? cliPresetGateReason(preset.harness) : null),
    [mode],
  );

  const manageLink = onOpenHarnessSettings ? (
    <button
      type="button"
      data-custom-picker-manage=""
      onClick={onOpenHarnessSettings}
      className="inline-flex items-center gap-1.5 self-start text-[11px] font-medium text-muted-fg/65 hover:text-fg/85"
    >
      <GearSix size={12} />
      {presets.length === 0 ? "Set up a custom provider" : "Manage custom providers"}
    </button>
  ) : null;

  if (visiblePresets.length === 0) {
    return (
      <div data-custom-picker-pane="" className="flex flex-col gap-2 px-2.5 py-3">
        <span className="text-[11px] leading-relaxed text-muted-fg/60">
          {presets.length === 0
            ? "No custom providers yet. A custom provider is a harness and the model it runs on, saved as one choice."
            : "No custom provider matches your search."}
        </span>
        {manageLink}
      </div>
    );
  }

  return (
    <div data-custom-picker-pane="" className="flex flex-col pb-1">
      <HarnessPresetList
        presets={visiblePresets}
        activeModelId={value}
        activePresetId={activePresetId}
        onSelect={handlePreset}
        disabledReasonFor={presetDisabledReason}
        {...(catalogScopeKey ? { catalogScopeKey } : {})}
      />
      <span className="mx-2 mt-1 flex flex-col">{manageLink}</span>
    </div>
  );
}
