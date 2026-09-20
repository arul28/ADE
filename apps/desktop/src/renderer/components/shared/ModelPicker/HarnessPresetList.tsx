import React, { memo, useCallback, useEffect, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import {
  HARNESS_PRESET_AGENT_KEYS,
  HARNESS_PRESET_AGENT_LABELS,
  harnessBodyLabel,
  presetLabel,
  presetSourceLabel,
  type HarnessPreset,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";
import { harnessPermissionLabel } from "../../settings/harnesses/harnessPermissionModes";
import { harnessModelLabel } from "../../settings/harnesses/harnessModels";
import { loadHarnessAccounts } from "../../settings/harnesses/harnessSources";
import { bodyLogoFamily, PresetAgent, PresetModels } from "../../settings/harnesses/presetFacts";
import { CustomHammerMark } from "../CustomHammerMark";
import { HarnessLogo } from "../HarnessLogo";
import { ProviderLogo } from "../ProviderLogos";
import { cn } from "../../ui/cn";

/**
 * The Custom tab of the model picker.
 *
 * A saved setup is a whole launch configuration, not a model — but it is picked
 * from the same list as models are, so it is drawn the same way: mark, name,
 * one muted subtitle, a chip or two. It used to have its own font sizes and its
 * own spacing, which made the tab read as a different product from the nine
 * provider tabs beside it.
 *
 * Everything the setup would silently apply (which account, what subagents run
 * on, which built-ins are pinned, how much it is allowed to do) sits behind the
 * caret, labelled and with the logos that say whose model each one is — because
 * a one-click launch that quietly sets permission mode to bypass is exactly the
 * surprise this list must not create.
 */

/** The provider whose mark a source wears. Key sources name their own. */
function sourceLogoFamily(source: HarnessPresetSource): string {
  return source.kind === "key" ? source.provider : source.provider;
}

/** A labelled line in the expanded details: label, mark, value. */
function DetailRow({
  label,
  mark,
  value,
}: {
  label: string;
  mark?: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-fg/55">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-fg/80">
        {mark}
        <span className="min-w-0 truncate">{value}</span>
      </dd>
    </>
  );
}

export const HarnessPresetRow = memo(function HarnessPresetRow({
  preset,
  isActive,
  onSelect,
  accountLabel,
}: {
  preset: HarnessPreset;
  isActive: boolean;
  onSelect: (preset: HarnessPreset) => void;
  /**
   * Resolves an account source's instance id to its display name, so the
   * Source row names *which* sign-in the preset launches on — the same fact
   * the settings table shows. Absent while the registry is still loading, in
   * which case the row degrades to the provider alone rather than guessing.
   */
  accountLabel?: (instanceId: string) => string | null | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const handleSelect = useCallback(() => onSelect(preset), [onSelect, preset]);
  const overrides = HARNESS_PRESET_AGENT_KEYS
    .map((agent) => {
      const model = preset.agentOverrides[agent];
      return model ? `${HARNESS_PRESET_AGENT_LABELS[agent]}: ${harnessModelLabel(model)}` : null;
    })
    .filter((entry): entry is string => entry !== null);

  return (
    <div
      data-harness-preset-row={preset.id}
      className={cn(
        "mx-0.5 mb-0.5 rounded-md border transition-colors",
        isActive
          ? "border-violet-400/30 bg-violet-500/[0.08]"
          : "border-transparent hover:border-white/[0.08] hover:bg-white/[0.03]",
      )}
    >
      {/* Same geometry as `ModelListRow`: gap-2, px-2.5 py-1.5, a 13px mark, a
          12px name and a 10px subtitle. */}
      <div className="group flex w-full items-start gap-2 px-2.5 py-1.5">
        <button
          type="button"
          role="option"
          aria-selected={isActive}
          onClick={handleSelect}
          data-harness-preset-select={preset.id}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <HarnessLogo logo={preset.logo} size={14} accentColor={preset.accentColor} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[12px] font-medium leading-snug text-fg">
                {presetLabel(preset)}
              </span>
              {/* The agent is the chip, because it is the fact that changes what
                  pressing this row actually launches. */}
              <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-white/[0.06] px-1 py-px text-[9px] font-semibold uppercase leading-none text-fg/70">
                <ProviderLogo family={bodyLogoFamily(preset.harness)} size={9} />
                {harnessBodyLabel(preset.harness)}
              </span>
            </span>
            <span className="block truncate text-[10px] font-normal leading-snug text-muted-fg/55">
              {harnessModelLabel(preset.model)}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} details for ${presetLabel(preset)}`}
          data-harness-preset-expand={preset.id}
          onClick={() => setExpanded((current) => !current)}
          className="mt-0.5 shrink-0 rounded p-1 text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg"
        >
          <CaretRight size={12} className={cn("transition-transform", expanded && "rotate-90")} />
        </button>
      </div>

      {expanded ? (
        <dl
          data-harness-preset-details={preset.id}
          className="grid grid-cols-[62px_1fr] items-center gap-x-2 gap-y-1 border-t border-white/[0.06] px-3 py-2 text-[10.5px]"
        >
          <DetailRow label="Agent" value={<PresetAgent harness={preset.harness} size={12} />} />
          <DetailRow
            label="Source"
            mark={<ProviderLogo family={sourceLogoFamily(preset.source)} size={12} />}
            value={presetSourceLabel(preset.source, accountLabel)}
          />
          <dt className="self-start text-muted-fg/55">Models</dt>
          <dd className="m-0 min-w-0 text-fg/80">
            <PresetModels preset={preset} size={12} roleWidth={54} />
          </dd>
          <DetailRow
            label="Built-ins"
            value={overrides.length > 0 ? overrides.join(" · ") : "All follow subagents"}
          />
          <DetailRow
            label="Permission"
            value={harnessPermissionLabel(preset.harness, preset.permissionMode)}
          />
        </dl>
      ) : null}
    </div>
  );
});

/**
 * Instance-id → account name, read once per open picker.
 *
 * The settings table already names the account a preset runs on; the picker
 * resolved nothing, so the same preset read "Claude Code account" there and
 * "Claude Code account · Work" in settings. One read of the machine-local
 * registry (the same call the wizard makes, which never throws) closes that.
 */
function useHarnessAccountLabel(): (instanceId: string) => string | null {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const accounts = await loadHarnessAccounts();
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const account of accounts) next[account.instanceId] = account.label;
        setLabels(next);
      } catch {
        // A registry that cannot be read leaves the Source row on the provider
        // name alone — the pre-existing text, never a wrong account.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return useCallback((instanceId: string) => labels[instanceId] ?? null, [labels]);
}

/** The preset rows, with their account names resolved once for the whole list. */
export function HarnessPresetList({
  presets,
  activeModelId,
  onSelect,
}: {
  presets: readonly HarnessPreset[];
  activeModelId: string;
  onSelect: (preset: HarnessPreset) => void;
}) {
  const accountLabel = useHarnessAccountLabel();
  return (
    <div data-model-picker-harness-list="true">
      {presets.map((preset) => (
        <HarnessPresetRow
          key={preset.id}
          preset={preset}
          isActive={preset.model === activeModelId}
          onSelect={onSelect}
          accountLabel={accountLabel}
        />
      ))}
    </div>
  );
}

export function HarnessPresetEmptyState({
  searchActive,
  onOpenHarnessSettings,
}: {
  searchActive: boolean;
  onOpenHarnessSettings?: () => void;
}) {
  return (
    <div
      data-harness-preset-empty=""
      className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1.5 px-4 py-6 text-center"
    >
      <CustomHammerMark size={22} />
      <span className="text-[12px] font-semibold text-fg/80">
        {searchActive ? "Nothing custom matches your search." : "Nothing custom yet"}
      </span>
      {/* The way out comes first and the explanation sits under it: a user who
          has just found an empty list wants the button, and the sentence is
          what tells them what pressing it will get them. */}
      {onOpenHarnessSettings ? (
        <button
          type="button"
          data-harness-preset-empty-cta="true"
          onClick={onOpenHarnessSettings}
          className="mt-0.5 rounded border border-white/[0.12] px-2.5 py-1 text-[11px] font-semibold text-fg/85 hover:bg-white/[0.06]"
        >
          Add a custom setup
        </button>
      ) : null}
      <span className="max-w-[280px] text-[11px] leading-relaxed text-muted-fg/60">
        Save an agent and its model source together, and they show up here as one row.
      </span>
      {onOpenHarnessSettings ? null : (
        <span className="mt-1 text-[10.5px] text-muted-fg/50">Settings › Providers › Custom</span>
      )}
    </div>
  );
}
