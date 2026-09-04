import React from "react";
import { useNavigate } from "react-router-dom";
import * as Popover from "@radix-ui/react-popover";
import { ArrowLeft, ArrowSquareOut, DotsThree } from "@phosphor-icons/react";

import {
  COLORS,
  RADII,
  SANS_FONT,
  dangerButton,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { ChatMarkdown } from "../chat/chatMarkdown";
import { useRootAppStore } from "../../state/appStore";
// The system browser, not ADE's built-in one: the built-in pane loads the page
// without navigating anyone to it, so these buttons all read as doing nothing.
import { openExternalUrl } from "../../lib/openExternal";
import { parsePluginManifest, type PluginManifest } from "../../../shared/plugins/manifest";
import { builtinSurfaceOwner } from "../../../shared/plugins/builtinSurfaces";
import {
  openPluginLogs,
  readPluginManifest,
  readPluginReadme,
  readPluginUsage,
  readPluginWebhookIngress,
  restartPlugin,
  setPluginEnabled,
  uninstallPlugin,
  type PluginUsageRow,
  type PluginWebhookIngressStatus,
} from "../../lib/pluginRuntimeBridge";
import { pluginIdentity } from "./pluginIcons";
import { PluginInstallDialog, type InstallDialogTarget } from "./PluginInstallDialog";
import { PluginConfigForm } from "./PluginConfigForm";
import { PluginThemePreview } from "./PluginThemePreview";
import {
  ContributionsRail,
  MachineRail,
  UsageRail,
  WebhooksRail,
  WhereItShowsUpRail,
} from "./MarketplaceDetailRail";
import {
  useMarketplaceCatalogue,
  useMarketplaceMachineName,
  usePluginPresence,
  usePluginRepoStars,
} from "./useMarketplace";
import { PluginMediaGallery } from "./PluginMediaGallery";
import { PluginStarButton } from "./PluginStarButton";
import {
  InlineNotice,
  ListingStats,
  MarketplaceEmpty,
  OfficialBadge,
  PluginIconTile,
  QuietTag,
  RailSection,
} from "./marketplaceUi";
import {
  deriveMachineCoverage,
  describeMarketplaceRegistry,
  describePluginAdds,
  describePluginDownload,
  describePluginResources,
  describePluginSource,
  installStateFor,
  pluginAuthorUrl,
  pluginStoresData,
  type ListingInstallState,
  type MarketplaceListing,
} from "./marketplaceModel";
import { settingsRouteFor } from "../settings/settingsManifest";

/**
 * One plugin, in full.
 *
 * The layout is a readme with a rail, and the split is not cosmetic: the readme
 * is the author's pitch and the rail is ADE's account of what the plugin is
 * doing on your machines. Everything decidable — where it is installed, what it
 * is allowed to add, what it is storing, what it is configured to do — lives in
 * the rail, so a reader who trusts nothing in the prose still has a complete
 * picture.
 *
 * The reporting sections of that rail live in `MarketplaceDetailRail.tsx`,
 * together with the account of how each one degrades on a host that cannot
 * answer for it.
 */

export function MarketplaceDetailPage({ pluginId }: { pluginId: string }) {
  const navigate = useNavigate();
  const catalogue = useMarketplaceCatalogue();
  const installed = useRootAppStore((state) => state.installedPlugins);
  const refreshInstalledPlugins = useRootAppStore((state) => state.refreshInstalledPlugins);
  const pluginThemeId = useRootAppStore((state) => state.pluginThemeId);
  const setPluginThemeId = useRootAppStore((state) => state.setPluginThemeId);
  const presence = usePluginPresence(true);
  const machineName = useMarketplaceMachineName();
  /* A machine that did not answer for its own registry has an EMPTY installed
     list that does not mean empty, so every control that acts on this plugin
     would be acting on a guess. The page still reads; it stops offering. */
  const registryMessage = describeMarketplaceRegistry({
    state: catalogue.registry,
    machineName,
  });
  const registryReady = catalogue.registry.kind === "ready";
  const canInstall = catalogue.capabilities.install && registryReady;

  const listing = React.useMemo(
    () => catalogue.listings.find((entry) => entry.pluginId === pluginId) ?? null,
    [catalogue.listings, pluginId],
  );
  const installedPlugin = installed.find((plugin) => plugin.pluginId === pluginId) ?? null;

  const [installTarget, setInstallTarget] = React.useState<InstallDialogTarget | null>(null);
  const [confirmUninstall, setConfirmUninstall] = React.useState(false);
  // Uninstalling the Linear package deletes the stored Linear credentials, so
  // the dialog has to say so before the user commits — it is the one part of a
  // removal that is not just "this comes back when you reinstall". Keyed off
  // the shared owner table rather than a literal id.
  const disconnectsLinear = pluginId === builtinSurfaceOwner("linear").ownerPluginId;
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /* The installed manifest is the truth about what a plugin does on THIS
     machine; the catalogue's copy describes what the directory offers. They
     differ across a pending update, so the rail prefers the local one. */
  const [localManifest, setLocalManifest] = React.useState<PluginManifest | null>(null);
  const [readme, setReadme] = React.useState<string | null>(null);
  const [usage, setUsage] = React.useState<PluginUsageRow | null>(null);
  const [ingress, setIngress] = React.useState<PluginWebhookIngressStatus | null>(null);

  /* The registry hands back a fresh array on every refresh, so keying the read
     on the entry's identity would refetch the manifest on every unrelated
     plugin event. Version and enabled-ness are the only changes that can alter
     what these three calls return. */
  const installedKey = installedPlugin
    ? `${installedPlugin.version}:${installedPlugin.enabled}`
    : null;

  React.useEffect(() => {
    let cancelled = false;
    setLocalManifest(null);
    setReadme(null);
    setUsage(null);
    setIngress(null);
    if (!installedKey) return;
    void (async () => {
      const [rawManifest, readmeText, usageRows, ingressRows] = await Promise.all([
        readPluginManifest(pluginId),
        readPluginReadme(pluginId),
        readPluginUsage(pluginId),
        readPluginWebhookIngress(pluginId),
      ]);
      if (cancelled) return;
      const parsed = rawManifest ? parsePluginManifest(rawManifest) : null;
      setLocalManifest(parsed?.manifest ?? null);
      setReadme(readmeText);
      setUsage(usageRows.find((row) => row.pluginId === pluginId) ?? null);
      // `undeclared` is the drain saying this plugin receives nothing, which is
      // the same section-absent answer as a host that drains nothing at all.
      const row = ingressRows.find((entry) => entry.pluginId === pluginId) ?? null;
      setIngress(row && row.state !== "undeclared" ? row : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [installedKey, pluginId]);

  /* One listing, so the lookup budget is spent on the plugin someone opened.
     The star button reads GitHub directly when there is a connection; this is
     what fills the count when there is not. */
  const listingsForStars = React.useMemo(() => (listing ? [listing] : []), [listing]);
  const stars = usePluginRepoStars(listingsForStars);

  const thisMachineKey = presence.rows.find((row) => row.isThisMachine)?.machineKey ?? null;
  const coverage = React.useMemo(
    () => deriveMachineCoverage({
      pluginId,
      catalogueVersion: listing?.version ?? null,
      presence: presence.rows,
      installed,
      thisMachineKey,
    }),
    [installed, listing?.version, pluginId, presence.rows, thisMachineKey],
  );

  if (catalogue.loading) {
    return <DetailShell onBack={() => navigate("/marketplace")}><DetailSkeleton /></DetailShell>;
  }

  if (!listing) {
    return (
      <DetailShell onBack={() => navigate("/marketplace")}>
        <MarketplaceEmpty
          title="Not in the catalogue"
          description="No plugin with that name is installed here or listed in the directory. It may have been removed, or the link may be from another machine."
        />
      </DetailShell>
    );
  }

  const manifest = localManifest ?? listing.manifest;
  const state = installStateFor(listing, installed);
  const adds = describePluginAdds({ ...listing, manifest });
  // A plugin installed from a folder on this machine has no page to open, so it
  // gets a fact row instead of a button that would go nowhere.
  const source = describePluginSource(listing.source);
  const resources = describePluginResources(listing);
  const download = describePluginDownload(listing);
  // The catalogue flags themes it knows about; the installed manifest is the
  // answer for one it does not.
  const isTheme = listing.isTheme || manifest?.theme !== undefined;
  const isActiveTheme = isTheme && pluginThemeId === pluginId;

  const useTheme = async (): Promise<void> => {
    if (installedPlugin && !installedPlugin.enabled) {
      await setPluginEnabled(pluginId, true);
    }
    setPluginThemeId(pluginId);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await refreshInstalledPlugins();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailShell onBack={() => navigate("/marketplace")}>
      <DetailHeader
        listing={listing}
        state={state}
        busy={busy}
        stars={stars.get(listing.pluginId) ?? listing.stars}
        canInstall={canInstall}
        canManage={registryReady && (catalogue.capabilities.enable || catalogue.capabilities.uninstall)}
        enabled={installedPlugin?.enabled ?? false}
        isTheme={isTheme}
        isActiveTheme={isActiveTheme}
        onInstall={() => setInstallTarget({ kind: "listing", listing })}
        onToggleEnabled={(enabled) => void run(() => setPluginEnabled(pluginId, enabled))}
        onUseTheme={() => void run(useTheme)}
        onStopUsingTheme={() => setPluginThemeId(null)}
        onUninstall={() => setConfirmUninstall(true)}
        onRestart={() => void run(() => restartPlugin(pluginId))}
        onLogs={() => void openPluginLogs(pluginId).catch(() => setActionError("Could not open the logs."))}
        showRuntimeActions={installedPlugin !== null && manifest?.entry !== undefined}
      />

      {actionError ? <InlineNotice>{actionError}</InlineNotice> : null}

      {/* The machine, not the directory. Silent when the machine answered. */}
      {registryMessage ? <InlineNotice tone="muted">{registryMessage}</InlineNotice> : null}

      {catalogue.capabilities.install || !registryReady ? null : (
        <InlineNotice tone="muted">
          {machineName
            ? `Open a project on ${machineName} to manage its plugins.`
            : "Open a project to manage plugins on this machine."}
        </InlineNotice>
      )}

      {state.kind === "update" ? (
        <UpdateCard
          listing={listing}
          from={state.version}
          to={state.available}
          busy={busy}
          canInstall={canInstall}
          /* The dialog, not a direct install. An update replaces running code
             with code nobody here has read, and the "Adds" disclosure is the
             whole of ADE's plugin permission model — a second button that
             skipped it would be a second permission model. */
          onUpdate={() => setInstallTarget({ kind: "listing", listing, intent: "update" })}
        />
      ) : null}

      {/* The rail drops under the readme on a narrow window. Expressed as
          variants rather than an inline `gridTemplateColumns` because an inline
          style has no breakpoint to respond to. */}
      <div className="grid items-start gap-7 [grid-template-columns:minmax(0,1fr)_minmax(260px,300px)] max-lg:[grid-template-columns:minmax(0,1fr)]">
        <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
          {/* Above the readme, because a screenshot answers "what is this"
              faster than a paragraph does — and below the header, because the
              install decision is the header's job. */}
          <PluginMediaGallery media={listing.media} />
          <Readme text={readme ?? listing.readme} description={listing.description} />
        </div>

        <aside
          style={{
            display: "grid",
            gap: 22,
            minWidth: 0,
            position: "sticky",
            top: 0,
            maxHeight: "calc(100vh - 140px)",
            overflowY: "auto",
            alignSelf: "start",
            paddingBottom: 8,
          }}
          data-tour="plugin:marketplace.rail"
        >
          <MachineRail
            rows={coverage}
            listing={listing}
            busy={busy}
            canRemote={catalogue.capabilities.remoteInstall}
            canInstall={canInstall}
            supportsPresence={catalogue.capabilities.machines}
            loading={presence.loading}
            /* Every install on this page opens the same dialog, this row
               included. It used to install on the press — the disclosure the
               header's button shows was simply absent from the rail, so which
               button you happened to use decided whether ADE told you what the
               plugin adds before it ran its code. The machine rides along so
               the dialog installs where the row said. */
            onInstallOn={(machineKey, machineName, isThisMachine) => setInstallTarget({
              kind: "listing",
              listing,
              machine: { machineKey, machineName, isThisMachine },
            })}
            onSetEnabled={(machineKey, enabled, isThisMachine) => void run(() =>
              setPluginEnabled(pluginId, enabled, isThisMachine ? undefined : machineKey))}
          />

          <RailSection title="About">
            <dl style={{ margin: 0, display: "grid", gap: 7 }}>
              <FactRow label="Version" value={state.kind === "available" ? listing.version : state.version} />
              {state.kind === "update" ? <FactRow label="Available" value={state.available} /> : null}
              {/* Absent for anything the directory never measured, and for
                  everything that ships inside ADE — a row reading "0 B" would
                  be a measurement nobody took. */}
              {download.size ? <FactRow label="Download" value={download.size} /> : null}
              <FactRow label="Author" value={listing.author} />
              {listing.publishedAt ? (
                <FactRow label="Updated" value={new Date(listing.publishedAt).toLocaleDateString()} />
              ) : null}
              {source && !source.url ? <FactRow label="From" value={source.text} /> : null}
            </dl>
            {/* Its own sentence rather than a second figure in the list above:
                a plugin that fetches a model dwarfing its own package is not
                describing a size, it is describing something that happens
                later, and the row format has nowhere to say "later". */}
            {download.extras.map((line) => (
              <p
                key={line}
                style={{
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: COLORS.textDim,
                }}
              >
                {line}
              </p>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <ListingStats
                installs={listing.installs}
                stars={stars.get(listing.pluginId) ?? listing.stars}
              />
            </div>
          </RailSection>

          {resources.length > 0 ? (
            <RailSection title="Resources">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {resources.map((resource) => (
                  <LinkButton key={resource.url} label={resource.label} url={resource.url} />
                ))}
              </div>
            </RailSection>
          ) : null}

          {listing.themeTokens ? (
            <PluginThemePreview
              pluginId={listing.pluginId}
              displayName={listing.displayName}
              tokens={listing.themeTokens}
              installed={installedPlugin !== null && installedPlugin.enabled}
            />
          ) : null}

          {/* Installing a theme does not switch to it, and the switch lives in
              Appearance beside the built-in palettes. Without this the page
              ends with a theme that is present and not on, and no signpost to
              the one screen that turns it on. */}
          {isTheme && installedPlugin ? (
            <RailSection title="Appearance">
              <button
                type="button"
                onClick={() => navigate(settingsRouteFor("appearance.theme"))}
                data-tour="plugin:marketplace.theme-settings"
                style={{
                  ...outlineButton({ height: 27, fontSize: 11.5 }),
                  justifySelf: "start",
                }}
              >
                Choose in Appearance settings
              </button>
            </RailSection>
          ) : null}

          <ContributionsRail
            manifest={manifest}
            adds={adds}
            pluginId={pluginId}
            disabledContributions={installedPlugin?.disabledContributions ?? []}
            canToggle={catalogue.capabilities.contributions && installedPlugin !== null}
            onError={setActionError}
          />

          {/* Directly under what it adds, because it answers the question that
              list provokes: the reader has just read "composer button in Work"
              and wants to know whether their phone will show it. Installed only
              — for a plugin nobody has yet, "where would it show up" is a
              hypothetical, and the install dialog already lists what it adds. */}
          {installedPlugin ? <WhereItShowsUpRail manifest={manifest} showSkillTiming /> : null}

          {installedPlugin && manifest && manifest.settings.length > 0 ? (
            <RailSection title="Settings">
              <PluginConfigForm pluginId={pluginId} settings={manifest.settings} />
            </RailSection>
          ) : null}

          {/* Under Settings, because a channel that declares `verify` needs a
              secret set there before its URL is worth pasting anywhere. */}
          {ingress ? <WebhooksRail status={ingress} /> : null}

          {usage && pluginStoresData(manifest, usage) ? <UsageRail usage={usage} /> : null}
        </aside>
      </div>

      <PluginInstallDialog
        target={installTarget}
        onOpenChange={(open) => { if (!open) setInstallTarget(null); }}
      />

      <LaneDialogShell
        open={confirmUninstall}
        onOpenChange={setConfirmUninstall}
        title={`Remove ${listing.displayName}?`}
        description="Its tabs, panels and commands disappear from this machine. Anything it stored is deleted with it."
        widthClassName="w-[min(460px,calc(100vw-1rem))]"
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={() => setConfirmUninstall(false)}
              style={outlineButton({ height: 30, fontSize: 12 })}
            >
              Keep it
            </button>
            <button
              type="button"
              data-tour="plugin:marketplace.uninstall-confirm"
              onClick={() => {
                setConfirmUninstall(false);
                void run(async () => {
                  await uninstallPlugin(pluginId);
                  if (isActiveTheme) setPluginThemeId(null);
                });
              }}
              style={dangerButton({ height: 30, fontSize: 12 })}
            >
              Remove
            </button>
          </div>
        }
      >
        {disconnectsLinear ? (
          <p style={{ margin: "0 0 8px", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary, lineHeight: 1.6 }}>
            This disconnects Linear. You will sign in again if you reinstall it.
          </p>
        ) : null}
        <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
          Other machines keep their own copy. You can install it again at any time.
        </p>
      </LaneDialogShell>
    </DetailShell>
  );
}

/* ── Chrome ─────────────────────────────────────────────────────────────── */

function DetailShell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }} data-tour="plugin:marketplace.detail">
      <div style={{
        maxWidth: 980,
        margin: "0 auto",
        padding: "20px 24px 24px",
        display: "grid",
        gap: 20,
        flex: 1,
        minHeight: 0,
        width: "100%",
        gridTemplateRows: "auto minmax(0, 1fr)",
      }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            justifySelf: "start",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: 0,
            fontFamily: SANS_FONT,
            fontSize: 11.5,
            color: COLORS.textMuted,
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          <ArrowLeft size={13} weight="regular" aria-hidden />
          Marketplace
        </button>
        <div style={{ minHeight: 0, overflow: "auto", display: "grid", gap: 20, paddingBottom: 24 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function DetailHeader({
  listing,
  state,
  busy,
  stars,
  enabled,
  isTheme,
  isActiveTheme,
  canInstall,
  canManage,
  showRuntimeActions,
  onInstall,
  onToggleEnabled,
  onUseTheme,
  onStopUsingTheme,
  onUninstall,
  onRestart,
  onLogs,
}: {
  listing: MarketplaceListing;
  state: ListingInstallState;
  busy: boolean;
  stars: number | null;
  enabled: boolean;
  isTheme: boolean;
  isActiveTheme: boolean;
  canInstall: boolean;
  canManage: boolean;
  showRuntimeActions: boolean;
  onInstall: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onUseTheme: () => void;
  onStopUsingTheme: () => void;
  onUninstall: () => void;
  onRestart: () => void;
  onLogs: () => void;
}) {
  const identity = pluginIdentity(listing);
  const installedHere = state.kind !== "available";
  const authorUrl = pluginAuthorUrl(listing);
  const repo = listing.repo ?? listing.links?.repository ?? null;

  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        paddingBottom: 18,
        borderBottom: `1px solid ${COLORS.borderMuted}`,
      }}
    >
      <PluginIconTile identity={identity} size={52} label={listing.displayName} />

      <div style={{ display: "grid", gap: 5, flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h1
            style={{
              margin: 0,
              fontFamily: SANS_FONT,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-0.015em",
              color: COLORS.textPrimary,
            }}
          >
            {listing.displayName}
          </h1>
          {listing.official ? <OfficialBadge /> : null}
          {listing.isTheme ? <QuietTag>Theme</QuietTag> : null}
          {state.kind === "disabled" && !isTheme ? <QuietTag>Turned off</QuietTag> : null}
          {isActiveTheme ? <QuietTag>Active theme</QuietTag> : null}
          {listing.origin === "installed" ? <QuietTag>Installed directly</QuietTag> : null}
        </div>
        {/* The author row survives the card's single official chip: here there
            is room for it to be a link to the account that publishes it, which
            is the one form of the fact worth reading. */}
        {authorUrl ? (
          <button
            type="button"
            onClick={() => openExternalUrl(authorUrl)}
            title={authorUrl}
            style={{
              justifySelf: "start",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 0,
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textMuted,
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            {listing.author}
            <ArrowSquareOut size={11} weight="regular" aria-hidden />
          </button>
        ) : (
          <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
            {listing.author}
          </span>
        )}
        {listing.description ? (
          <p
            style={{
              margin: "2px 0 0",
              maxWidth: "70ch",
              fontFamily: SANS_FONT,
              fontSize: 12.5,
              lineHeight: 1.55,
              color: COLORS.textSecondary,
            }}
          >
            {listing.description}
          </p>
        ) : null}
      </div>

      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <PluginStarButton repo={repo} fallbackStars={stars} />

        {state.kind === "available" ? (
          canInstall ? (
            <button
              type="button"
              onClick={onInstall}
              disabled={busy}
              data-tour="plugin:marketplace.detail-install"
              style={{ ...primaryButton({ height: 30, fontSize: 12 }), opacity: busy ? 0.6 : 1 }}
            >
              Install
            </button>
          ) : null
        ) : isTheme ? (
          <button
            type="button"
            onClick={isActiveTheme ? onStopUsingTheme : onUseTheme}
            disabled={busy || !canManage}
            data-tour="plugin:marketplace.detail-theme-action"
            style={{
              ...(isActiveTheme
                ? outlineButton({ height: 30, fontSize: 12 })
                : primaryButton({ height: 30, fontSize: 12 })),
              opacity: busy || !canManage ? 0.6 : 1,
            }}
          >
            {isActiveTheme ? "Stop using" : "Use theme"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onToggleEnabled(!enabled)}
            disabled={busy || !canManage}
            data-tour="plugin:marketplace.detail-toggle"
            style={{
              ...outlineButton({ height: 30, fontSize: 12 }),
              opacity: busy || !canManage ? 0.6 : 1,
            }}
          >
            {enabled ? "Turn off" : "Turn on"}
          </button>
        )}

        {installedHere ? (
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                aria-label="More actions"
                data-tour="plugin:marketplace.detail-menu"
                style={{
                  ...outlineButton({ height: 30, padding: "0 8px", fontSize: 12 }),
                  background: "transparent",
                }}
              >
                <DotsThree size={16} weight="bold" aria-hidden />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} collisionPadding={8} className="z-50 outline-none">
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
                  {showRuntimeActions ? (
                    <>
                      <MenuItem label="Restart" onClick={onRestart} />
                      <MenuItem label="View logs" onClick={onLogs} />
                    </>
                  ) : null}
                  <MenuItem label="Remove…" danger onClick={onUninstall} />
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
      </div>
    </header>
  );
}

function MenuItem({
  label,
  danger = false,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Popover.Close asChild>
      <button
        type="button"
        onClick={onClick}
        className="hover:bg-fg/[0.06]"
        style={{
          display: "flex",
          alignItems: "center",
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
        {label}
      </button>
    </Popover.Close>
  );
}

/* ── Readme ─────────────────────────────────────────────────────────────── */

/**
 * The author's own text, through the same sanitized markdown pipeline chat
 * uses. A plugin readme is third-party content on a first-party surface, and
 * `ChatMarkdown` is where ADE's sanitizer, its link handling, and its "never
 * open a raw file: href" rules already live.
 */
function Readme({ text, description }: { text: string | null; description: string }) {
  if (!text) {
    return (
      <div
        style={{
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          lineHeight: 1.7,
          color: COLORS.textMuted,
        }}
      >
        {description || "This plugin ships no description."}
      </div>
    );
  }
  return (
    <div
      data-tour="plugin:marketplace.readme"
      style={{
        fontFamily: SANS_FONT,
        fontSize: 12.5,
        lineHeight: 1.7,
        color: COLORS.textSecondary,
        minWidth: 0,
      }}
    >
      <ChatMarkdown>{text}</ChatMarkdown>
    </div>
  );
}

/* ── Update ─────────────────────────────────────────────────────────────── */

function UpdateCard({
  listing,
  from,
  to,
  busy,
  canInstall,
  onUpdate,
}: {
  listing: MarketplaceListing;
  from: string;
  to: string;
  busy: boolean;
  canInstall: boolean;
  onUpdate: () => void;
}) {
  return (
    <div
      data-tour="plugin:marketplace.update"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        background: "color-mix(in srgb, var(--color-accent) 7%, transparent)",
        border: `1px solid ${COLORS.accentBorder}`,
        borderRadius: RADII.md,
      }}
    >
      <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: SANS_FONT, fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>
          Version {to} is available
        </span>
        <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
          You have {from} on this machine.
        </span>
      </span>
      {listing.changelogUrl ? <LinkButton label="What changed" url={listing.changelogUrl} /> : null}
      {canInstall ? (
        <button
          type="button"
          onClick={onUpdate}
          disabled={busy}
          data-tour="plugin:marketplace.update-action"
          style={{ ...primaryButton({ height: 28, fontSize: 11.5 }), opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Updating…" : "Update"}
        </button>
      ) : null}
    </div>
  );
}

/* ── Rail sections ──────────────────────────────────────────────────────── */

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
      <dt style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textDim }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          fontFamily: SANS_FONT,
          fontSize: 11.5,
          color: COLORS.textSecondary,
          textAlign: "right",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function LinkButton({ label, url }: { label: string; url: string }) {
  return (
    <button
      type="button"
      onClick={() => openExternalUrl(url)}
      title={url}
      style={{
        ...outlineButton({ height: 26, padding: "0 9px", fontSize: 11 }),
        background: "transparent",
      }}
    >
      {label}
      <ArrowSquareOut size={11} weight="regular" aria-hidden />
    </button>
  );
}

function DetailSkeleton() {
  return (
    <div className="motion-safe:animate-pulse" role="status" aria-label="Loading plugin" style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 14 }}>
        <span style={{ width: 44, height: 44, borderRadius: RADII.md, background: COLORS.recessedBg }} />
        <span style={{ display: "grid", gap: 8, flex: 1 }}>
          <span style={{ height: 16, width: "32%", background: COLORS.recessedBg, borderRadius: 4 }} />
          <span style={{ height: 11, width: "54%", background: COLORS.recessedBg, borderRadius: 4 }} />
        </span>
      </div>
      <span style={{ height: 180, background: COLORS.recessedBg, borderRadius: RADII.lg }} />
    </div>
  );
}

export default MarketplaceDetailPage;
