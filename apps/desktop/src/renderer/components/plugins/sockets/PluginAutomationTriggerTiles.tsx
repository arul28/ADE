import React from "react";

import { invokePluginAction, readPluginCollection } from "../../../lib/pluginRuntimeBridge";
import type {
  PluginAutomationFilterField,
  PluginAutomationTriggerTilePayload,
} from "../../../../shared/plugins/sockets";
import { isRecord, trimmed } from "../../../../shared/plugins/parse";
import { inputCls, labelCls, recessedCls, selectCls } from "../../automations/designTokens";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { SocketIcon } from "./socketUi";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { usePluginSurfaceContributions, useSurfaceContributions } from "./useSurfaceContributions";

/**
 * The `automation-trigger-tile` socket: one plugin, one tile in the rule
 * builder's trigger grid, and the radios/fields/webhook block under it.
 *
 * The tile REPLACES the generic "Plugins" tile for the plugin that declares it
 * (see `PluginAutomationTriggerTilePayload`), which is why the gating helpers
 * live here beside the renderer rather than in the automations tab: the same
 * list that draws a tile is the list `TriggerCard` has to subtract from the
 * generic picker, and two files deriving it apart is how a plugin ends up on
 * screen twice under two different names.
 *
 * Everything a tile shows is DECLARED. There is no per-entity row to publish
 * against a trigger grid — a rule that does not exist yet has no entity — so
 * this reads the manifest contributions for the `automations` surface and
 * nothing else. The one runtime read is a `select` filter's option list, which
 * comes out of the plugin's own collection so the menu is whatever the plugin
 * last synced rather than a second copy ADE maintains.
 */

/** ADE's own Plugins-source accent, for a plugin that declares none of its own. */
const DEFAULT_TILE_ACCENT = "#C58AF9";

/** One plugin's tile, already attributed with the identity that draws it. */
export type PluginAutomationTile = {
  pluginId: string;
  /** The plugin's display name — the tooltip, since the tile shows the plugin's own label. */
  pluginName: string;
  accent: string;
  /**
   * The tile's manifest socket id.
   *
   * Carried because a collection read is addressed by `(pluginId, panelId,
   * collection)` and a tile has no panel: this id stands in for one. Neither
   * transport dispatches on it — the desktop host reads the plugin's data store
   * by collection alone, and the web client serves collection rows out of
   * whatever panel snapshot it already holds — so what matters is that it is
   * stable and belongs to this plugin, which a socket id is and does.
   */
  contributionId: string;
  payload: PluginAutomationTriggerTilePayload;
};

/**
 * Every enabled plugin's declared trigger tile, at most one per plugin.
 *
 * The cap is deliberate rather than defensive. A plugin publishing two tiles
 * would occupy two cells of a five-across grid beside "GitHub" and "Linear",
 * and the second would carry the same triggers under a second name — the exact
 * duplication the socket's own contract forbids one layer up. The first wins,
 * in the host's contribution order, so which one survives is stable.
 */
export function usePluginAutomationTriggerTiles(active = true): PluginAutomationTile[] {
  const contributions = useSurfaceContributions("automations", "automation-trigger-tile", { active });
  const { identities } = usePluginSurfaceContributions("automations", active);
  return React.useMemo(() => {
    const byPlugin = new Map<string, PluginAutomationTile>();
    for (const contribution of contributions) {
      if (byPlugin.has(contribution.pluginId)) continue;
      const identity = identities.get(contribution.pluginId);
      byPlugin.set(contribution.pluginId, {
        pluginId: contribution.pluginId,
        pluginName: identity?.displayName || contribution.pluginId,
        accent: identity?.accent || DEFAULT_TILE_ACCENT,
        contributionId: contribution.id,
        payload: contribution.payload,
      });
    }
    return [...byPlugin.values()];
  }, [contributions, identities]);
}

/**
 * A tint from a plugin's own accent.
 *
 * `color-mix` rather than the hex arithmetic `accentTint` does for the compiled
 * sources, because a compiled source's accent is a literal in ADE's own catalog
 * and a plugin's arrives from a manifest: parsing it as `#rrggbb` produces
 * `rgba(NaN, NaN, NaN)` for every other notation, which paints nothing and says
 * nothing. `color-mix` degrades to the browser ignoring one declaration.
 */
export function pluginTileTint(accent: string, percent: number): string {
  return `color-mix(in srgb, ${accent} ${percent}%, transparent)`;
}

/** The plugin ids that declare a tile — what the generic Plugins tile subtracts. */
export function tilePluginIds(tiles: readonly PluginAutomationTile[]): Set<string> {
  return new Set(tiles.map((tile) => tile.pluginId));
}

/**
 * One tile in the trigger grid: the plugin's icon over the plugin's label.
 *
 * Deliberately the same box as `TriggerCard`'s own source buttons rather than a
 * plugin-shaped one. A trigger grid where ADE's five sources and a plugin's
 * sixth were visibly different controls would tell the reader the plugin's
 * events are a lesser kind of trigger, which is the opposite of what the socket
 * is for. What marks it as the plugin's is the mark and the accent, not the
 * chrome.
 */
export function PluginAutomationTriggerTile({
  tile,
  active,
  onSelect,
}: {
  tile: PluginAutomationTile;
  active: boolean;
  onSelect: () => void;
}) {
  const brandIcons = usePluginBrandIcons();
  return (
    <button
      type="button"
      onClick={onSelect}
      title={`Events from ${tile.pluginName}`}
      data-tour={`plugin:automations.automation-trigger-tile:${tile.pluginId}`}
      aria-pressed={active}
      className={cn(
        "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[10.5px] font-medium transition-colors",
        active
          ? "text-fg"
          : "border-white/[0.06] bg-white/[0.02] text-muted-fg/75 hover:border-white/[0.14] hover:text-fg",
      )}
      style={active
        ? { borderColor: pluginTileTint(tile.accent, 45), background: pluginTileTint(tile.accent, 10) }
        : undefined}
    >
      <span style={{ color: tile.accent, opacity: active ? 1 : 0.8 }}>
        <SocketIcon
          size={15}
          {...(tile.payload.icon ? { name: tile.payload.icon } : {})}
          {...brandIconsProp(brandIcons(tile.pluginId))}
        />
      </span>
      {tile.payload.label}
    </button>
  );
}

/**
 * A radio group, written here because the Automations tab has none.
 *
 * The trigger list is a single choice out of at most eight, each with a line of
 * its own under it — the one shape a `<select>` is actively worse at, since the
 * descriptions would be invisible until the menu opened and gone again the
 * moment it closed. So: real `role="radiogroup"` / `role="radio"` semantics with
 * a roving tabindex, which is what a screen reader and a keyboard both expect
 * from a list of mutually exclusive choices, and which `<button>`s alone are
 * not. Only `designTokens` classes, so it stays the Automations tab's control.
 */
export function PluginAutomationRadioGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: string; label: string; description?: string }[];
  value: string;
  onChange: (next: string) => void;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  // A stored value that matches nothing still has to be focusable, or the group
  // is unreachable from the keyboard on exactly the rule that needs fixing.
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));

  const move = (from: number, delta: number): void => {
    if (options.length === 0) return;
    const next = (from + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.id);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(-1, 1);
    } else if (event.key === "End") {
      event.preventDefault();
      move(0, -1);
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      const option = options[index];
      if (option) onChange(option.id);
    }
  };

  return (
    <div className="space-y-1">
      <span className={labelCls}>{label}</span>
      <div role="radiogroup" aria-label={label} className="grid gap-1">
        {options.map((option, index) => {
          const checked = option.id === value;
          return (
            <button
              key={option.id}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              // Roving: exactly one member of the group is in the tab order, so
              // Tab enters and leaves the whole group rather than stepping
              // through eight controls the arrow keys already navigate.
              tabIndex={index === selectedIndex ? 0 : -1}
              onClick={() => onChange(option.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                checked
                  ? "border-accent/45 bg-accent/[0.08]"
                  : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.14]",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-[3px] h-[10px] w-[10px] shrink-0 rounded-full border",
                  checked ? "border-accent bg-accent" : "border-white/25",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-fg">{option.label}</span>
                {option.description ? (
                  <span className="block text-[10.5px] leading-relaxed text-muted-fg/70">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What a `select` filter's option list resolved to. */
type CollectionState =
  | { status: "loading" }
  | { status: "options"; options: { value: string; label: string }[] }
  /** The degradation the contract promises: a text box, and one line saying why. */
  | { status: "degraded"; reason: string };

/**
 * A row's human label.
 *
 * The row's `value` is the plugin's own object and ADE knows nothing about its
 * shape, so this tries the four names every ported plugin actually uses and
 * falls back to the KEY — which is the thing being stored anyway, so the worst
 * case is a menu of ids rather than a menu of blanks.
 */
export function collectionRowLabel(key: string, value: unknown): string {
  if (typeof value === "string") return trimmed(value) ?? key;
  if (isRecord(value)) {
    for (const field of ["title", "name", "label", "displayName"] as const) {
      const text = trimmed(value[field]);
      if (text) return text;
    }
  }
  return key;
}

/**
 * One `select` filter's options, read from the plugin's collection.
 *
 * Empty and unreadable collapse to the SAME answer on purpose. A menu with
 * nothing in it and a menu that could not be fetched are indistinguishable to
 * the reader, and both leave them unable to write the filter they came here to
 * write; a text box lets them type the id in either case. The web client is the
 * common unreadable case — it serves collection rows out of panel snapshots it
 * has open, and a trigger grid opens no panel — so this is a routine path, not
 * an error path.
 */
function useCollectionOptions(
  pluginId: string,
  panelId: string,
  field: PluginAutomationFilterField,
): CollectionState {
  const collection = field.collection ?? "";
  const [state, setState] = React.useState<CollectionState>(
    collection ? { status: "loading" } : { status: "degraded", reason: "" },
  );

  React.useEffect(() => {
    if (!collection) return;
    let cancelled = false;
    setState({ status: "loading" });
    void readPluginCollection(pluginId, panelId, collection)
      .then((rows) => {
        if (cancelled) return;
        const options = rows
          .map((row) => ({ value: row.key, label: collectionRowLabel(row.key, row.value) }))
          .filter((option) => option.value.length > 0);
        if (options.length === 0) {
          setState({
            status: "degraded",
            reason: `Nothing synced in ${collection} yet — type the value instead.`,
          });
          return;
        }
        setState({ status: "options", options });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          status: "degraded",
          reason: `Couldn't read ${collection} from this plugin — type the value instead.`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [collection, panelId, pluginId]);

  return state;
}

/** A text filter, and the shape a degraded `select` falls back to. */
function FilterTextField({
  field,
  value,
  note,
  onChange,
}: {
  field: PluginAutomationFilterField;
  value: string;
  note?: string;
  onChange: (next: string) => void;
}) {
  // The note and the hint sit OUTSIDE the `<label>` deliberately. A `<label>`
  // wrapping its control contributes its whole text content to the control's
  // accessible name, so a hint left inside would rename the field to "Team
  // Nothing synced in teams yet…" for every screen reader and every test that
  // looks the control up by its label.
  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className={labelCls}>{field.label}</span>
        <input
          className={inputCls}
          value={value}
          spellCheck={false}
          {...(field.placeholder ? { placeholder: field.placeholder } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {note ? <span className="block text-[10.5px] text-amber-200/80">{note}</span> : null}
      {field.hint ? <span className="block text-[10.5px] text-muted-fg/70">{field.hint}</span> : null}
    </div>
  );
}

function FilterSelectField({
  field,
  pluginId,
  panelId,
  value,
  onChange,
}: {
  field: PluginAutomationFilterField;
  pluginId: string;
  panelId: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const state = useCollectionOptions(pluginId, panelId, field);

  if (state.status === "degraded") {
    return (
      <FilterTextField
        field={field}
        value={value}
        {...(state.reason ? { note: state.reason } : {})}
        onChange={onChange}
      />
    );
  }

  const options = state.status === "options" ? state.options : [];
  // A saved value the collection no longer lists keeps an option of its own,
  // for the reason `PluginTriggerPicker` keeps one for an uninstalled plugin:
  // snapping a saved rule to whatever happens to be first would silently
  // rewrite what the user authored.
  const missing = value && !options.some((option) => option.value === value);

  // Hint outside the `<label>` — see {@link FilterTextField}.
  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className={labelCls}>{field.label}</span>
        <select
          className={selectCls}
          disabled={state.status === "loading"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{state.status === "loading" ? "Loading…" : "Any"}</option>
          {missing ? <option value={value}>{`${value} — not in ${field.collection}`}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {field.hint ? <span className="block text-[10.5px] text-muted-fg/70">{field.hint}</span> : null}
    </div>
  );
}

/** One sentence for a tile's webhook, from whatever the plugin's status action answered. */
export function describeTileWebhook(raw: unknown): { summary: string; healthy: boolean } {
  if (!isRecord(raw)) {
    return { summary: "This plugin didn't report a webhook status.", healthy: false };
  }
  const lastError = trimmed(raw.lastError);
  if (lastError) return { summary: `Webhook problem: ${lastError}`, healthy: false };
  const state = trimmed(raw.state);
  if (state === "undeclared") {
    return { summary: "This plugin declares no webhook channel.", healthy: false };
  }
  if (state === "unconfigured") {
    return { summary: "Not registered yet — press Register to receive these events.", healthy: false };
  }
  if (!trimmed(raw.lastReceivedAt)) {
    return { summary: "Registered. Nothing has arrived on it yet.", healthy: true };
  }
  return { summary: "Registered, and events are arriving.", healthy: true };
}

/**
 * The webhook block: a status line and one button.
 *
 * One button, because there is exactly one thing the reader can do about a
 * webhook that is not receiving — register it — and a second control would be
 * asking them to diagnose the plugin's relay from inside a rule builder. The
 * status is re-read after a successful register rather than assumed: the plugin
 * is the authority on whether its own registration took, and a line that
 * flipped to "registered" because the button returned would be ADE guessing.
 */
export function PluginAutomationWebhookRow({
  pluginId,
  statusAction,
  registerAction,
}: {
  pluginId: string;
  statusAction: string;
  registerAction: string;
}) {
  const [summary, setSummary] = React.useState<{ summary: string; healthy: boolean } | null>(null);
  const [registering, setRegistering] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [reloads, setReloads] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    void invokePluginAction(pluginId, statusAction)
      .then((raw) => {
        if (!cancelled) setSummary(describeTileWebhook(raw));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSummary({
          summary: cause instanceof Error && cause.message
            ? `Couldn't read the webhook status: ${cause.message}`
            : "Couldn't read the webhook status.",
          healthy: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, reloads, statusAction]);

  const register = (): void => {
    setRegistering(true);
    setFailure(null);
    void invokePluginAction(pluginId, registerAction)
      .then(() => {
        // Re-read rather than trust the return: see the doc above.
        setReloads((token) => token + 1);
      })
      .catch((cause: unknown) => {
        setFailure(cause instanceof Error && cause.message ? cause.message : "Registering failed.");
      })
      .finally(() => setRegistering(false));
  };

  return (
    <div className={cn(recessedCls, "flex items-center gap-2 px-2.5 py-2")}>
      <span className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-muted-fg/75">
        {failure ?? summary?.summary ?? "Checking this plugin's webhook…"}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0"
        disabled={registering}
        onClick={register}
      >
        {registering ? "Registering…" : "Register"}
      </Button>
    </div>
  );
}

/**
 * Everything under a selected plugin tile: the radios, the filters, the webhook.
 *
 * Values land on the rule through the same `onPatch` the compiled filter
 * editors use, so a tile writes an `AutomationTrigger` and nothing else — there
 * is no plugin-shaped draft anywhere in the builder. `pluginId` is written on
 * every patch rather than once at selection, because a rule saved before the
 * tile existed can hold the pair without ever passing through the tile's own
 * select handler.
 */
export function PluginAutomationTriggerFields({
  tile,
  selectedTrigger,
  filterValues,
  onPatch,
}: {
  tile: PluginAutomationTile;
  selectedTrigger: string;
  filterValues: Record<string, string>;
  onPatch: (patch: { pluginTrigger?: string; pluginFilters?: Record<string, string> }) => void;
}) {
  const setFilter = (key: string, next: string): void => {
    const merged = { ...filterValues };
    // Deleted rather than stored empty: an empty expectation is the absence of
    // a filter, and `projectConfigService` drops it on the way to disk anyway.
    // Keeping it here would make the rule dirty for a change that saves nothing.
    if (next.trim()) merged[key] = next;
    else delete merged[key];
    onPatch({ pluginFilters: merged });
  };

  return (
    <div className="space-y-3">
      <PluginAutomationRadioGroup
        label={`${tile.pluginName} event`}
        options={tile.payload.triggers}
        value={selectedTrigger}
        onChange={(next) => onPatch({ pluginTrigger: next })}
      />

      {tile.payload.filters.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {tile.payload.filters.map((field) => (
            field.kind === "select" ? (
              <FilterSelectField
                key={field.key}
                field={field}
                pluginId={tile.pluginId}
                panelId={tile.contributionId}
                value={filterValues[field.key] ?? ""}
                onChange={(next) => setFilter(field.key, next)}
              />
            ) : (
              <FilterTextField
                key={field.key}
                field={field}
                value={filterValues[field.key] ?? ""}
                onChange={(next) => setFilter(field.key, next)}
              />
            )
          ))}
        </div>
      ) : null}

      {tile.payload.webhook ? (
        <PluginAutomationWebhookRow
          pluginId={tile.pluginId}
          statusAction={tile.payload.webhook.statusAction}
          registerAction={tile.payload.webhook.registerAction}
        />
      ) : null}
    </div>
  );
}
