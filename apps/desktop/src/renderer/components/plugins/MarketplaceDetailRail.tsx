import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { setPluginContributionEnabled, type PluginUsageRow } from "../../lib/pluginRuntimeBridge";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import {
  BudgetMeter,
  CoverageGlyph,
  COVERAGE_LABEL,
  RailSection,
} from "./marketplaceUi";
import {
  SURFACE_LABELS,
  formatBytes,
  type MachineCoverageRow,
  type MarketplaceListing,
} from "./marketplaceModel";

/**
 * The three rail sections that report on a plugin rather than describe it:
 * where it is, what it is allowed to add, and what it is storing.
 *
 * Each one is independently degradable. A host that publishes no presence shows
 * one machine; one that cannot install remotely shows the other machines as
 * coverage with no controls; one that cannot toggle contributions lists them
 * read-only; one that cannot read usage omits the meter. None of those become an
 * error, because none of them stop the page answering what it was opened for.
 */

/**
 * The machine matrix.
 *
 * The one rail section that exists because ADE is multi-machine: a plugin is
 * installed per machine, so "is it installed" has no single answer and a single
 * Install button would be answering the wrong question. Each row carries the
 * action that machine can take, and a machine that could not be reached says so
 * instead of claiming the plugin is missing there.
 */
export function MachineRail({
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
  /** False → the other machines are shown as coverage only, with no controls. */
  canRemote: boolean;
  supportsPresence: boolean;
  loading: boolean;
  onInstallOn: (machineKey: string, isThisMachine: boolean) => void;
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
                    onClick={() => onInstallOn(row.machineKey, row.isThisMachine)}
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
      ) : !canRemote && rows.length > 1 ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim, lineHeight: 1.5 }}>
          Install and turn off from the machine itself — this build only changes plugins here.
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
export function ContributionsRail({
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

export function UsageRail({ usage }: { usage: PluginUsageRow }) {
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
