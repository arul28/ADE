import React from "react";

import type { PluginSurfaceOnlyContext } from "../../../../shared/plugins/context";
import {
  PLUGIN_SEARCH_RESULTS_PER_PLUGIN,
  readPluginSearchResults,
  type PluginSearchResult,
} from "../../../../shared/plugins/searchResults";
import { navigateToAppTarget } from "../../../lib/openExternal";
import {
  listInstalledPlugins,
  subscribeToPluginChanges,
  type InstalledPlugin,
} from "../../../lib/pluginRuntimeBridge";
import { isPluginRegistrationDisabled } from "../../../../shared/plugins/disabledContributions";
import { pluginChangeAffects } from "./contributionModel";
import { invokePluginSocketAction, pluginSocketsAvailable } from "./contributionBridge";
import { runPluginSocketAction } from "./pluginActionDispatch";

/**
 * The `searchProviders` engine registration: a plugin answering ⌘K live.
 *
 * The sibling of `usePluginPaletteCommands`, and deliberately shaped like it —
 * same gating discipline, same structural row type, same attribution rule — but
 * answering a different question. That hook asks a plugin what it CAN do, once,
 * from a manifest already in memory. This one asks every plugin what it KNOWS
 * about four letters someone just typed, on every debounce tick, and waits on
 * other processes to answer. Everything below that looks like ceremony is about
 * that difference.
 *
 * **Why this is a renderer feature and not a search-service one.** ADE's own
 * palette results come from `main/services/search`, and the obvious-looking move
 * — give plugins a tenth `SearchDocKind` and let them into the FTS index — is
 * the wrong one, three times over:
 *
 * - `SEARCH_DOC_KINDS` (`shared/types/search.ts`) is a closed nine-kind wire
 *   contract shared by this palette, the `search.*` action domain, the `ade
 *   search` CLI and the TUI. Widening it is a protocol change in four clients to
 *   ship a palette feature in one.
 * - `commandPaletteSearch.tsx` holds two EXHAUSTIVE `Record<SearchDocKind, …>`
 *   maps (`ENTITY_KIND_ORDER`, `ENTITY_KIND_LABEL`). A tenth kind does not
 *   extend them; it breaks them.
 * - The FTS index is written by ADE at ingest time. A plugin's store is the only
 *   truth about a plugin's rows, and it changes when the plugin says so — so an
 *   indexed plugin row would be stale exactly when it mattered, and there is no
 *   ingest hook that could honestly keep it fresh.
 *
 * So providers are queried LIVE and rendered as their own attributed group. That
 * is also what makes the budget below possible: results ADE fetched itself are
 * never held up by a plugin that is thinking.
 *
 * **The budget is the design.** Every enabled plugin's providers are invoked in
 * parallel on each debounced query, each with the same ~300ms wall clock. A
 * provider that has not answered by then is dropped and the palette renders
 * whatever else arrived. A serial fan-out would make the budget N×300ms and turn
 * one slow plugin into a slow palette, which is the failure this whole shape
 * exists to prevent.
 */

/**
 * One palette row, shaped for `CommandPalette`'s own `Command` type.
 *
 * Structural rather than an import of that type, for the reason
 * `PluginPaletteCommand` gives: the palette is a page component and this is
 * plugin plumbing, and coupling them would mean the socket layer could not be
 * tested without mounting a 3000-line dialog.
 */
export type PluginSearchRow = {
  id: string;
  title: string;
  hint: string;
  keywords: string[];
  run: () => void;
};

/** The group contributed results sit under, after the product's own sections. */
export const PLUGIN_SEARCH_GROUP = "Plugin results";

/**
 * Matches `commandPaletteSearch.tsx`'s `SEARCH_DEBOUNCE_MS`.
 *
 * Deliberately the same number rather than a tuned one: plugin rows and ADE's
 * own results answer the same keystroke, and two different debounces would make
 * them arrive on visibly different rhythms — the palette would appear to settle,
 * then move again.
 */
const PLUGIN_SEARCH_DEBOUNCE_MS = 150;

/**
 * Wall clock one provider gets to answer, enforced here and not only by the host.
 *
 * `plugin.invoke` carries `timeoutMs`, and the host clamps and honours it — but
 * an older host ignores the key entirely, and this budget is the difference
 * between a palette that renders and one that appears frozen. Racing locally
 * means the timeout is a property of the palette rather than a favour from
 * whatever host happens to be behind the bridge.
 */
export const PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS = 300;

/**
 * Provider invocations one round may start.
 *
 * The manifest already caps a plugin at two providers, so this only bites on a
 * host answering with a list this build did not parse. It bounds the round's
 * fan-out — the budget above is wall clock for the whole round, and thirty
 * concurrent invokes would spend it on scheduling.
 */
const PLUGIN_SEARCH_PROVIDERS_PER_ROUND = 16;

/**
 * The palette belongs to the window, not to whatever tab is behind it — the same
 * context `usePluginPaletteCommands` dispatches with, for the same reason.
 */
const PALETTE_CONTEXT: PluginSurfaceOnlyContext = { kind: "surface", surface: "app" };

const EMPTY_ROWS: PluginSearchRow[] = [];

/** One provider of one plugin, flattened for the round that queries it. */
type ProviderTarget = {
  pluginId: string;
  /** Display name, falling back to the id — the attribution convention. */
  pluginName: string;
  providerId: string;
  /** The action invoked with `{query}`; defaults to the provider id upstream. */
  action: string;
};

const EMPTY_TARGETS: ProviderTarget[] = [];

/* ── Who can answer ───────────────────────────────────────────────────────── */

type Listener = () => void;

type ProvidersSnapshot = {
  status: "idle" | "loading" | "ready";
  plugins: readonly InstalledPlugin[];
};

const EMPTY_PROVIDERS: ProvidersSnapshot = { status: "idle", plugins: [] };

/**
 * The install list, read once and kept until the host says it changed.
 *
 * The same discipline `useSurfaceContributions`'s stores follow, and for the
 * same reason: nothing loads until a caller passes `active`, and a change event
 * marks the data stale rather than refetching, so a palette that is closed —
 * which is almost always — costs nothing. Module-level rather than per-hook
 * because two palettes (the window's and a future scoped one) must not each hold
 * their own copy of the same answer.
 *
 * Deliberately NOT the socket layer's `sourcesStore`: that one joins every
 * plugin's full manifest, and providers ride the summary precisely so this
 * question can be answered without manifests.
 */
class ProvidersStore {
  private listeners = new Set<Listener>();

  private snapshot: ProvidersSnapshot = EMPTY_PROVIDERS;

  private inflight: Promise<void> | null = null;

  private stale = true;

  private unsubscribe: (() => void) | null = null;

  getSnapshot = (): ProvidersSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  ensureLoaded(): void {
    this.listenForChanges();
    if (!this.stale || this.inflight) return;
    if (!pluginSocketsAvailable()) {
      this.stale = false;
      this.set({ status: "ready", plugins: [] });
      return;
    }
    this.stale = false;
    this.set({ ...this.snapshot, status: "loading" });
    // `listInstalledPlugins` absorbs a missing namespace and a rejected call, so
    // this resolves to an empty registry on a host with no plugin support rather
    // than leaving the palette waiting on a read that will never land.
    this.inflight = listInstalledPlugins()
      .then((plugins) => {
        this.set({ status: "ready", plugins });
      })
      .catch(() => {
        this.set({ status: "ready", plugins: [] });
      })
      .finally(() => {
        this.inflight = null;
      });
  }

  private listenForChanges(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToPluginChanges((event) => {
      if (!pluginChangeAffects("sources", event.kind)) return;
      this.stale = true;
      // Marked stale, never refetched here: a visible palette re-runs
      // `ensureLoaded` on its next render and a closed one picks it up when it
      // opens, which is the same freshness without the churn.
      this.set({ ...this.snapshot, status: "idle" });
    });
  }

  private set(next: ProvidersSnapshot): void {
    if (Object.is(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

const providersStore = new ProvidersStore();

/**
 * Every provider that may be asked, flattened in install order.
 *
 * A disabled plugin is skipped outright — the plugin-level switch is the kill
 * switch, and a switched-off plugin answering a keystroke would be the clearest
 * possible violation of it.
 *
 * A provider the user switched off individually is skipped too. The key is
 * kind-qualified (`search:<id>`) rather than the bare id, because
 * `disabledContributions` also holds socket ids and a provider that merely
 * shares a name with a hidden badge must keep answering — see
 * `shared/plugins/disabledContributions.ts`, which also records that the
 * settings rail does not write these keys yet.
 */
function providerTargets(plugins: readonly InstalledPlugin[]): ProviderTarget[] {
  const targets: ProviderTarget[] = [];
  for (const plugin of plugins) {
    if (plugin.enabled === false) continue;
    for (const provider of plugin.searchProviders ?? []) {
      if (targets.length >= PLUGIN_SEARCH_PROVIDERS_PER_ROUND) return targets;
      const providerId = typeof provider?.id === "string" ? provider.id.trim() : "";
      if (!providerId) continue;
      if (isPluginRegistrationDisabled(plugin.disabledContributions, "search", providerId)) continue;
      const action = typeof provider.action === "string" && provider.action.trim().length > 0
        ? provider.action.trim()
        : providerId;
      targets.push({
        pluginId: plugin.pluginId,
        pluginName: plugin.displayName || plugin.pluginId,
        providerId,
        action,
      });
    }
  }
  return targets;
}

/* ── Asking them ──────────────────────────────────────────────────────────── */

/** Resolved by the budget rather than by the provider. */
const TIMED_OUT = Symbol("plugin-search-timeout");

/**
 * One provider's answer, or none — and there is exactly one way to say "none".
 *
 * A throw, a rejection, a timeout, a shape this build does not recognize and a
 * genuinely empty result all collapse to the same empty array on purpose. One
 * broken plugin must not empty the palette or put a stack trace in front of
 * someone who was looking for a file, and the palette has nothing useful to draw
 * that would distinguish those cases anyway.
 */
async function queryProvider(target: ProviderTarget, query: string): Promise<PluginSearchResult[]> {
  const outcome = await new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS);
    const settle = (value: unknown): void => {
      clearTimeout(timer);
      resolve(value);
    };
    let pending: Promise<unknown>;
    try {
      pending = invokePluginSocketAction(
        target.pluginId,
        target.action,
        { query },
        // Sent as well as raced: a host that reads it stops doing the work,
        // rather than finishing an answer nobody is waiting for.
        { timeoutMs: PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS },
      );
    } catch {
      // A bridge that throws synchronously — no plugin support in this build.
      settle(TIMED_OUT);
      return;
    }
    pending.then(settle, () => settle(TIMED_OUT));
  });
  if (outcome === TIMED_OUT) return [];
  return readPluginSearchResults(outcome);
}

/**
 * Rows for the palette, in declaration order and capped per plugin.
 *
 * Built from the whole round's accumulator on every arrival rather than appended
 * to, so ordering is a property of who DECLARED a provider and not of who
 * answered first — a palette whose rows reshuffle as slower plugins land is the
 * same haunted feeling the generation guard exists to prevent, arriving by a
 * different door.
 */
function buildRows(
  targets: readonly ProviderTarget[],
  byTarget: readonly PluginSearchResult[][],
  query: string,
): PluginSearchRow[] {
  const rows: PluginSearchRow[] = [];
  const usedByPlugin = new Map<string, number>();
  const seenIds = new Set<string>();
  targets.forEach((target, index) => {
    for (const result of byTarget[index] ?? []) {
      const used = usedByPlugin.get(target.pluginId) ?? 0;
      // Per plugin, not per provider: the cap bounds how much of the palette one
      // extension occupies, and a plugin splitting results across its two
      // providers to claim sixteen rows would defeat that.
      if (used >= PLUGIN_SEARCH_RESULTS_PER_PLUGIN) break;
      const id = `plugin-search-${target.pluginId}-${target.providerId}-${result.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      usedByPlugin.set(target.pluginId, used + 1);
      rows.push({
        id,
        title: result.title,
        // The palette renders the hint, so this is the attribution: two plugins
        // may both answer with "Deploy notes" and the row has to say whose. The
        // plugin comes first even when the provider supplied a subtitle — the
        // question a reader has about an unfamiliar row is who put it there.
        hint: result.subtitle
          ? `${target.pluginName} plugin · ${result.subtitle}`
          : `${target.pluginName} plugin`,
        // Keywords never render; they widen what the palette's filter matches
        // on. The QUERY is among them deliberately: the palette filters its
        // commands by substring, and a provider's answer legitimately need not
        // contain the letters typed — "auth" finding "Login flow" is the entire
        // value of asking a plugin. Without this the palette would re-filter,
        // and silently drop, results a provider had already matched.
        keywords: ["plugin", target.pluginId, target.pluginName, query],
        run: () => {
          // The row already knows where it goes: routed through the ordinary
          // navigation target, so it passes the same installed-and-enabled gate
          // a `plugin` deeplink does (`resolvePluginDeeplinkRouting`) and lands
          // on the same addressable URL.
          if (result.navigate) {
            navigateToAppTarget({
              kind: "plugin",
              pluginId: target.pluginId,
              panelId: result.navigate.panelId,
              context: result.navigate.context ?? null,
            });
            return;
          }
          // It does not: ask the provider again, naming the row. This is how a
          // provider does its expensive work at OPEN time — resolving a record,
          // minting a URL — instead of on every keystroke, and whatever navigate
          // verb comes back is honoured by the shared dispatch, identically to a
          // button press.
          void runPluginSocketAction(target.pluginId, target.action, PALETTE_CONTEXT, {
            args: { query, resultId: result.id },
          });
        },
      });
    }
  });
  return rows;
}

/**
 * Live plugin results for the palette's current query.
 *
 * `active` should be the palette's own open state, and `query` its raw input —
 * the debounce lives here so callers cannot forget it. Nothing is read, and no
 * plugin is invoked, while `active` is false or the trimmed query is empty; the
 * palette is mounted for the whole life of the app, so a closed one must cost
 * exactly nothing.
 */
export function usePluginSearchResults(query: string, active: boolean): PluginSearchRow[] {
  const snapshot = React.useSyncExternalStore(providersStore.subscribe, providersStore.getSnapshot);
  const [rows, setRows] = React.useState<PluginSearchRow[]>(EMPTY_ROWS);

  React.useEffect(() => {
    if (!active) return;
    providersStore.ensureLoaded();
  }, [active, snapshot.status]);

  const targets = React.useMemo(
    () => (active ? providerTargets(snapshot.plugins) : EMPTY_TARGETS),
    [active, snapshot.plugins],
  );

  /**
   * Monotonic round counter. A response from a superseded query must never
   * overwrite fresher state — the same guard `useUniversalSearch` keeps, and the
   * bug it prevents is the one that makes a palette feel haunted: rows for two
   * keystrokes ago appearing under the letters you are typing now.
   */
  const roundRef = React.useRef(0);

  React.useEffect(() => {
    // Incremented for EVERY change, including going inactive or empty, so
    // anything already in flight is superseded the moment the question changes.
    const round = ++roundRef.current;
    // Rows answered a question nobody is asking any more. They are cleared
    // rather than kept because the palette's filter would hide them anyway (they
    // carry their own query as a keyword), so retaining them buys no continuity
    // and risks stale rows reappearing if the reader backspaces into them.
    const clear = (): void => setRows((previous) => (previous.length === 0 ? previous : EMPTY_ROWS));
    if (!active || targets.length === 0) {
      clear();
      return;
    }
    const needle = query.trim();
    if (!needle) {
      clear();
      return;
    }
    clear();
    const debounce = setTimeout(() => {
      // One slot per provider, filled as answers land. Started together and
      // never awaited in sequence: the budget below is wall clock for the whole
      // round, and a serial fan-out would make it N × the budget.
      const byTarget: PluginSearchResult[][] = targets.map(() => []);
      for (const [index, target] of targets.entries()) {
        void queryProvider(target, needle).then((results) => {
          if (roundRef.current !== round) return;
          if (results.length === 0) return;
          byTarget[index] = results;
          setRows(buildRows(targets, byTarget, needle));
        });
      }
    }, PLUGIN_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(debounce);
    };
  }, [active, query, targets]);

  return rows;
}
