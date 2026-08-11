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
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { parsePluginManifest, type PluginManifest } from "../../../shared/plugins/manifest";
import {
  installPlugin,
  openPluginLogs,
  readPluginManifest,
  readPluginReadme,
  readPluginUsage,
  restartPlugin,
  setPluginContributionEnabled,
  setPluginEnabled,
  uninstallPlugin,
  type PluginUsageRow,
} from "../../lib/pluginRuntimeBridge";
import { pluginIcon } from "./pluginIcons";
import { PluginInstallDialog, type InstallDialogTarget } from "./PluginInstallDialog";
import { PluginConfigForm } from "./PluginConfigForm";
import { PluginThemePreview } from "./PluginThemePreview";
import { useMarketplaceCatalogue, usePluginPresence } from "./useMarketplace";
import {
  BudgetMeter,
  CoverageGlyph,
  COVERAGE_LABEL,
  InlineNotice,
  ListingStats,
  MarketplaceEmpty,
  OfficialBadge,
  QuietTag,
  RailSection,
} from "./marketplaceUi";
import {
  SURFACE_LABELS,
  deriveMachineCoverage,
  describePluginAdds,
  formatBytes,
  installStateFor,
  type ListingInstallState,
  type MachineCoverageRow,
  type MarketplaceListing,
} from "./marketplaceModel";

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
 * Every rail section is independently degradable. A host that publishes no
 * presence shows one machine; one that cannot read usage omits the meter; one
 * that cannot toggle contributions lists them read-only. None of those turn
 * into an error, because none of them stop the page from answering the question
 * it was opened for.
 */

export function MarketplaceDetailPage({ pluginId }: { pluginId: string }) {
  const navigate = useNavigate();
  const catalogue = useMarketplaceCatalogue();
  const installed = useRootAppStore((state) => state.installedPlugins);
  const refreshInstalledPlugins = useRootAppStore((state) => state.refreshInstalledPlugins);
  const presence = usePluginPresence(true);

  const listing = React.useMemo(
    () => catalogue.listings.find((entry) => entry.pluginId === pluginId) ?? null,
    [catalogue.listings, pluginId],
  );
  const installedPlugin = installed.find((plugin) => plugin.pluginId === pluginId) ?? null;

  const [installTarget, setInstallTarget] = React.useState<InstallDialogTarget | null>(null);
  const [confirmUninstall, setConfirmUninstall] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /* The installed manifest is the truth about what a plugin does on THIS
     machine; the catalogue's copy describes what the directory offers. They
     differ across a pending update, so the rail prefers the local one. */
  const [localManifest, setLocalManifest] = React.useState<PluginManifest | null>(null);
  const [readme, setReadme] = React.useState<string | null>(null);
  const [usage, setUsage] = React.useState<PluginUsageRow | null>(null);

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
    if (!installedKey) return;
    void (async () => {
      const [rawManifest, readmeText, usageRows] = await Promise.all([
        readPluginManifest(pluginId),
        readPluginReadme(pluginId),
        readPluginUsage(pluginId),
      ]);
      if (cancelled) return;
      const parsed = rawManifest ? parsePluginManifest(rawManifest) : null;
      setLocalManifest(parsed?.manifest ?? null);
      setReadme(readmeText);
      setUsage(usageRows.find((row) => row.pluginId === pluginId) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [installedKey, pluginId]);

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
        canManage={catalogue.capabilities.enable || catalogue.capabilities.uninstall}
        enabled={installedPlugin?.enabled ?? false}
        onInstall={() => setInstallTarget({ kind: "listing", listing })}
        onToggleEnabled={(enabled) => void run(() => setPluginEnabled(pluginId, enabled))}
        onUninstall={() => setConfirmUninstall(true)}
        onRestart={() => void run(() => restartPlugin(pluginId))}
        onLogs={() => void openPluginLogs(pluginId).catch(() => setActionError("Could not open the logs."))}
        showRuntimeActions={installedPlugin !== null && manifest?.entry !== undefined}
      />

      {actionError ? <InlineNotice>{actionError}</InlineNotice> : null}

      {state.kind === "update" ? (
        <UpdateCard
          listing={listing}
          from={state.version}
          to={state.available}
          busy={busy}
          onUpdate={() => void run(async () => {
            await installPlugin({
              source: listing.source,
              pluginId: listing.pluginId,
              version: listing.version,
            });
          })}
        />
      ) : null}

      {/* The rail drops under the readme on a narrow window. Expressed as
          variants rather than an inline `gridTemplateColumns` because an inline
          style has no breakpoint to respond to. */}
      <div className="grid items-start gap-7 [grid-template-columns:minmax(0,1fr)_minmax(260px,300px)] max-lg:[grid-template-columns:minmax(0,1fr)]">
        <Readme text={readme ?? listing.readme} description={listing.description} />

        <aside style={{ display: "grid", gap: 22, minWidth: 0 }} data-tour="plugin:marketplace.rail">
          <MachineRail
            rows={coverage}
            listing={listing}
            busy={busy}
            canRemote={catalogue.capabilities.remoteInstall}
            supportsPresence={catalogue.capabilities.machines}
            loading={presence.loading}
            onInstallOn={(machineKey) => void run(async () => {
              await installPlugin({
                source: listing.source,
                pluginId: listing.pluginId,
                version: listing.version,
                machineKey,
              });
            })}
            onSetEnabled={(machineKey, enabled, isThisMachine) => void run(() =>
              setPluginEnabled(pluginId, enabled, isThisMachine ? undefined : machineKey))}
          />

          <RailSection title="About">
            <dl style={{ margin: 0, display: "grid", gap: 7 }}>
              <FactRow label="Version" value={state.kind === "available" ? listing.version : state.version} />
              {state.kind === "update" ? <FactRow label="Available" value={state.available} /> : null}
              <FactRow label="Author" value={listing.author} />
              {listing.publishedAt ? (
                <FactRow label="Updated" value={new Date(listing.publishedAt).toLocaleDateString()} />
              ) : null}
            </dl>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <ListingStats installs={listing.installs} stars={listing.stars} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {listing.changelogUrl ? (
                <LinkButton label="Changelog" url={listing.changelogUrl} />
              ) : null}
              {listing.source ? <LinkButton label="Source" url={listing.source} /> : null}
            </div>
          </RailSection>

          {listing.themeTokens ? (
            <PluginThemePreview
              pluginId={listing.pluginId}
              displayName={listing.displayName}
              tokens={listing.themeTokens}
              installed={installedPlugin !== null && installedPlugin.enabled}
            />
          ) : null}

          <ContributionsRail
            manifest={manifest}
            adds={adds}
            pluginId={pluginId}
            disabledContributions={installedPlugin?.disabledContributions ?? []}
            canToggle={catalogue.capabilities.contributions && installedPlugin !== null}
            onError={setActionError}
          />

          {installedPlugin && manifest && manifest.settings.length > 0 ? (
            <RailSection title="Settings">
              <PluginConfigForm pluginId={pluginId} settings={manifest.settings} />
            </RailSection>
          ) : null}

          {usage ? <UsageRail usage={usage} /> : null}
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
                void run(() => uninstallPlugin(pluginId));
              }}
              style={dangerButton({ height: 30, fontSize: 12 })}
            >
              Remove
            </button>
          </div>
        }
      >
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
    <div style={{ height: "100%", minHeight: 0, overflow: "auto" }} data-tour="plugin:marketplace.detail">
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "20px 24px 48px", display: "grid", gap: 20 }}>
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
        {children}
      </div>
    </div>
  );
}

function DetailHeader({
  listing,
  state,
  busy,
  enabled,
  canManage,
  showRuntimeActions,
  onInstall,
  onToggleEnabled,
  onUninstall,
  onRestart,
  onLogs,
}: {
  listing: MarketplaceListing;
  state: ListingInstallState;
  busy: boolean;
  enabled: boolean;
  canManage: boolean;
  showRuntimeActions: boolean;
  onInstall: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onUninstall: () => void;
  onRestart: () => void;
  onLogs: () => void;
}) {
  const Icon = pluginIcon(listing.icon);
  const installedHere = state.kind !== "available";

  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        paddingBottom: 18,
        borderBottom: `1px solid ${COLORS.borderMuted}`,
        ...(listing.accent ? ({ "--plugin-accent": listing.accent } as React.CSSProperties) : {}),
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 44,
          height: 44,
          flexShrink: 0,
          borderRadius: RADII.md,
          background: listing.accent
            ? "color-mix(in srgb, var(--plugin-accent) 12%, transparent)"
            : COLORS.recessedBg,
        }}
      >
        <Icon size={22} weight="regular" color={listing.accent ? "var(--plugin-accent)" : COLORS.textMuted} aria-hidden />
      </span>

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
          {state.kind === "disabled" ? <QuietTag>Turned off</QuietTag> : null}
          {listing.origin === "installed" ? <QuietTag>Installed directly</QuietTag> : null}
        </div>
        <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
          {listing.author}
        </span>
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
        {state.kind === "available" ? (
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            data-tour="plugin:marketplace.detail-install"
            style={{ ...primaryButton({ height: 30, fontSize: 12 }), opacity: busy ? 0.6 : 1 }}
          >
            Install
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
  onUpdate,
}: {
  listing: MarketplaceListing;
  from: string;
  to: string;
  busy: boolean;
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
      <button
        type="button"
        onClick={onUpdate}
        disabled={busy}
        data-tour="plugin:marketplace.update-action"
        style={{ ...primaryButton({ height: 28, fontSize: 11.5 }), opacity: busy ? 0.6 : 1 }}
      >
        {busy ? "Updating…" : "Update"}
      </button>
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
      onClick={() => openUrlInAdeBrowser(url)}
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

/**
 * The machine matrix.
 *
 * The one rail section that exists because ADE is multi-machine: a plugin is
 * installed per machine, so "is it installed" has no single answer and a single
 * Install button would be answering the wrong question. Each row carries the
 * action that machine can take, and a machine that could not be reached says so
 * instead of claiming the plugin is missing there.
 */
function MachineRail({
  rows,
  listing,
  busy,
  canRemote,
  supportsPresence,
  loading,
  onInstallOn,
  onSetEnabled,
}: {
  rows: readonly MachineCoverageRow[];
  listing: MarketplaceListing;
  busy: boolean;
  canRemote: boolean;
  supportsPresence: boolean;
  loading: boolean;
  onInstallOn: (machineKey: string) => void;
  onSetEnabled: (machineKey: string, enabled: boolean, isThisMachine: boolean) => void;
}) {
  const present = rows.filter((row) => row.state === "installed" || row.state === "outdated").length;
  return (
    <RailSection
      title={supportsPresence && rows.length > 1 ? `Machines · ${present} of ${rows.length}` : "This machine"}
    >
      {loading && supportsPresence ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textDim }}>Checking…</span>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 1 }}>
          {rows.map((row) => {
            const installedThere = row.state === "installed" || row.state === "outdated" || row.state === "disabled";
            const canAct = row.isThisMachine || canRemote;
            return (
              <li
                key={row.machineKey}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  borderRadius: RADII.sm,
                  background: row.isThisMachine ? COLORS.recessedBg : "transparent",
                }}
              >
                <CoverageGlyph state={row.state} />
                <span style={{ display: "grid", gap: 1, flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 11.5,
                      color: COLORS.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={row.machineName}
                  >
                    {row.machineName}
                    {row.isThisMachine ? " · this machine" : ""}
                  </span>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim }}>
                    {COVERAGE_LABEL[row.state]}
                    {row.version ? ` · ${row.version}` : ""}
                  </span>
                </span>
                {row.state === "unknown" || !canAct ? null : installedThere ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSetEnabled(row.machineKey, row.state === "disabled", row.isThisMachine)}
                    style={{
                      ...outlineButton({ height: 22, padding: "0 8px", fontSize: 10.5 }),
                      background: "transparent",
                    }}
                  >
                    {row.state === "disabled" ? "Turn on" : "Turn off"}
                  </button>
                ) : listing.source ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onInstallOn(row.machineKey)}
                    style={{
                      ...outlineButton({ height: 22, padding: "0 8px", fontSize: 10.5 }),
                      background: "transparent",
                    }}
                  >
                    Install
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {!supportsPresence ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim, lineHeight: 1.5 }}>
          Other machines report their plugins once they are on a build that publishes them.
        </span>
      ) : null}
    </RailSection>
  );
}

/**
 * What the plugin adds, and — when the host allows it — which of those are on.
 *
 * The list is derived from the manifest, so it is the same list the install
 * modal showed. Toggling is per contribution rather than per plugin because the
 * common complaint about an extension is one row badge, not the whole thing.
 */
function ContributionsRail({
  manifest,
  adds,
  pluginId,
  disabledContributions,
  canToggle,
  onError,
}: {
  manifest: PluginManifest | null;
  adds: string[];
  pluginId: string;
  disabledContributions: readonly string[];
  canToggle: boolean;
  onError: (message: string) => void;
}) {
  const sockets = manifest?.sockets ?? [];
  if (adds.length === 0 && sockets.length === 0) return null;

  return (
    <RailSection title="What it adds">
      {sockets.length > 0 && canToggle ? (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 1 }}>
          {sockets.map((socket) => (
            <ContributionToggle
              key={socket.id}
              pluginId={pluginId}
              socketId={socket.id}
              label={socket.label ?? socket.id}
              surface={SURFACE_LABELS[socket.surface]}
              initiallyEnabled={!disabledContributions.includes(socket.id)}
              onError={onError}
            />
          ))}
        </ul>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
          {adds.map((line) => (
            <li
              key={line}
              style={{
                display: "flex",
                gap: 7,
                fontFamily: SANS_FONT,
                fontSize: 11.5,
                color: COLORS.textSecondary,
                lineHeight: 1.5,
              }}
            >
              <span aria-hidden style={{ color: COLORS.textDim }}>—</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

function ContributionToggle({
  pluginId,
  socketId,
  label,
  surface,
  initiallyEnabled,
  onError,
}: {
  pluginId: string;
  socketId: string;
  label: string;
  surface: string;
  initiallyEnabled: boolean;
  onError: (message: string) => void;
}) {
  // Optimistic, and reverted on failure: a toggle whose state waits on a round
  // trip reads as broken, and one that stays flipped after a rejection lies.
  const [enabled, setEnabled] = React.useState(initiallyEnabled);

  return (
    <li style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
      <span style={{ display: "grid", gap: 1, flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary }}>{label}</span>
        <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim }}>in {surface}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${label} in ${surface}`}
        onClick={() => {
          const next = !enabled;
          setEnabled(next);
          void setPluginContributionEnabled(pluginId, socketId, next).catch((cause: unknown) => {
            setEnabled(!next);
            onError(cause instanceof Error ? cause.message : "Could not change that.");
          });
        }}
        style={{
          position: "relative",
          width: 30,
          height: 17,
          flexShrink: 0,
          borderRadius: 10,
          border: "none",
          background: enabled ? COLORS.accent : COLORS.outlineBorder,
          cursor: "pointer",
          padding: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: enabled ? 15 : 2,
            width: 13,
            height: 13,
            borderRadius: 8,
            background: enabled ? "var(--color-bg)" : COLORS.textMuted,
            transition: "left 140ms ease",
          }}
        />
      </button>
    </li>
  );
}

function UsageRail({ usage }: { usage: PluginUsageRow }) {
  return (
    <RailSection title="Storage and sync">
      <BudgetMeter
        label="Stored data"
        used={usage.collectionBytes}
        budget={usage.collectionBudgetBytes}
        valueText={`${formatBytes(usage.collectionBytes)} of ${formatBytes(usage.collectionBudgetBytes)}`}
      />
      <BudgetMeter
        label="Rows"
        used={usage.rows}
        budget={usage.rowBudget}
        valueText={`${usage.rows} of ${usage.rowBudget}`}
      />
      {usage.syncBytesTotal !== null ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
          {formatBytes(usage.syncBytesTotal)} synced
        </span>
      ) : null}
    </RailSection>
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
