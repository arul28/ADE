import { useCallback, useMemo, useState } from "react";
import { GearSix } from "@phosphor-icons/react";
import {
  harnessBodyLabel,
  harnessPresetMatchesQuery,
  isHarnessPresetBody,
  type HarnessPreset,
  type HarnessPresetBody,
} from "../../../../shared/harnessPresets";
import { decodeRoutePresetId, isRoutePresetId } from "../../../../shared/harnessRoutes";
import { cliPresetGateReason } from "../../../../shared/harnessPresetCliGate";
import type { OpenProjectBinding } from "../../../../shared/types";
import {
  adHocPresetIdFor,
  buildReachableGroups,
  harnessChipOptions,
  launchModelIdFor,
  reachableKeyFor,
  type ReachableGroup,
  type ReachableModel,
} from "../../settings/harnesses/harnessReach";
import { useHarnessReach } from "../../settings/harnesses/useHarnessReach";
import { useHarnessPresets } from "../../settings/harnesses/useHarnessPresets";
import { HarnessPresetList } from "./HarnessPresetList";
import { HarnessChipRow, ReachableModelList } from "./ReachableModelList";

/**
 * The picker's Custom tab: saved Custom providers, then "Run in".
 *
 * "Run in" is the ad-hoc half of Custom. Pick a harness, and the list below is
 * every model that harness can reach from what this machine has connected —
 * its own account, OpenCode sign-ins, stored keys, subscriptions through the
 * proxy — grouped by source. Picking a row launches that pairing without
 * saving anything; it travels as an ad-hoc route id in the chat's `presetId`.
 *
 * CLI mode shows the same tab. The CLIs that take no endpoint from a launch
 * (Cursor, Copilot, Kimi) stay visible as disabled chips with the reason.
 */

/** The last Run-in harness, for the next time the picker opens this session. */
let lastRunInHarness: HarnessPresetBody | null = null;

export function CustomPickerPane({
  query,
  value,
  activePresetId,
  currentHarness,
  mode,
  runtimePin,
  catalogScopeKey,
  onSelect,
  onOpenHarnessSettings,
}: {
  query: string;
  /** The picker's current model id. */
  value: string;
  /** The preset or route id the surface runs on, if any. */
  activePresetId: string | null;
  /** The harness the current model runs in; the first Run-in pick. */
  currentHarness: string | null;
  mode: "chat" | "cli";
  runtimePin: OpenProjectBinding | null;
  catalogScopeKey?: string;
  onSelect: (modelId: string, presetId: string | undefined) => void;
  onOpenHarnessSettings?: () => void;
}) {
  const { presets } = useHarnessPresets();
  const chipOptions = useMemo(() => harnessChipOptions(mode), [mode]);
  const reach = useHarnessReach({ enabled: true, pin: runtimePin, ...(catalogScopeKey ? { catalogScopeKey } : {}) });

  const activeRoute = useMemo(
    () => (isRoutePresetId(activePresetId) ? decodeRoutePresetId(activePresetId) : null),
    [activePresetId],
  );

  const [harness, setHarness] = useState<HarnessPresetBody>(() => {
    const pickable = (candidate: string | null | undefined): candidate is HarnessPresetBody =>
      isHarnessPresetBody(candidate)
      && chipOptions.some((option) => option.harness === candidate && option.disabledReason == null);
    if (pickable(activeRoute?.harness)) return activeRoute!.harness;
    if (pickable(lastRunInHarness)) return lastRunInHarness;
    if (pickable(currentHarness)) return currentHarness;
    return "claude";
  });

  const chooseHarness = useCallback((next: HarnessPresetBody) => {
    lastRunInHarness = next;
    setHarness(next);
  }, []);

  const visiblePresets = useMemo<HarnessPreset[]>(
    () => presets.filter((preset) => harnessPresetMatchesQuery(preset, query)),
    [presets, query],
  );

  const groups = useMemo(() => buildReachableGroups(harness, reach), [harness, reach]);

  const selectedKey = useMemo(() => {
    if (activeRoute) {
      return activeRoute.harness === harness ? reachableKeyFor(groups, activeRoute.source, activeRoute.model) : null;
    }
    if (activePresetId) return null;
    // A plain model on the harness's default account is the native row.
    if (harness === "claude" || harness === "codex") {
      const native = groups.find(
        (group) => group.source.kind === "account" && group.source.instanceId === harness,
      );
      const row = native?.models.find((model) => model.launchModelId === value || model.id === value);
      return row?.key ?? null;
    }
    return null;
  }, [activePresetId, activeRoute, groups, harness, value]);

  const handleRoute = useCallback((group: ReachableGroup, model: ReachableModel) => {
    onSelect(model.launchModelId, adHocPresetIdFor(harness, group, model) ?? undefined);
  }, [harness, onSelect]);

  const handlePreset = useCallback((preset: HarnessPreset) => {
    onSelect(launchModelIdFor(preset.harness, preset.source, preset.model), preset.id);
  }, [onSelect]);

  const presetDisabledReason = useCallback(
    (preset: HarnessPreset) => (mode === "cli" ? cliPresetGateReason(preset.harness) : null),
    [mode],
  );

  return (
    <div data-custom-picker-pane="" className="flex flex-col gap-2 pb-1">
      {visiblePresets.length > 0 ? (
        <section aria-label="Saved" className="flex flex-col">
          <span className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-fg/55">
            Saved
          </span>
          <HarnessPresetList
            presets={visiblePresets}
            activeModelId={value}
            activePresetId={activePresetId}
            onSelect={handlePreset}
            disabledReasonFor={presetDisabledReason}
            {...(catalogScopeKey ? { catalogScopeKey } : {})}
          />
        </section>
      ) : null}

      <section aria-label="Run in" className="flex flex-col gap-1.5">
        <span className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-fg/55">
          Run in
        </span>
        <div className="px-1.5">
          <HarnessChipRow options={chipOptions} selected={harness} onSelect={chooseHarness} />
        </div>
        <ReachableModelList
          groups={groups}
          query={query}
          loading={reach.loading}
          selectedKey={selectedKey}
          onSelect={handleRoute}
          onProxySignIn={(provider) => void reach.proxySignIn(provider)}
          proxySignInAvailable={reach.proxyAvailable}
          proxySigningIn={reach.proxySigningIn}
          requireProxySignIn
          emptyState={
            <>
              {harnessBodyLabel(harness)} has nothing extra to run yet. Sign in to OpenCode Go or Zen, or store an API
              key, under Settings › Providers.
            </>
          }
        />
      </section>

      {onOpenHarnessSettings ? (
        <button
          type="button"
          data-harness-preset-empty-cta="true"
          onClick={onOpenHarnessSettings}
          className="mx-2 mt-1 inline-flex items-center gap-1.5 self-start text-[10.5px] font-medium text-muted-fg/65 hover:text-fg/85"
        >
          <GearSix size={11} />
          {presets.length === 0 ? "Save a custom provider" : "Manage custom providers"}
        </button>
      ) : null}
    </div>
  );
}
