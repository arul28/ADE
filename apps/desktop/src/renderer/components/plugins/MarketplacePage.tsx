import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as Popover from "@radix-ui/react-popover";
import { ArrowClockwise, CaretDown, CaretRight, CaretUp, DotsThree, DownloadSimple, MagnifyingGlass, Plus, Power, Trash } from "@phosphor-icons/react";

import {
  COLORS,
  RADII,
  SANS_FONT,
  dangerButton,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { builtinSurfaceOwner } from "../../../shared/plugins/builtinSurfaces";
import { restartPlugin, setPluginEnabled, uninstallPlugin } from "../../lib/pluginRuntimeBridge";
import {
  previewPluginTheme,
  revertPluginThemePreview,
  sanitizePluginThemeTokens,
} from "../../lib/pluginTheme";
import { useRootAppStore } from "../../state/appStore";
import { pluginIdentity } from "./pluginIcons";
import { MarketplaceDetailPage } from "./MarketplaceDetailPage";
import { PluginInstallDialog, type InstallDialogTarget } from "./PluginInstallDialog";
import {
  useMarketplaceCatalogue,
  useMarketplaceMachineName,
  usePluginPresence,
  usePluginRepoStars,
} from "./useMarketplace";
import {
  CoverageDots,
  FilterChip,
  InlineNotice,
  ListingSkeleton,
  MarketplaceEmpty,
  OfficialBadge,
  PluginIconTile,
  QuietTag,
  StarCount,
} from "./marketplaceUi";
import {
  DEFAULT_MARKETPLACE_QUERY,
  MARKETPLACE_STATES,
  MARKETPLACE_STATE_LABELS,
  MARKETPLACE_VIEWS,
  MARKETPLACE_VIEW_LABELS,
  describeMarketplaceRegistry,
  deriveMachineCoverage,
  deriveSurfaceFacets,
  deriveTypeFacets,
  featuredListings,
  installStateFor,
  marketplaceFiltersActive,
  marketplaceInstallIndex,
  marketplaceRouteFromPath,
  normalizeMarketplaceQuery,
  queryMarketplace,
  type ListingInstallState,
  type MarketplaceIndexState,
  type MarketplaceInstallIndex,
  type MarketplaceListing,
  type MarketplaceQuery,
  type MarketplaceRegistryState,
  type MarketplaceSort,
  type MarketplaceState,
  type MarketplaceTypeFilter,
  type MarketplaceView,
} from "./marketplaceModel";
import type { PluginSurfaceId } from "../../../shared/plugins/sockets";
import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";

/**
 * The Marketplace.
 *
 * Two views behind one mount. The app shell renders this page for every path
 * under `/marketplace` (machine-level surfaces are conditionally rendered
 * rather than routed — see `App.tsx`), so the gallery/detail switch is read
 * from the path here rather than from `useParams`, which has no route to read.
 *
 * The gallery's shape is a deliberate borrow from a store people already know:
 * a small curated hero row, one line of filters, then a dense list. What is NOT
 * borrowed is the confidence — a store invents social proof, and half this
 * catalogue ships inside the app with no measured installs at all. So every
 * number that is not known renders as nothing, and the freshness of the
 * directory is stated rather than implied.
 *
 * The gallery itself splits again, into Plugins and Themes. A theme is shopped
 * for by looking at it and a plugin by reading what it adds, so one list that
 * mixed them served neither — see {@link ViewSwitch}.
 */


const SORTS: { id: MarketplaceSort; label: string }[] = [
  { id: "installs", label: "Installs" },
  { id: "stars", label: "Stars" },
  { id: "new", label: "New" },
];

export function MarketplacePage() {
  const location = useLocation();
  const route = React.useMemo(() => marketplaceRouteFromPath(location.pathname), [location.pathname]);
  if (route.pluginId) return <MarketplaceDetailPage pluginId={route.pluginId} />;
  return <MarketplaceGallery />;
}

function MarketplaceGallery() {
  const navigate = useNavigate();
  const location = useLocation();
  const catalogue = useMarketplaceCatalogue();
  const installed = useRootAppStore((state) => state.installedPlugins);
  const pluginThemeId = useRootAppStore((state) => state.pluginThemeId);
  const setPluginThemeId = useRootAppStore((state) => state.setPluginThemeId);
  const presence = usePluginPresence(true);
  const machineName = useMarketplaceMachineName();

  const refreshInstalledPlugins = useRootAppStore((state) => state.refreshInstalledPlugins);
  const persistedQuery = useRootAppStore((state) => state.pluginViewState.marketplaceQuery);
  const setMarketplaceQuery = useRootAppStore((state) => state.setMarketplaceQuery);

  /* The filters are the reader's, so they outlive the visit: which of the two
     views they browse, and how they narrow it, is remembered per user in the
     same preference blob every other page filter lives in.

     Local state rather than reading the store directly, because the search box
     belongs to the visit and not to the preference — a Marketplace that opens
     with last week's word in the box looks like a Marketplace with three
     plugins in it. Seeded once, then written back by the effect below. */
  const [query, setQuery] = React.useState<MarketplaceQuery>(
    // Normalized on the way in rather than trusted: what came back was written
    // by an older build, and a field this build added would arrive undefined.
    () => normalizeMarketplaceQuery(persistedQuery),
  );

  /* Written back with the search box emptied, so the word never crosses the
     boundary at all. The store drops it too, but a preference layer should not
     be the only thing standing between a visit's search and next week's. */
  React.useEffect(() => {
    setMarketplaceQuery({ ...query, search: "" });
  }, [query, setMarketplaceQuery]);
  const [installTarget, setInstallTarget] = React.useState<InstallDialogTarget | null>(null);
  /* The quick-action menu's own state, kept on the page rather than in each row
     so a removal confirm survives the row re-rendering under it. */
  const [rowBusy, setRowBusy] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<MarketplaceListing | null>(null);

  /**
   * `?install=<source>` — a candidate handed over from somewhere else.
   *
   * The in-chat approval card's "View in Marketplace" sends the reader here
   * when the plugin has no catalogue page yet: a folder on this machine is in
   * neither the bundled index nor the registry, so there is nothing to link to
   * and the install dialog IS the disclosure page for it.
   *
   * The parameter is consumed on arrival — read once, then replaced out of the
   * URL. Leaving it would reopen the dialog every time the gallery re-rendered
   * under it, and a back-navigation would reopen it against a source the reader
   * has already answered for.
   */
  React.useEffect(() => {
    const params = new URLSearchParams(location.search);
    const handed = params.get("install")?.trim();
    if (!handed) return;
    setInstallTarget({ kind: "url", source: handed });
    params.delete("install");
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}`, { replace: true });
  }, [location.pathname, location.search, navigate]);

  /* A host with no install action is not a broken Marketplace — it is a window
     with no project attached, which is most of what "this button does nothing"
     turned out to mean. The gallery still browses; only the actions go quiet.

     A machine that did not answer for its own registry goes quiet for the same
     reason and a different one: `installed` is EMPTY in that state and does not
     mean empty, so every row would offer an Install for a plugin that may well
     be installed there already. Browsing is still right; acting is not. */
  const registryReady = catalogue.registry.kind === "ready";
  const canManage = catalogue.capabilities.install && registryReady;

  const thisMachineKey = React.useMemo(
    () => presence.rows.find((row) => row.isThisMachine)?.machineKey ?? null,
    [presence.rows],
  );

  /* What this machine has, in the two shapes the state filter asks about.
     Derived from the catalogue as well as the registry because "Updates" is a
     version comparison, not a membership test. */
  const installIndex = React.useMemo(
    () => marketplaceInstallIndex(catalogue.listings, installed),
    [catalogue.listings, installed],
  );

  const visible = React.useMemo(
    () => queryMarketplace(catalogue.listings, query, installIndex),
    [catalogue.listings, installIndex, query],
  );
  const featured = React.useMemo(() => featuredListings(catalogue.listings), [catalogue.listings]);
  // Asked for in the order the gallery draws, so the rows on screen are the
  // ones that spend the lookup budget.
  const stars = usePluginRepoStars(React.useMemo(
    // Only what is drawn: the featured row belongs to the Plugins view, so
    // asking for its stars from inside Themes spends lookups on rows nobody is
    // looking at.
    () => (query.view === "plugins" ? [...featured, ...visible] : visible),
    [featured, query.view, visible],
  ));

  const coverageFor = React.useCallback(
    (listing: MarketplaceListing) => deriveMachineCoverage({
      pluginId: listing.pluginId,
      catalogueVersion: listing.version,
      presence: presence.rows,
      installed,
      thisMachineKey,
    }),
    [installed, presence.rows, thisMachineKey],
  );

  const openListing = React.useCallback(
    (listing: MarketplaceListing) => navigate(`/marketplace/${listing.pluginId}`),
    [navigate],
  );

  /**
   * One plugin operation, from a row.
   *
   * Deliberately the SAME bridge calls the detail page makes — `setPluginEnabled`,
   * `restartPlugin`, `uninstallPlugin` — rather than a shortcut of its own. Every
   * gate those calls answer to still answers: `plugin.uninstall` stays CTO-only
   * and approval-gated in `adeActions`, so an agent-bound context is refused here
   * exactly as it is refused at the CLI, and the refusal arrives as the error
   * this reports. A row menu is a shorter route to an action, never a wider one.
   */
  const runRowAction = React.useCallback(
    async (pluginId: string, work: () => Promise<void>) => {
      setRowBusy(pluginId);
      setRowError(null);
      try {
        await work();
        await refreshInstalledPlugins();
      } catch (cause) {
        setRowError(cause instanceof Error ? cause.message : "That didn’t work.");
      } finally {
        setRowBusy(null);
      }
    },
    [refreshInstalledPlugins],
  );

  const filtersActive = marketplaceFiltersActive(query);

  return (
    <div
      data-tour="plugin:marketplace.page"
      style={{ height: "100%", minHeight: 0, overflow: "auto" }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "26px 24px 48px", display: "grid", gap: 20 }}>
        <GalleryHeader
          search={query.search}
          onSearch={(search) => setQuery((previous) => ({ ...previous, search }))}
          onInstallPlugin={() => setInstallTarget({ kind: "url" })}
          onRefresh={catalogue.refresh}
          refreshing={catalogue.refreshing}
          canRefresh={catalogue.capabilities.browse}
          canManage={canManage}
        />

        <IndexNotice state={catalogue.state} onRefresh={catalogue.refresh} />

        <RegistryNotice state={catalogue.registry} machineName={machineName} />

        {canManage || !registryReady ? null : (
          <InlineNotice tone="muted">
            {machineName
              ? `Open a project on ${machineName} to manage its plugins.`
              : "Open a project to manage plugins on this machine."}
          </InlineNotice>
        )}

        {/* Where a refused removal lands. The uninstall gate answers with a
            role denial rather than silence, and a menu that swallowed it would
            look like a button that does nothing. */}
        {rowError ? <InlineNotice>{rowError}</InlineNotice> : null}

        {catalogue.loading ? (
          <ListingSkeleton rows={5} />
        ) : (
          <>
            <ViewSwitch
              view={query.view}
              onChange={(view) => setQuery((previous) => ({ ...previous, view }))}
            />

            {query.view === "plugins" && featured.length > 0 && !filtersActive ? (
              <FeaturedRow
                listings={featured}
                onOpen={openListing}
                installed={installed}
                stars={stars}
              />
            ) : null}

            <FilterBar
              query={query}
              listings={catalogue.listings}
              index={installIndex}
              onChange={setQuery}
            />

            {visible.length === 0 ? (
              <MarketplaceEmpty
                title="Nothing matches"
                description={query.view === "themes"
                  ? "No theme in the catalogue fits those filters. Clear them, or install one directly from its repository."
                  : "No plugin in the catalogue fits those filters. Clear them, or install one directly from its repository."}
                action={
                  /* Clearing keeps the view. Someone in Themes who clears a
                     search has not asked to be sent back to Plugins. */
                  <button
                    type="button"
                    onClick={() => setQuery((previous) => ({
                      ...DEFAULT_MARKETPLACE_QUERY,
                      view: previous.view,
                    }))}
                    style={outlineButton({ height: 28, fontSize: 11.5 })}
                  >
                    Clear filters
                  </button>
                }
              />
            ) : query.view === "themes" ? (
              <ThemeGrid
                listings={visible}
                installed={installed}
                activeThemeId={pluginThemeId}
                canManage={canManage}
                busyPluginId={rowBusy}
                onOpen={openListing}
                onInstall={(listing) => setInstallTarget({ kind: "listing", listing })}
                onUseTheme={(listing) => void runRowAction(listing.pluginId, async () => {
                  const installedPlugin = installed
                    .find((plugin) => plugin.pluginId === listing.pluginId) ?? null;
                  if (installedPlugin && !installedPlugin.enabled) {
                    await setPluginEnabled(listing.pluginId, true);
                  }
                  setPluginThemeId(listing.pluginId);
                })}
                onStopUsingTheme={() => setPluginThemeId(null)}
              />
            ) : (
              <ul
                data-tour="plugin:marketplace.list"
                style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 2 }}
              >
                {visible.map((listing) => {
                  const installedPlugin = installed
                    .find((plugin) => plugin.pluginId === listing.pluginId) ?? null;
                  return (
                    <ListingRow
                      key={listing.pluginId}
                      listing={listing}
                      state={installStateFor(listing, installed)}
                      coverage={coverageFor(listing)}
                      stars={stars.get(listing.pluginId) ?? null}
                      canManage={canManage}
                      installedPlugin={installedPlugin}
                      busy={rowBusy === listing.pluginId}
                      onOpen={() => openListing(listing)}
                      onInstall={() => setInstallTarget({ kind: "listing", listing })}
                      onToggleEnabled={() => void runRowAction(
                        listing.pluginId,
                        () => setPluginEnabled(listing.pluginId, !(installedPlugin?.enabled ?? false)),
                      )}
                      themeActive={listing.isTheme && pluginThemeId === listing.pluginId}
                      onUseTheme={() => void runRowAction(listing.pluginId, async () => {
                        if (installedPlugin && !installedPlugin.enabled) {
                          await setPluginEnabled(listing.pluginId, true);
                        }
                        setPluginThemeId(listing.pluginId);
                      })}
                      onStopUsingTheme={() => setPluginThemeId(null)}
                      onRestart={() => void runRowAction(
                        listing.pluginId,
                        () => restartPlugin(listing.pluginId),
                      )}
                      onRemove={() => setConfirmRemove(listing)}
                    />
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      <PluginInstallDialog
        target={installTarget}
        onOpenChange={(open) => { if (!open) setInstallTarget(null); }}
        onInstalled={(pluginId) => navigate(`/marketplace/${pluginId}`)}
      />

      {/* The same confirmation the detail page asks for, word for word. A
          shorter route to a removal must not also be a quieter one — the
          Linear line especially, since that removal deletes credentials. */}
      <LaneDialogShell
        open={confirmRemove !== null}
        onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}
        title={confirmRemove ? `Remove ${confirmRemove.displayName}?` : "Remove this plugin?"}
        description="Its tabs, panels and commands disappear from this machine. Anything it stored is deleted with it."
        widthClassName="w-[min(460px,calc(100vw-1rem))]"
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={() => setConfirmRemove(null)}
              style={outlineButton({ height: 30, fontSize: 12 })}
            >
              Keep it
            </button>
            <button
              type="button"
              data-tour="plugin:marketplace.row-uninstall-confirm"
              onClick={() => {
                const target = confirmRemove;
                setConfirmRemove(null);
                if (target) void runRowAction(target.pluginId, async () => {
                  await uninstallPlugin(target.pluginId);
                  if (pluginThemeId === target.pluginId) setPluginThemeId(null);
                });
              }}
              style={dangerButton({ height: 30, fontSize: 12 })}
            >
              Remove
            </button>
          </div>
        }
      >
        {confirmRemove?.pluginId === builtinSurfaceOwner("linear").ownerPluginId ? (
          <p style={{ margin: "0 0 8px", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary, lineHeight: 1.6 }}>
            This disconnects Linear. You will sign in again if you reinstall it.
          </p>
        ) : null}
        <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
          Other machines keep their own copy. You can install it again at any time.
        </p>
      </LaneDialogShell>
    </div>
  );
}

/* ── Header ─────────────────────────────────────────────────────────────── */

function GalleryHeader({
  search,
  onSearch,
  onInstallPlugin,
  onRefresh,
  refreshing,
  canRefresh,
  canManage,
}: {
  search: string;
  onSearch: (value: string) => void;
  onInstallPlugin: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  canRefresh: boolean;
  canManage: boolean;
}) {
  return (
    <header style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <h1
          style={{
            margin: 0,
            minWidth: 0,
            fontFamily: SANS_FONT,
            fontSize: 19,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            color: COLORS.textPrimary,
          }}
        >
          Marketplace
        </h1>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {canRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title="Check the directory for new plugins"
              data-tour="plugin:marketplace.refresh"
              style={{
                ...outlineButton({ height: 30, padding: "0 10px", fontSize: 11.5 }),
                opacity: refreshing ? 0.6 : 1,
              }}
            >
              <ArrowClockwise size={13} weight="regular" aria-hidden />
              {refreshing ? "Checking…" : "Refresh"}
            </button>
          ) : null}
          {canManage ? (
            <button
              type="button"
              onClick={onInstallPlugin}
              data-tour="plugin:marketplace.install-from-url"
              style={primaryButton({ height: 30, fontSize: 11.5 })}
            >
              {/* Not "Install from URL". The dialog behind this has always taken
                  a folder on this machine as well — a plugin someone just wrote
                  installs from here — and the URL-only label is why a user with
                  one on disk read the Marketplace as having no way to take it.
                  The `data-tour` id stays: the product tour points at it. */}
              <Plus size={13} weight="bold" aria-hidden />
              Install plugin
            </button>
          ) : null}
        </div>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 34,
          padding: "0 10px",
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.borderMuted}`,
          borderRadius: RADII.md,
        }}
      >
        <MagnifyingGlass size={14} weight="regular" color={COLORS.textDim} aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search plugins"
          aria-label="Search plugins"
          data-tour="plugin:marketplace.search"
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            fontFamily: SANS_FONT,
            fontSize: 12.5,
            color: COLORS.textPrimary,
            background: "transparent",
            border: "none",
            outline: "none",
          }}
        />
      </label>
    </header>
  );
}

/**
 * The one place the page talks about the directory itself.
 *
 * Only rendered when there is something the reader would otherwise be misled
 * about: a fetch that failed, or a build with no directory at all. A healthy
 * fetch says nothing, because "up to date" is the assumption.
 */
function IndexNotice({
  state,
  onRefresh,
}: {
  state: MarketplaceIndexState;
  onRefresh: () => void;
}) {
  if (state.kind === "live") return null;
  if (state.kind === "unsupported") {
    return (
      <InlineNotice tone="muted">
        This build browses the plugins that ship with ADE. The full directory needs a newer version.
      </InlineNotice>
    );
  }
  return (
    <InlineNotice
      action={
        <button type="button" onClick={onRefresh} style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11 })}>
          Try again
        </button>
      }
    >
      Couldn’t reach the plugin directory — showing the plugins that ship with ADE.
    </InlineNotice>
  );
}

/**
 * The one place the page talks about the MACHINE.
 *
 * Separate from {@link IndexNotice}, which talks about the directory. The two
 * are different facts and fail independently, and folding them into one line
 * produced the sentence this page must never say: "no plugins", about a machine
 * nobody managed to ask.
 *
 * Silent while the registry is good or still loading — see
 * `describeMarketplaceRegistry`.
 */
function RegistryNotice({
  state,
  machineName,
}: {
  state: MarketplaceRegistryState;
  machineName: string | null;
}) {
  const message = describeMarketplaceRegistry({ state, machineName });
  if (!message) return null;
  return <InlineNotice tone="muted">{message}</InlineNotice>;
}

/* ── Featured ───────────────────────────────────────────────────────────── */

function FeaturedRow({
  listings,
  onOpen,
  installed,
  stars,
}: {
  listings: readonly MarketplaceListing[];
  onOpen: (listing: MarketplaceListing) => void;
  installed: readonly InstalledPlugin[];
  stars: ReadonlyMap<string, number>;
}) {
  return (
    <section data-tour="plugin:marketplace.featured" style={{ display: "grid", gap: 10 }}>
      <h2
        style={{
          margin: 0,
          fontFamily: SANS_FONT,
          fontSize: 11,
          fontWeight: 600,
          color: COLORS.textMuted,
        }}
      >
        Featured
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fit, minmax(220px, 1fr))`,
          gap: 10,
        }}
      >
        {listings.map((listing) => {
          const identity = pluginIdentity(listing);
          const state = installStateFor(listing, installed);
          return (
            <button
              key={listing.pluginId}
              type="button"
              onClick={() => onOpen(listing)}
              className="hover:bg-fg/[0.03]"
              style={{
                display: "grid",
                gap: 9,
                padding: 14,
                textAlign: "left",
                background: "transparent",
                border: `1px solid ${COLORS.borderMuted}`,
                borderRadius: RADII.lg,
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                <PluginIconTile identity={identity} size={30} label={listing.displayName} />
                <span
                  style={{
                    fontFamily: SANS_FONT,
                    fontSize: 13,
                    fontWeight: 600,
                    color: COLORS.textPrimary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {listing.displayName}
                </span>
                {/* The same word the list rows use: a plugin that is turned off
                    or has an update waiting is not simply "Installed". */}
                {state.kind !== "available" ? (
                  <QuietTag tone={state.kind === "update" ? "warning" : "muted"}>
                    {installActionLabel(state)}
                  </QuietTag>
                ) : null}
              </span>
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 11.5,
                  color: COLORS.textSecondary,
                  lineHeight: 1.5,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {listing.description}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {listing.official ? <OfficialBadge /> : null}
                <StarCount stars={stars.get(listing.pluginId) ?? null} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ── View switch ────────────────────────────────────────────────────────── */

/**
 * Plugins or Themes.
 *
 * A switch rather than a fourth chip, because the two are not narrower and
 * wider versions of one list: a theme is judged by looking at it and a plugin
 * by reading what it adds, so they get different filters and a different
 * layout. The old "All" chip put ten colour packages in front of everyone who
 * came to find an integration, and "Themes" beside it implied All contained
 * them — which it did, and which is the thing being fixed.
 *
 * Radiogroup semantics: exactly one is always chosen, and arrow keys move
 * between them the way they do on the sort control beside it.
 */
function ViewSwitch({
  view,
  onChange,
}: {
  view: MarketplaceView;
  onChange: (view: MarketplaceView) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Marketplace view"
      data-tour="plugin:marketplace.view"
      style={{
        display: "inline-flex",
        alignSelf: "start",
        gap: 2,
        padding: 2,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 9,
      }}
    >
      {MARKETPLACE_VIEWS.map((candidate) => {
        const active = view === candidate;
        return (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(candidate)}
            data-tour={`plugin:marketplace.view-${candidate}`}
            style={{
              height: 24,
              padding: "0 12px",
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              fontWeight: active ? 600 : 500,
              color: active ? COLORS.textPrimary : COLORS.textMuted,
              background: active ? "color-mix(in srgb, var(--color-fg) 8%, transparent)" : "transparent",
              border: "none",
              borderRadius: 7,
              cursor: "pointer",
            }}
          >
            {MARKETPLACE_VIEW_LABELS[candidate]}
          </button>
        );
      })}
    </div>
  );
}

/* ── Filters ────────────────────────────────────────────────────────────── */

/**
 * Two axes and a sort.
 *
 * The type chips are multi-select and the state filter is not, and that split
 * is not a style choice: "Integrations and Tools" is a question with an answer,
 * where "Installed and Updates" is just Updates and "Official and Community" is
 * everything. So type ORs within itself and state picks one, with a second
 * press on the chosen chip clearing it.
 *
 * Every count is scoped to the OTHER axes but never to its own, so no chip can
 * make its neighbours vanish. A bar that can only ever be narrowed is a
 * dead-end, and the reader has no way to tell a zero from a chip that is gone.
 */
function FilterBar({
  query,
  listings,
  index,
  onChange,
}: {
  query: MarketplaceQuery;
  /** The whole catalogue: the counts are of what a chip WOULD show. */
  listings: readonly MarketplaceListing[];
  index: MarketplaceInstallIndex;
  onChange: React.Dispatch<React.SetStateAction<MarketplaceQuery>>;
}) {
  const typeFacets = React.useMemo(
    () => deriveTypeFacets(listings, query, index),
    [index, listings, query],
  );
  const surfaceFacets = React.useMemo(
    () => deriveSurfaceFacets(listings, query, index),
    [index, listings, query],
  );
  /* Counted against every axis except state itself — the same rule the type
     and surface facets follow, computed through the same query so a count can
     never mean something the list does not. */
  const stateCounts = React.useMemo(() => {
    const scoped = queryMarketplace(listings, { ...query, state: "all" }, index);
    return {
      installed: scoped.filter((listing) => index.installed.has(listing.pluginId)).length,
      updates: scoped.filter((listing) => index.updatable.has(listing.pluginId)).length,
      official: scoped.filter((listing) => listing.official).length,
      community: scoped.filter((listing) => !listing.official).length,
    } satisfies Record<Exclude<MarketplaceState, "all">, number>;
  }, [index, listings, query]);

  const toggleType = (type: MarketplaceTypeFilter) => onChange((previous) => ({
    ...previous,
    types: previous.types.includes(type)
      ? previous.types.filter((entry) => entry !== type)
      : [...previous.types, type],
  }));

  const chooseState = (state: Exclude<MarketplaceState, "all">) => onChange((previous) => ({
    ...previous,
    state: previous.state === state ? "all" : state,
  }));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        data-tour="plugin:marketplace.filters"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          paddingBottom: 2,
        }}
      >
        {query.view === "plugins" ? (
          <>
            <span role="group" aria-label="Filter by type" style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
              {typeFacets.map((facet) => (
                <FilterChip
                  key={facet.type}
                  label={facet.label}
                  count={facet.total}
                  active={query.types.includes(facet.type)}
                  onClick={() => toggleType(facet.type)}
                  tour={`plugin:marketplace.type-${facet.type}`}
                />
              ))}
            </span>

            <span
              aria-hidden
              style={{ width: 1, height: 16, background: COLORS.borderMuted, margin: "0 2px" }}
            />

            <span role="group" aria-label="Filter by state" style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
              {MARKETPLACE_STATES.map((state) => (
                <FilterChip
                  key={state}
                  label={MARKETPLACE_STATE_LABELS[state]}
                  count={stateCounts[state]}
                  active={query.state === state}
                  onClick={() => chooseState(state)}
                  tour={`plugin:marketplace.state-${state}`}
                />
              ))}
            </span>
          </>
        ) : null}

        <span style={{ flex: 1 }} />
        <span
          role="radiogroup"
          aria-label="Sort plugins"
          style={{
            display: "inline-flex",
            gap: 2,
            padding: 2,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: 9,
          }}
        >
          {SORTS.map((sort) => {
            const active = query.sort === sort.id;
            const Arrow = query.sortDir === "asc" ? CaretUp : CaretDown;
            return (
              <span
                key={sort.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  height: 22,
                  paddingLeft: 9,
                  paddingRight: active ? 2 : 9,
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  fontWeight: active ? 600 : 500,
                  color: active ? COLORS.textPrimary : COLORS.textMuted,
                  background: active ? "color-mix(in srgb, var(--color-fg) 8%, transparent)" : "transparent",
                  borderRadius: 7,
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onChange((previous) => ({
                    ...previous,
                    sort: sort.id,
                    sortDir: previous.sort === sort.id ? previous.sortDir : "desc",
                  }))}
                  data-tour={`plugin:marketplace.sort-${sort.id}`}
                  style={{
                    padding: 0,
                    font: "inherit",
                    fontWeight: "inherit",
                    color: "inherit",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  {sort.label}
                </button>
                {active ? (
                  <button
                    type="button"
                    aria-label={query.sortDir === "asc" ? "Sort descending" : "Sort ascending"}
                    onClick={() => onChange((previous) => ({
                      ...previous,
                      sort: sort.id,
                      sortDir: previous.sortDir === "asc" ? "desc" : "asc",
                    }))}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      marginLeft: 2,
                      color: "inherit",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    <Arrow size={10} weight="bold" aria-hidden />
                  </button>
                ) : null}
              </span>
            );
          })}
        </span>
      </div>

      {query.view === "plugins" && surfaceFacets.length > 0 ? (
        <SurfaceFacets
          facets={surfaceFacets}
          selected={query.surfaces}
          onToggle={(surface) => onChange((previous) => ({
            ...previous,
            surfaces: previous.surfaces.includes(surface)
              ? previous.surfaces.filter((entry) => entry !== surface)
              : [...previous.surfaces, surface],
          }))}
        />
      ) : null}
    </div>
  );
}

/**
 * "Adds to…" — which core surfaces a plugin extends.
 *
 * Collapsed by default because it is the third question a reader asks, not the
 * first, and an eight-chip row above the list buries the two axes that matter.
 * It opens on its own when a restored filter has something selected: a filter
 * narrowing the list from inside a closed section is the one state this must
 * never be in.
 */
function SurfaceFacets({
  facets,
  selected,
  onToggle,
}: {
  facets: ReturnType<typeof deriveSurfaceFacets>;
  selected: readonly PluginSurfaceId[];
  onToggle: (surface: PluginSurfaceId) => void;
}) {
  const [open, setOpen] = React.useState(() => selected.length > 0);
  const Caret = open ? CaretDown : CaretRight;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        data-tour="plugin:marketplace.facets-toggle"
        style={{
          display: "inline-flex",
          alignItems: "center",
          alignSelf: "start",
          gap: 5,
          padding: 0,
          fontFamily: SANS_FONT,
          fontSize: 11,
          fontWeight: 500,
          color: COLORS.textMuted,
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        <Caret size={11} weight="bold" aria-hidden />
        Adds to…
        {!open && selected.length > 0 ? (
          <span style={{ color: COLORS.textDim, fontWeight: 400 }}>{selected.length}</span>
        ) : null}
      </button>

      {open ? (
        <div
          role="group"
          aria-label="Filter by what a plugin adds to"
          data-tour="plugin:marketplace.facets"
          style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
        >
          {facets.map((facet) => (
            <FilterChip
              key={facet.surface}
              label={facet.label}
              count={facet.total}
              active={selected.includes(facet.surface)}
              onClick={() => onToggle(facet.surface)}
              tour={`plugin:marketplace.facet-${facet.surface}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Themes ─────────────────────────────────────────────────────────────── */

/**
 * The Themes view.
 *
 * A grid rather than a list, because the only useful description of a theme is
 * the theme, and a one-line row leaves nowhere to show it. The verbs are the
 * detail page's own — Preview theme, Use theme, Stop using — so the two screens
 * teach one vocabulary rather than two.
 *
 * One preview at a time, held here rather than per card: a preview repaints the
 * WHOLE window, so two cards each believing they are previewing would leave a
 * reader with a colour scheme neither of them owns. Escape ends it, so does
 * leaving the view — the grid's own unmount reverts.
 */
function ThemeGrid({
  listings,
  installed,
  activeThemeId,
  canManage,
  busyPluginId,
  onOpen,
  onInstall,
  onUseTheme,
  onStopUsingTheme,
}: {
  listings: readonly MarketplaceListing[];
  installed: readonly InstalledPlugin[];
  activeThemeId: string | null;
  canManage: boolean;
  busyPluginId: string | null;
  onOpen: (listing: MarketplaceListing) => void;
  onInstall: (listing: MarketplaceListing) => void;
  onUseTheme: (listing: MarketplaceListing) => void;
  onStopUsingTheme: () => void;
}) {
  const baseTheme = useRootAppStore((state) => state.theme);
  const [previewing, setPreviewing] = React.useState<MarketplaceListing | null>(null);

  const stopPreview = React.useCallback(() => {
    revertPluginThemePreview();
    setPreviewing(null);
  }, []);

  const startPreview = React.useCallback((listing: MarketplaceListing) => {
    if (!listing.themeTokens) return;
    previewPluginTheme({
      pluginId: listing.pluginId,
      displayName: listing.displayName,
      tokens: sanitizePluginThemeTokens(listing.themeTokens).tokens,
    });
    setPreviewing(listing);
  }, []);

  // Escape ends the preview anywhere in the view. Capture phase so a focused
  // search box cannot swallow it.
  React.useEffect(() => {
    if (!previewing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stopPreview();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [previewing, stopPreview]);

  // Leaving the view ends the preview. A preview that outlived the grid would
  // be indistinguishable from an applied theme, with no control to undo it.
  React.useEffect(() => () => {
    revertPluginThemePreview();
  }, []);

  return (
    <>
      <ul
        data-tour="plugin:marketplace.themes"
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        {listings.map((listing) => (
          <ThemeCard
            key={listing.pluginId}
            listing={listing}
            baseTheme={baseTheme === "light" ? "light" : "dark"}
            state={installStateFor(listing, installed)}
            applied={activeThemeId === listing.pluginId}
            previewing={previewing?.pluginId === listing.pluginId}
            canManage={canManage}
            busy={busyPluginId === listing.pluginId}
            onOpen={() => onOpen(listing)}
            onInstall={() => onInstall(listing)}
            onPreview={() => startPreview(listing)}
            onStopPreview={stopPreview}
            onUse={() => onUseTheme(listing)}
            onStopUsing={onStopUsingTheme}
          />
        ))}
      </ul>

      {previewing ? (
        <ThemePreviewPill
          displayName={previewing.displayName}
          canApply={installStateFor(previewing, installed).kind !== "available"
            && activeThemeId !== previewing.pluginId}
          onApply={() => {
            onUseTheme(previewing);
            stopPreview();
          }}
          onRevert={stopPreview}
        />
      ) : null}
    </>
  );
}

function ThemeCard({
  listing,
  baseTheme,
  state,
  applied,
  previewing,
  canManage,
  busy,
  onOpen,
  onInstall,
  onPreview,
  onStopPreview,
  onUse,
  onStopUsing,
}: {
  listing: MarketplaceListing;
  baseTheme: "light" | "dark";
  state: ListingInstallState;
  applied: boolean;
  previewing: boolean;
  canManage: boolean;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onPreview: () => void;
  onStopPreview: () => void;
  onUse: () => void;
  onStopUsing: () => void;
}) {
  /* The swatches are the card. Sanitized here rather than trusted, because the
     same rule the theme engine enforces has to hold before a colour is painted
     into the page's own chrome: a value that is not an ADE palette colour is
     dropped, not rendered. */
  const swatches = React.useMemo(() => {
    const sanitized = sanitizePluginThemeTokens(listing.themeTokens);
    return Object.entries(sanitized.tokens[baseTheme] ?? {}).slice(0, 6);
  }, [baseTheme, listing.themeTokens]);

  const installedHere = state.kind !== "available";

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        data-tour={`plugin:marketplace.theme-${listing.pluginId}`}
        className="hover:bg-fg/[0.03]"
        style={{
          display: "grid",
          gap: 10,
          padding: 12,
          border: `1px solid ${applied ? COLORS.border : COLORS.borderMuted}`,
          borderRadius: RADII.md,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", gap: 4 }} aria-hidden>
          {swatches.map(([name, value]) => (
            <span
              key={name}
              title={name}
              style={{
                flex: 1,
                height: 30,
                borderRadius: RADII.sm,
                background: value,
                border: `1px solid ${COLORS.borderMuted}`,
              }}
            />
          ))}
        </span>

        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 12.5,
                fontWeight: 600,
                color: COLORS.textPrimary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {listing.displayName}
            </span>
            {listing.official ? <OfficialBadge /> : null}
            {applied ? <QuietTag>In use</QuietTag> : null}
            {state.kind === "update" ? <QuietTag tone="warning">Update</QuietTag> : null}
          </span>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              color: COLORS.textDim,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {listing.official ? listing.author : listing.description || listing.author}
          </span>
        </span>

        <span
          style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
          onClick={(event) => event.stopPropagation()}
        >
          {/* Preview works before installing, exactly as it does on the detail
              page: painting the window costs nothing and is the only way to
              judge a theme. */}
          <button
            type="button"
            onClick={previewing ? onStopPreview : onPreview}
            disabled={listing.themeTokens === null}
            data-tour={`plugin:marketplace.theme-preview-${listing.pluginId}`}
            style={{
              ...outlineButton({ height: 26, padding: "0 10px", fontSize: 11 }),
              opacity: listing.themeTokens === null ? 0.5 : 1,
            }}
          >
            {previewing ? "Stop preview" : "Preview theme"}
          </button>

          {applied ? (
            <button
              type="button"
              onClick={onStopUsing}
              data-tour={`plugin:marketplace.theme-stop-${listing.pluginId}`}
              style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
            >
              Stop using
            </button>
          ) : installedHere && canManage ? (
            <button
              type="button"
              onClick={onUse}
              disabled={busy}
              data-tour={`plugin:marketplace.theme-use-${listing.pluginId}`}
              style={{
                ...primaryButton({ height: 26, padding: "0 10px", fontSize: 11 }),
                opacity: busy ? 0.6 : 1,
              }}
            >
              Use theme
            </button>
          ) : canManage ? (
            <button
              type="button"
              onClick={onInstall}
              data-tour={`plugin:marketplace.theme-install-${listing.pluginId}`}
              style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
            >
              <DownloadSimple size={12} weight="bold" aria-hidden />
              Install
            </button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/**
 * The persistent marker for a running preview.
 *
 * Fixed to the viewport rather than to a card, because the preview repaints the
 * whole window and a mode you can scroll away from is a mode you forget you are
 * in. It is what stops "why do my colours look wrong" being a bug report.
 */
function ThemePreviewPill({
  displayName,
  canApply,
  onApply,
  onRevert,
}: {
  displayName: string;
  canApply: boolean;
  onApply: () => void;
  onRevert: () => void;
}) {
  return (
    <div
      role="status"
      data-tour="plugin:marketplace.theme-grid-pill"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 20,
        transform: "translateX(-50%)",
        zIndex: 60,
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 8px 7px 14px",
        background: "var(--color-card)",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 999,
        boxShadow: "var(--shadow-panel)",
      }}
    >
      <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary, whiteSpace: "nowrap" }}>
        Previewing {displayName} — Esc to revert
      </span>
      {canApply ? (
        <button type="button" onClick={onApply} style={primaryButton({ height: 24, padding: "0 10px", fontSize: 11 })}>
          Use theme
        </button>
      ) : null}
      <button
        type="button"
        onClick={onRevert}
        style={{ ...outlineButton({ height: 24, padding: "0 10px", fontSize: 11 }), background: "transparent" }}
      >
        Revert
      </button>
    </div>
  );
}

/* ── Row ────────────────────────────────────────────────────────────────── */

function installActionLabel(state: ListingInstallState): string {
  switch (state.kind) {
    case "update":
      return "Update";
    case "installed":
      return "Installed";
    case "disabled":
      return "Turned off";
    case "available":
    default:
      return "Install";
  }
}

function ListingRow({
  listing,
  state,
  coverage,
  stars,
  canManage,
  installedPlugin,
  busy,
  onOpen,
  onInstall,
  onToggleEnabled,
  themeActive,
  onUseTheme,
  onStopUsingTheme,
  onRestart,
  onRemove,
}: {
  listing: MarketplaceListing;
  state: ListingInstallState;
  coverage: ReturnType<typeof deriveMachineCoverage>;
  stars: number | null;
  canManage: boolean;
  /** Null for a plugin the catalogue lists but this machine does not have. */
  installedPlugin: InstalledPlugin | null;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onToggleEnabled: () => void;
  themeActive: boolean;
  onUseTheme: () => void;
  onStopUsingTheme: () => void;
  onRestart: () => void;
  onRemove: () => void;
}) {
  const identity = pluginIdentity(listing);
  // A row whose install cannot run does not offer one. The page says why once,
  // at the top, rather than every row having to explain itself.
  const actionable = canManage && (state.kind === "available" || state.kind === "update");
  /* The quick-action menu, controlled rather than trigger-driven, because the
     row opens it two ways: the kebab, and a right-click anywhere on the row.
     Both anchor on the kebab, so the menu appears in the same place either way
     — a context menu that lands under the pointer on one route and at the row's
     edge on the other reads as two different menus. */
  const [menuOpen, setMenuOpen] = React.useState(false);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        onContextMenu={canManage ? (event) => {
          event.preventDefault();
          setMenuOpen(true);
        } : undefined}
        data-tour={`plugin:marketplace.row-${listing.pluginId}`}
        className="hover:bg-fg/[0.03]"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "11px 12px",
          border: `1px solid ${COLORS.borderMuted}`,
          borderRadius: RADII.md,
          cursor: "pointer",
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <PluginIconTile identity={identity} size={30} label={listing.displayName} />

        <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 12.5,
                fontWeight: 600,
                color: COLORS.textPrimary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {listing.displayName}
            </span>
            {/* Official says who published it, so the author column would be
                the same word again. Community rows keep theirs — that is the
                only place the name carries information. */}
            {listing.official ? <OfficialBadge /> : (
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, whiteSpace: "nowrap" }}>
                {listing.author}
              </span>
            )}
            {listing.isTheme ? <QuietTag>Theme</QuietTag> : null}
            {state.kind === "update" ? <QuietTag tone="warning">Update</QuietTag> : null}
          </span>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              color: COLORS.textMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {listing.description || "No description."}
          </span>
        </span>

        <span style={{ display: "inline-flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
          <StarCount stars={stars} />
          <CoverageDots rows={coverage} />
          {canManage ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (actionable) onInstall();
                else onOpen();
              }}
              data-tour={`plugin:marketplace.action-${listing.pluginId}`}
              style={{
                ...(actionable
                  ? outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })
                  : {
                    ...outlineButton({ height: 26, padding: "0 10px", fontSize: 11 }),
                    background: "transparent",
                    border: "1px solid transparent",
                    color: COLORS.textDim,
                  }),
                minWidth: 70,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {state.kind === "update" ? <ArrowClockwise size={12} weight="bold" aria-hidden /> : null}
                {state.kind === "available" ? <DownloadSimple size={12} weight="bold" aria-hidden /> : null}
                {installActionLabel(state)}
              </span>
            </button>
          ) : (
            /* Nothing here can be pressed on a machine that cannot manage
               plugins, so nothing here looks like it can. A button reading
               "Install" that only opens the detail page — where the Install
               button is absent — is the one thing this slot must not be. What
               is left is a plain status word, and "available" has no status
               worth a word. */
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 70,
                height: 26,
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: COLORS.textDim,
              }}
            >
              {state.kind === "available" ? "" : installActionLabel(state)}
            </span>
          )}

          {canManage ? (
            <RowQuickActions
              open={menuOpen}
              onOpenChange={setMenuOpen}
              pluginId={listing.pluginId}
              busy={busy}
              installed={installedPlugin !== null}
              enabled={installedPlugin?.enabled ?? false}
              isTheme={listing.isTheme}
              themeActive={themeActive}
              /* A plugin with no child process has nothing to restart, and
                 `status: "none"` is that fact without a manifest round trip. */
              showRestart={installedPlugin != null && (installedPlugin.status ?? "none") !== "none"}
              showInstall={state.kind === "available" || state.kind === "update"}
              onInstall={onInstall}
              onToggleEnabled={onToggleEnabled}
              onUseTheme={onUseTheme}
              onStopUsingTheme={onStopUsingTheme}
              onRestart={onRestart}
              onRemove={onRemove}
            />
          ) : null}
        </span>
      </div>
    </li>
  );
}

/**
 * Remove, turn off, restart — without opening the detail page.
 *
 * The alpha test's explicit ask: every single-plugin operation lived one
 * navigation away, so turning a plugin off meant leaving the list, acting, and
 * coming back to a list that had scrolled. These are the detail page's own
 * three verbs, wired to the detail page's own bridge calls, at the row.
 *
 * What it is NOT is a second permission surface. `onRemove` opens the same
 * confirmation and then calls the same `uninstallPlugin`, which stays CTO-only
 * and approval-gated in `adeActions` — a context that cannot uninstall from the
 * CLI cannot uninstall from here either, and the row reports the refusal rather
 * than hiding it.
 */
function RowQuickActions({
  open,
  onOpenChange,
  pluginId,
  busy,
  installed,
  enabled,
  isTheme,
  themeActive,
  showRestart,
  showInstall,
  onInstall,
  onToggleEnabled,
  onUseTheme,
  onStopUsingTheme,
  onRestart,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginId: string;
  busy: boolean;
  installed: boolean;
  enabled: boolean;
  isTheme: boolean;
  themeActive: boolean;
  showRestart: boolean;
  showInstall: boolean;
  onInstall: () => void;
  onToggleEnabled: () => void;
  onUseTheme: () => void;
  onStopUsingTheme: () => void;
  onRestart: () => void;
  onRemove: () => void;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="More actions"
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
          data-tour={`plugin:marketplace.row-menu-${pluginId}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            color: COLORS.textDim,
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: RADII.sm,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          <DotsThree size={16} weight="bold" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 outline-none"
          onClick={(event) => event.stopPropagation()}
        >
          <div
            style={{
              display: "grid",
              gap: 2,
              minWidth: 170,
              padding: 4,
              background: "var(--color-card)",
              border: `1px solid ${COLORS.border}`,
              borderRadius: RADII.md,
              boxShadow: "var(--shadow-panel)",
            }}
          >
            {showInstall ? (
              <RowMenuItem
                icon={<DownloadSimple size={13} weight="bold" />}
                label="Install"
                tour={`plugin:marketplace.row-install-${pluginId}`}
                onClick={onInstall}
              />
            ) : null}
            {installed && isTheme ? (
              <RowMenuItem
                icon={<Power size={13} weight="bold" />}
                label={themeActive ? "Stop using" : "Use theme"}
                tour={`plugin:marketplace.row-theme-${pluginId}`}
                onClick={themeActive ? onStopUsingTheme : onUseTheme}
              />
            ) : installed ? (
              <RowMenuItem
                icon={<Power size={13} weight="bold" />}
                label={enabled ? "Turn off" : "Turn on"}
                tour={`plugin:marketplace.row-toggle-${pluginId}`}
                onClick={onToggleEnabled}
              />
            ) : null}
            {showRestart ? (
              <RowMenuItem
                icon={<ArrowClockwise size={13} weight="bold" />}
                label="Restart"
                tour={`plugin:marketplace.row-restart-${pluginId}`}
                onClick={onRestart}
              />
            ) : null}
            {installed ? (
              <RowMenuItem
                icon={<Trash size={13} weight="bold" />}
                label="Remove…"
                danger
                tour={`plugin:marketplace.row-remove-${pluginId}`}
                onClick={onRemove}
              />
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A row in the quick-action menu. Mirrors the detail page's `MenuItem`. */
function RowMenuItem({
  icon,
  label,
  danger = false,
  tour,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  danger?: boolean;
  tour: string;
  onClick: () => void;
}) {
  return (
    <Popover.Close asChild>
      <button
        type="button"
        data-tour={tour}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        className="hover:bg-fg/[0.06]"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 28,
          padding: "0 8px",
          fontFamily: SANS_FONT,
          fontSize: 12,
          textAlign: "left",
          color: danger ? COLORS.danger : COLORS.textSecondary,
          background: "transparent",
          border: "none",
          borderRadius: RADII.sm,
          cursor: "pointer",
        }}
      >
        {icon ? <span style={{ display: "inline-flex", width: 14 }}>{icon}</span> : null}
        {label}
      </button>
    </Popover.Close>
  );
}

export default MarketplacePage;
