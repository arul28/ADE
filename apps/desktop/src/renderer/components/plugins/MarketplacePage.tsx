import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowClockwise, LinkSimple, MagnifyingGlass } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { useRootAppStore } from "../../state/appStore";
import { pluginIdentity } from "./pluginIcons";
import { MarketplaceDetailPage } from "./MarketplaceDetailPage";
import { PluginInstallDialog, type InstallDialogTarget } from "./PluginInstallDialog";
import { useMarketplaceCatalogue, usePluginPresence, usePluginRepoStars } from "./useMarketplace";
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
  SURFACE_LABELS,
  deriveMachineCoverage,
  deriveSurfaceFacets,
  featuredListings,
  installStateFor,
  installedPluginIds,
  marketplaceRouteFromPath,
  queryMarketplace,
  type ListingInstallState,
  type MarketplaceChip,
  type MarketplaceIndexState,
  type MarketplaceListing,
  type MarketplaceQuery,
  type MarketplaceSort,
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
 */

const CHIPS: { id: MarketplaceChip; label: string }[] = [
  { id: "all", label: "All" },
  // Second, because "what do I already have" is the question people arrive with
  // most often after their first visit.
  { id: "installed", label: "Installed" },
  { id: "official", label: "Official" },
  { id: "featured", label: "Featured" },
  { id: "themes", label: "Themes" },
];

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
  const catalogue = useMarketplaceCatalogue();
  const installed = useRootAppStore((state) => state.installedPlugins);
  const presence = usePluginPresence(true);

  const [query, setQuery] = React.useState<MarketplaceQuery>(DEFAULT_MARKETPLACE_QUERY);
  const [installTarget, setInstallTarget] = React.useState<InstallDialogTarget | null>(null);

  /* A host with no install action is not a broken Marketplace — it is a window
     with no project attached, which is most of what "this button does nothing"
     turned out to mean. The gallery still browses; only the actions go quiet. */
  const canManage = catalogue.capabilities.install;

  const thisMachineKey = React.useMemo(
    () => presence.rows.find((row) => row.isThisMachine)?.machineKey ?? null,
    [presence.rows],
  );

  const installedIds = React.useMemo(() => installedPluginIds(installed), [installed]);

  const visible = React.useMemo(
    () => queryMarketplace(catalogue.listings, query, installedIds),
    [catalogue.listings, installedIds, query],
  );
  const facets = React.useMemo(
    () => deriveSurfaceFacets(catalogue.listings, query, installedIds),
    [catalogue.listings, installedIds, query],
  );
  const featured = React.useMemo(() => featuredListings(catalogue.listings), [catalogue.listings]);
  // Asked for in the order the gallery draws, so the rows on screen are the
  // ones that spend the lookup budget.
  const stars = usePluginRepoStars(React.useMemo(
    () => [...featured, ...visible],
    [featured, visible],
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

  const filtersActive = query.chip !== "all" || query.surfaces.length > 0 || query.search.trim().length > 0;

  return (
    <div
      data-tour="plugin:marketplace.page"
      style={{ height: "100%", minHeight: 0, overflow: "auto" }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "26px 24px 48px", display: "grid", gap: 20 }}>
        <GalleryHeader
          search={query.search}
          onSearch={(search) => setQuery((previous) => ({ ...previous, search }))}
          onInstallFromUrl={() => setInstallTarget({ kind: "url" })}
          onRefresh={catalogue.refresh}
          refreshing={catalogue.refreshing}
          canRefresh={catalogue.capabilities.browse}
          canManage={canManage}
        />

        <IndexNotice state={catalogue.state} onRefresh={catalogue.refresh} />

        {canManage ? null : (
          <InlineNotice tone="muted">
            Open a project to manage plugins on this machine.
          </InlineNotice>
        )}

        {catalogue.loading ? (
          <ListingSkeleton rows={5} />
        ) : (
          <>
            {featured.length > 0 && !filtersActive ? (
              <FeaturedRow
                listings={featured}
                onOpen={openListing}
                installed={installed}
                stars={stars}
              />
            ) : null}

            <FilterBar
              query={query}
              facets={facets}
              installedCount={installedIds.size}
              onChange={setQuery}
            />

            {visible.length === 0 ? (
              <MarketplaceEmpty
                title="Nothing matches"
                description="No plugin in the catalogue fits those filters. Clear them, or install one directly from its repository."
                action={
                  <button
                    type="button"
                    onClick={() => setQuery(DEFAULT_MARKETPLACE_QUERY)}
                    style={outlineButton({ height: 28, fontSize: 11.5 })}
                  >
                    Clear filters
                  </button>
                }
              />
            ) : (
              <ul
                data-tour="plugin:marketplace.list"
                style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 2 }}
              >
                {visible.map((listing) => (
                  <ListingRow
                    key={listing.pluginId}
                    listing={listing}
                    state={installStateFor(listing, installed)}
                    coverage={coverageFor(listing)}
                    stars={stars.get(listing.pluginId) ?? null}
                    canManage={canManage}
                    onOpen={() => openListing(listing)}
                    onInstall={() => setInstallTarget({ kind: "listing", listing })}
                  />
                ))}
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
    </div>
  );
}

/* ── Header ─────────────────────────────────────────────────────────────── */

function GalleryHeader({
  search,
  onSearch,
  onInstallFromUrl,
  onRefresh,
  refreshing,
  canRefresh,
  canManage,
}: {
  search: string;
  onSearch: (value: string) => void;
  onInstallFromUrl: () => void;
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
              onClick={onInstallFromUrl}
              data-tour="plugin:marketplace.install-from-url"
              style={primaryButton({ height: 30, fontSize: 11.5 })}
            >
              <LinkSimple size={13} weight="regular" aria-hidden />
              Install from URL
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

/* ── Filters ────────────────────────────────────────────────────────────── */

function FilterBar({
  query,
  facets,
  installedCount,
  onChange,
}: {
  query: MarketplaceQuery;
  facets: { surface: PluginSurfaceId; label: string; total: number }[];
  /** Counted on the chip, and only when there is something to count. */
  installedCount: number;
  onChange: React.Dispatch<React.SetStateAction<MarketplaceQuery>>;
}) {
  const toggleSurface = (surface: PluginSurfaceId) => {
    onChange((previous) => ({
      ...previous,
      surfaces: previous.surfaces.includes(surface)
        ? previous.surfaces.filter((entry) => entry !== surface)
        : [...previous.surfaces, surface],
    }));
  };

  return (
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
      {CHIPS.map((chip) => (
        <FilterChip
          key={chip.id}
          label={chip.label}
          count={chip.id === "installed" && installedCount > 0 ? installedCount : undefined}
          active={query.chip === chip.id}
          onClick={() => onChange((previous) => ({ ...previous, chip: chip.id }))}
          tour={`plugin:marketplace.chip-${chip.id}`}
        />
      ))}

      {facets.length > 0 ? (
        <span
          aria-hidden
          style={{ width: 1, height: 16, background: COLORS.borderMuted, margin: "0 2px" }}
        />
      ) : null}
      {facets.map((facet) => (
        <FilterChip
          key={facet.surface}
          label={`Extends ${SURFACE_LABELS[facet.surface]}`}
          count={facet.total}
          active={query.surfaces.includes(facet.surface)}
          onClick={() => toggleSurface(facet.surface)}
          tour={`plugin:marketplace.facet-${facet.surface}`}
        />
      ))}

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
          return (
            <button
              key={sort.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange((previous) => ({ ...previous, sort: sort.id }))}
              data-tour={`plugin:marketplace.sort-${sort.id}`}
              style={{
                height: 22,
                padding: "0 9px",
                fontFamily: SANS_FONT,
                fontSize: 11,
                fontWeight: active ? 600 : 500,
                color: active ? COLORS.textPrimary : COLORS.textMuted,
                background: active ? "color-mix(in srgb, var(--color-fg) 8%, transparent)" : "transparent",
                border: "none",
                borderRadius: 7,
                cursor: "pointer",
              }}
            >
              {sort.label}
            </button>
          );
        })}
      </span>
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
  onOpen,
  onInstall,
}: {
  listing: MarketplaceListing;
  state: ListingInstallState;
  coverage: ReturnType<typeof deriveMachineCoverage>;
  stars: number | null;
  canManage: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const identity = pluginIdentity(listing);
  // A row whose install cannot run does not offer one. The page says why once,
  // at the top, rather than every row having to explain itself.
  const actionable = canManage && (state.kind === "available" || state.kind === "update");

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
              {installActionLabel(state)}
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
        </span>
      </div>
    </li>
  );
}

export default MarketplacePage;
