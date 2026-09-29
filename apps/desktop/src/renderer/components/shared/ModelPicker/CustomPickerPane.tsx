import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretRight, GearSix } from "@phosphor-icons/react";
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
 * The picker's Custom tab.
 *
 * Two things live here and they are not equally important. **Saved** Custom
 * providers are one click, and they are what the tab is for: they lead, and an
 * empty list of them says how to make one. **Use another model in a harness** is
 * the ad-hoc half — a harness plus any model it can reach, launched without
 * saving anything — and it is folded away, because it is a long list of pairings
 * (three sources × a dozen models, per harness) that most visits never want.
 *
 * The ad-hoc half deliberately does NOT list a harness's own-account models.
 * Sonnet on your Claude account is already one row in the Claude tab, and
 * repeating it here made "Custom" look like a second, worse copy of every
 * provider tab. What is left is what the other tabs cannot show: another
 * source's models, in a harness of your choosing.
 *
 * A CLI-mode visit keeps the same shape; the CLIs that take no endpoint from a
 * launch (Cursor, Copilot, Kimi) stay visible as disabled chips with the reason.
 */

/** The last ad-hoc harness picked here, for the next time this pane opens. */
let lastRunInHarness: HarnessPresetBody | null = null;

/** The source filter is per harness: OpenCode Go's chip means nothing for Grok. */
type SourceFilter = string | null;

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
  /** The harness the current model runs in; the default ad-hoc pick. */
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

  const pickable = useCallback(
    (candidate: string | null | undefined): candidate is HarnessPresetBody =>
      isHarnessPresetBody(candidate)
      && chipOptions.some((option) => option.harness === candidate && option.disabledReason == null),
    [chipOptions],
  );

  const [harness, setHarness] = useState<HarnessPresetBody>(() => {
    if (pickable(activeRoute?.harness)) return activeRoute!.harness;
    // The harness the surface is on wins over whatever was picked here last
    // time. The old order let a single Codex visit pin Codex for the rest of
    // the session, so a Claude chat opened "Run in" on Codex's models and read
    // as a bug.
    if (pickable(currentHarness)) return currentHarness;
    if (pickable(lastRunInHarness)) return lastRunInHarness;
    return "claude";
  });
  /** Once a chip is pressed here, stop following the surface's harness. */
  const touchedHarnessRef = useRef(false);
  useEffect(() => {
    if (touchedHarnessRef.current) return;
    if (!pickable(currentHarness) || currentHarness === harness) return;
    setHarness(currentHarness);
  }, [currentHarness, harness, pickable]);

  const chooseHarness = useCallback((next: HarnessPresetBody) => {
    lastRunInHarness = next;
    touchedHarnessRef.current = true;
    setHarness(next);
  }, []);

  const visiblePresets = useMemo<HarnessPreset[]>(
    () => presets.filter((preset) => harnessPresetMatchesQuery(preset, query)),
    [presets, query],
  );

  /**
   * The ad-hoc groups: every source EXCEPT the harness's own account.
   *
   * `native` is the harness signed in to itself, which is the provider tab for
   * that harness. Listing it here offered a second row for a model the user
   * already had, one tab to the left.
   */
  const groups = useMemo(
    () => buildReachableGroups(harness, reach).filter((group) => group.kind !== "native"),
    [harness, reach],
  );

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(null);
  // A source belongs to one harness; keep the filter only while it still names
  // a group, so switching harnesses cannot leave the list silently empty.
  const activeSourceFilter = sourceFilter && groups.some((group) => group.key === sourceFilter)
    ? sourceFilter
    : null;
  const visibleGroups = useMemo(
    () => (activeSourceFilter ? groups.filter((group) => group.key === activeSourceFilter) : groups),
    [activeSourceFilter, groups],
  );

  /** Collapsed by default: the saved list is the point, this is the escape hatch. */
  const [adHocOpen, setAdHocOpen] = useState(() => presets.length === 0 || activeRoute != null);
  useEffect(() => {
    // A route is the current choice, so its row has to be on screen.
    if (activeRoute) setAdHocOpen(true);
  }, [activeRoute]);

  const selectedKey = useMemo(() => {
    if (activeRoute) {
      return activeRoute.harness === harness ? reachableKeyFor(groups, activeRoute.source, activeRoute.model) : null;
    }
    // No preset: the surface may still be on a model a stored key makes
    // reachable (`credentialId`), which is one of these rows.
    if (activePresetId) return null;
    for (const group of groups) {
      const row = group.models.find((model) => model.launchModelId === value || model.id === value);
      if (row) return row.key;
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

      <section aria-label="Use another model in a harness" className="flex flex-col">
        <button
          type="button"
          data-custom-adhoc-toggle=""
          aria-expanded={adHocOpen}
          onClick={() => setAdHocOpen((open) => !open)}
          className="mx-2 mt-1 inline-flex items-center gap-1.5 self-start text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-fg/55 hover:text-fg/80"
        >
          <CaretRight
            size={10}
            weight="bold"
            className={adHocOpen ? "rotate-90 transition-transform duration-150" : "transition-transform duration-150"}
          />
          Use another model in a harness…
        </button>

        {adHocOpen ? (
          <div className="flex flex-col gap-1.5 pt-1">
            <div className="px-1.5">
              <HarnessChipRow options={chipOptions} selected={harness} onSelect={chooseHarness} />
            </div>
            {groups.length > 1 ? (
              <div
                role="radiogroup"
                aria-label="Source"
                data-custom-source-filter=""
                className="flex flex-wrap items-center gap-1 px-2"
              >
                <SourceFilterChip label="All sources" active={activeSourceFilter === null} onClick={() => setSourceFilter(null)} />
                {groups.map((group) => (
                  <SourceFilterChip
                    key={group.key}
                    label={group.label}
                    count={group.models.length}
                    active={activeSourceFilter === group.key}
                    onClick={() => setSourceFilter(group.key)}
                  />
                ))}
              </div>
            ) : null}
            <ReachableModelList
              groups={visibleGroups}
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
                  {harnessBodyLabel(harness)} has no other source to run yet. Sign in to OpenCode Go or Zen, or store an
                  API key, under Settings › Providers. Its own models live in the {harnessBodyLabel(harness)} tab.
                </>
              }
            />
          </div>
        ) : null}
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

/** One source's chip. The count is there because that is the whole question. */
function SourceFilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-custom-source-chip={label}
      onClick={onClick}
      className={
        "inline-flex h-5 max-w-[190px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium leading-none transition-colors "
        + (active
          ? "border-violet-400/35 bg-violet-500/[0.12] text-fg"
          : "border-white/[0.08] bg-white/[0.02] text-fg/70 hover:border-white/[0.14] hover:text-fg")
      }
    >
      <span className="min-w-0 truncate">{label}</span>
      {count != null ? <span className="shrink-0 tabular-nums text-muted-fg/55">{count}</span> : null}
    </button>
  );
}
