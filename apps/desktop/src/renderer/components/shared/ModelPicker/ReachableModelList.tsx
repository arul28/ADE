import { memo, useMemo, useState, type ReactNode } from "react";
import { CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { harnessBodyLabel, type HarnessPresetBody } from "../../../../shared/harnessPresets";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import { routeKindLabel } from "../../../../shared/harnessRoutes";
import { cn } from "../../ui/cn";
import { ModelRowLogo, ProviderLogo } from "../ProviderLogos";
import { bodyLogoFamily } from "../../settings/harnesses/presetFacts";
import {
  formatModelLimits,
  type HarnessChipOption,
  type ReachableGroup,
  type ReachableModel,
} from "../../settings/harnesses/harnessReach";
import type { HarnessRouteTestState } from "../../settings/harnesses/useHarnessReach";
import { scoreModelPickerSearch } from "./modelPickerSearch";

/**
 * The shared "what can this harness run" list.
 *
 * One component for the Custom provider wizard and for anything else that has
 * to list what a harness can reach, so two surfaces can never disagree about
 * what a row says: its name, its limits ("1M · 384k"), and a small muted
 * "via ADE proxy" tag when the pairing needs translation. A caller can hang a
 * Test button off each row for a live check.
 *
 * Grouped by source, because the source is the thing you pay: your Claude
 * account, OpenCode Go, a DeepSeek key, a subscription through the proxy. A
 * group shows its first few models and says how many more it has; a search
 * shows every match.
 */

const DEFAULT_GROUP_LIMIT = 6;

export type ReachableModelListProps = {
  groups: readonly ReachableGroup[];
  query: string;
  loading?: boolean;
  selectedKey?: string | null;
  onSelect: (group: ReachableGroup, model: ReachableModel) => void;
  /** Rows a live check can run for (OpenCode sign-ins and stored keys). */
  onTest?: (group: ReachableGroup, model: ReachableModel) => void;
  testStateFor?: (group: ReachableGroup, model: ReachableModel) => HarnessRouteTestState | undefined;
  /** Sign a subscription in to ADE's proxy from its group header. */
  onProxySignIn?: (provider: "claude" | "codex") => void;
  proxySignInAvailable?: boolean;
  proxySigningIn?: "claude" | "codex" | null;
  /** When true a subscription the proxy does not hold yet cannot be picked. */
  requireProxySignIn?: boolean;
  /** Shown when there is nothing to list (after loading, before a search). */
  emptyState?: ReactNode;
  groupLimit?: number;
  /**
   * True when the list is not inside another listbox (the dialog). The picker
   * already wraps its pane in one, and listboxes do not nest.
   */
  standalone?: boolean;
  className?: string;
};

function modelMatches(group: ReachableGroup, model: ReachableModel, query: string): number | null {
  return scoreModelPickerSearch(
    {
      name: model.label,
      shortName: model.id,
      subProvider: group.label,
      family: (model.family ?? group.logoProvider) as ProviderFamily,
      providerDisplayName: group.label,
    },
    query,
  );
}

export const ReachableModelList = memo(function ReachableModelList({
  groups,
  query,
  loading = false,
  selectedKey = null,
  onSelect,
  onTest,
  testStateFor,
  onProxySignIn,
  proxySignInAvailable = false,
  proxySigningIn = null,
  requireProxySignIn = false,
  emptyState,
  groupLimit = DEFAULT_GROUP_LIMIT,
  standalone = false,
  className,
}: ReachableModelListProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const searching = query.trim().length > 0;

  const visible = useMemo(() => {
    if (!searching) return groups.map((group) => ({ group, models: group.models }));
    return groups
      .map((group) => {
        const scored = group.models
          .map((model) => ({ model, score: modelMatches(group, model, query) }))
          .filter((entry): entry is { model: ReachableModel; score: number } => entry.score !== null)
          .sort((a, b) => a.score - b.score);
        return { group, models: scored.map((entry) => entry.model) };
      })
      .filter((entry) => entry.models.length > 0);
  }, [groups, query, searching]);

  if (visible.length === 0) {
    if (loading) {
      return (
        <div className={cn("flex items-center gap-2 px-2.5 py-4 text-[11px] text-muted-fg/60", className)}>
          <CircleNotch size={12} className="animate-spin motion-reduce:animate-none" />
          Looking for models…
        </div>
      );
    }
    return (
      <div className={cn("px-2.5 py-4 text-[11px] leading-relaxed text-muted-fg/60", className)}>
        {searching ? "No model matches your search." : emptyState ?? "Nothing this harness can run yet."}
      </div>
    );
  }

  return (
    <div
      data-reachable-model-list=""
      {...(standalone ? { role: "listbox", "aria-label": "Models" } : {})}
      className={cn("flex flex-col gap-2", className)}
    >
      {visible.map(({ group, models }) => {
        const isExpanded = searching || expanded.has(group.key);
        // A selected row past the fold keeps its group open, so the choice is
        // always on screen.
        const selectedIndex = selectedKey ? models.findIndex((model) => model.key === selectedKey) : -1;
        const limit = isExpanded ? models.length : Math.max(groupLimit, selectedIndex + 1);
        const shown = models.slice(0, limit);
        const hidden = models.length - shown.length;
        const locked = requireProxySignIn && group.needsProxySignIn === true;
        const subscriptionProvider = group.source.kind === "subscription" ? group.source.provider : null;
        return (
          <section key={group.key} data-reachable-group={group.key} aria-label={group.label} className="flex flex-col">
            <header className="flex items-center gap-2 px-2 pb-0.5 pt-1">
              <ProviderLogo family={group.logoProvider} size={12} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10.5px] font-semibold uppercase tracking-[0.04em] text-fg/70">
                  {group.label}
                </span>
                <span className="block truncate text-[10px] leading-snug text-muted-fg/55">{group.detail}</span>
              </span>
              {group.needsProxySignIn && subscriptionProvider && onProxySignIn ? (
                <button
                  type="button"
                  data-reachable-proxy-sign-in={subscriptionProvider}
                  disabled={!proxySignInAvailable || proxySigningIn != null}
                  title={proxySignInAvailable ? undefined : "ADE's proxy cannot run on this machine."}
                  onClick={() => onProxySignIn(subscriptionProvider)}
                  className="shrink-0 rounded border border-fg/[0.12] px-2 py-0.5 text-[10px] font-semibold text-fg/85 hover:bg-fg/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {proxySigningIn === subscriptionProvider ? "Signing in…" : "Sign in"}
                </button>
              ) : null}
            </header>
            <div role="group" aria-label={`${group.label} models`}>
              {shown.map((model) => (
                <ReachableModelRow
                  key={model.key}
                  group={group}
                  model={model}
                  selected={model.key === selectedKey}
                  disabled={locked}
                  onSelect={onSelect}
                  {...(onTest && group.routeSource ? { onTest } : {})}
                  testState={testStateFor?.(group, model)}
                />
              ))}
            </div>
            {hidden > 0 || (isExpanded && !searching && models.length > groupLimit) ? (
              <button
                type="button"
                data-reachable-group-toggle={group.key}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })}
                className="mx-2 mt-0.5 self-start text-[10.5px] font-medium text-muted-fg/65 hover:text-fg/85"
              >
                {hidden > 0 ? `Show ${hidden} more` : "Show fewer"}
              </button>
            ) : null}
            {group.unreachableCount > 0 && isExpanded ? (
              <span className="mx-2 mt-0.5 text-[10px] text-muted-fg/45">
                {group.unreachableCount} more from {group.label} cannot run here.
              </span>
            ) : null}
          </section>
        );
      })}
    </div>
  );
});

/** One test result, shared by the picker rows and the Custom providers list. */
export function RouteTestBadge({ state }: { state: HarnessRouteTestState | undefined }) {
  if (!state) return null;
  if (state.status === "testing") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-fg/60">
        <CircleNotch size={10} className="animate-spin motion-reduce:animate-none" /> Testing
      </span>
    );
  }
  if (state.status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300/85">
        <CheckCircle size={10} weight="fill" />
        Works{state.latencyMs != null ? ` · ${Math.round(state.latencyMs)} ms` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-[140px] items-center gap-1 text-[10px] text-red-300/85" title={state.error}>
      <WarningCircle size={10} weight="fill" />
      <span className="truncate">Failed</span>
    </span>
  );
}

const ReachableModelRow = memo(function ReachableModelRow({
  group,
  model,
  selected,
  disabled,
  onSelect,
  onTest,
  testState,
}: {
  group: ReachableGroup;
  model: ReachableModel;
  selected: boolean;
  disabled: boolean;
  onSelect: (group: ReachableGroup, model: ReachableModel) => void;
  onTest?: (group: ReachableGroup, model: ReachableModel) => void;
  testState: HarnessRouteTestState | undefined;
}) {
  const limits = formatModelLimits(model.contextWindow, model.maxOutputTokens);
  const routeTag = routeKindLabel(model.route);
  return (
    <div
      data-reachable-model={model.key}
      className={cn(
        "group mx-0.5 flex items-center gap-2 rounded-md border px-2 py-1 transition-colors",
        selected
          ? "border-violet-400/30 bg-violet-500/[0.08]"
          : "border-transparent hover:border-fg/[0.08] hover:bg-fg/[0.03]",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={disabled}
        title={disabled ? "Sign this subscription in to ADE's proxy first." : model.id}
        onClick={() => onSelect(group, model)}
        data-reachable-select={model.key}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
      >
        {model.family ? (
          <ModelRowLogo modelFamily={model.family} modelId={model.id} size={13} />
        ) : (
          <span aria-hidden className="inline-block h-[13px] w-[13px] shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-snug text-fg">{model.label}</span>
        {routeTag ? (
          <span
            data-reachable-route-tag=""
            title="ADE starts its local proxy to translate between this harness and the model's endpoint."
            className="shrink-0 rounded-sm bg-fg/[0.05] px-1 py-px text-[9.5px] font-medium leading-none text-muted-fg/70"
          >
            {routeTag}
          </span>
        ) : null}
        {limits ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-fg/50">{limits}</span>
        ) : null}
      </button>
      {onTest ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <RouteTestBadge state={testState} />
          <button
            type="button"
            data-reachable-test={model.key}
            disabled={testState?.status === "testing"}
            onClick={() => onTest(group, model)}
            aria-label={`Test ${model.label}`}
            className={cn(
              "rounded border border-fg/[0.1] px-1.5 py-px text-[10px] font-medium text-fg/75 hover:bg-fg/[0.06] disabled:opacity-45",
              !testState && !selected && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            )}
          >
            Test
          </button>
        </span>
      ) : null}
    </div>
  );
});

/**
 * The harness chips: real provider marks, one row.
 *
 * A chip that cannot be chosen stays visible and says why on hover, so the
 * row answers "where is Cursor" instead of leaving the reader to wonder.
 *
 * The wizard's harness step is its only caller: a model *picker* does not build
 * a pairing, it picks one that was already saved.
 */
export function HarnessChipRow({
  options,
  selected,
  onSelect,
  size = "sm",
  label = "Harness",
}: {
  options: readonly HarnessChipOption[];
  selected: HarnessPresetBody | null;
  onSelect: (harness: HarnessPresetBody) => void;
  size?: "sm" | "md";
  label?: string;
}) {
  const md = size === "md";
  return (
    <div role="radiogroup" aria-label={label} data-harness-chip-row="" className="flex flex-wrap items-center gap-1">
      {options.map(({ harness, disabledReason }) => {
        const active = harness === selected;
        const disabled = disabledReason != null && !active;
        return (
          <button
            key={harness}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={disabled || undefined}
            data-harness-chip={harness}
            title={disabledReason ?? harnessBodyLabel(harness)}
            onClick={() => {
              if (!disabled) onSelect(harness);
            }}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md border font-medium leading-none transition-colors",
              md ? "h-7 px-2.5 text-[11.5px]" : "h-6 px-2 text-[10.5px]",
              active
                ? "border-violet-400/35 bg-violet-500/[0.12] text-fg"
                : "border-fg/[0.08] bg-fg/[0.02] text-fg/75 hover:border-fg/[0.14] hover:text-fg",
              disabled && "cursor-not-allowed opacity-40 hover:border-fg/[0.08] hover:text-fg/75",
            )}
          >
            <ProviderLogo family={bodyLogoFamily(harness)} size={md ? 13 : 11} />
            {/* Unavailable chips shrink to their mark: they are there to be
                explained, not read. */}
            {disabled && !md ? null : harnessChipLabel(harness, !md)}
          </button>
        );
      })}
    </div>
  );
}

function harnessChipLabel(harness: HarnessPresetBody, compact: boolean): string {
  if (compact && harness === "claude") return "Claude";
  if (harness === "codex") return "Codex";
  if (harness === "qwen") return "Qwen";
  if (harness === "copilot") return "Copilot";
  return harnessBodyLabel(harness);
}
