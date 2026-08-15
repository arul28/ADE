import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { setPluginContributionEnabled, type PluginUsageRow } from "../../lib/pluginRuntimeBridge";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import {
  PLUGIN_SKILL_NEXT_TURN_NOTE,
  describePluginClientRendering,
} from "../../../shared/plugins/clientRendering";
import {
  CoverageGlyph,
  COVERAGE_LABEL,
  RailSection,
} from "./marketplaceUi";
import {
  PLUGIN_STORAGE_REASSURANCE,
  SURFACE_LABELS,
  describePluginStorage,
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

/**
 * Which of your devices actually draw this plugin.
 *
 * The section that exists because "installed" and "visible here" are different
 * facts and the page said only the first. A plugin can be installed, enabled,
 * running and publishing rows while a phone shows nothing — because the phone
 * does not draw that kind of contribution. Every layer knew; none of them said
 * it, so a correct platform answer read as a broken plugin
 * (`docs/reports/ade-tipsy-plugin-alpha-ux-retrospective.md`).
 *
 * Resting state is four short lines with no jargon. The socket vocabulary — the
 * words a plugin author writes and a reader has no reason to learn — sits behind
 * the disclosure, next to the only thing it is needed for: naming which addition
 * is missing where.
 */
export function WhereItShowsUpRail({
  manifest,
  showSkillTiming,
}: {
  manifest: PluginManifest | null;
  /** Installed plugins only: the note belongs to an install that just landed. */
  showSkillTiming: boolean;
}) {
  const sockets = manifest?.sockets ?? [];
  const answers = React.useMemo(
    () => describePluginClientRendering(sockets.map((socket) => socket.socket)),
    [sockets],
  );
  const skillNote = showSkillTiming && (manifest?.skills.length ?? 0) > 0;
  if (sockets.length === 0) {
    // Nothing to place, so there is no per-device answer to give. A skill-only
    // plugin still has timing worth saying, and that is the whole section.
    if (!skillNote) return null;
    return (
      <RailSection title="Where it shows up">
        <SkillTimingNote />
      </RailSection>
    );
  }

  const missingOn = answers
    .filter((answer) => answer.absent.length > 0)
    .map((answer) => ({
      label: answer.label,
      names: sockets
        .filter((socket) => answer.absent.includes(socket.socket))
        .map((socket) => socket.label ?? socket.id),
    }));

  return (
    <RailSection title="Where it shows up">
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 1 }}>
        {answers.map((answer) => (
          <li
            key={answer.client}
            style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "4px 0" }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                flexShrink: 0,
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: answer.renders ? COLORS.accent : COLORS.textDim,
              }}
            >
              {answer.renders ? "✓" : "✗"}
            </span>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary, flex: 1 }}>
              {answer.label}
            </span>
            <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim }}>
              {answer.absent.length === 0
                ? "everything it adds"
                : answer.renders
                  ? `${answer.drawn.length} of ${sockets.length}`
                  : "nothing it adds"}
            </span>
          </li>
        ))}
      </ul>

      {missingOn.length > 0 ? (
        <details>
          <summary
            style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, cursor: "pointer" }}
          >
            Details
          </summary>
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {missingOn.map((entry) => (
              <li
                key={entry.label}
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: COLORS.textDim,
                }}
              >
                {`Not drawn on ${entry.label}: ${entry.names.join(", ")}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {skillNote ? <SkillTimingNote /> : null}
    </RailSection>
  );
}

/**
 * The one sentence that explains why an agent mid-answer did not change.
 *
 * Said here rather than only at install time because the question is asked
 * later — the user presses the plugin's button, the reply comes back exactly as
 * before, and this page is where they come to find out why.
 */
function SkillTimingNote() {
  return (
    <p
      style={{
        margin: 0,
        fontFamily: SANS_FONT,
        fontSize: 10.5,
        lineHeight: 1.5,
        color: COLORS.textDim,
      }}
    >
      {PLUGIN_SKILL_NEXT_TURN_NOTE}
    </p>
  );
}

/**
 * Storage, and how much of it is left.
 *
 * Calm until it matters. Two meters and four numbers were the honest report and
 * the wrong one: they were shown at full volume to every reader, nearly all of
 * whom were looking at a plugin using a rounding error of its space, and the
 * only thing the display taught was that this corner of the page never says
 * anything worth reading. So the resting state is one sentence with no numbers,
 * the numbers sit one click away for whoever actually wants them, and the line
 * only raises its voice — a dot, and the figure that is running out — when the
 * plugin is close enough to its ceiling that it is about to change behaviour.
 *
 * The section is not rendered at all for a plugin that cannot store anything —
 * `pluginStoresData` in `marketplaceModel.ts` gates it at the call site.
 */
export function UsageRail({ usage }: { usage: PluginUsageRow }) {
  const report = describePluginStorage(usage);
  const dotColor = report.level === "full" ? COLORS.danger : COLORS.warning;

  return (
    <RailSection title="Synced data">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
        {report.level === "healthy" ? null : (
          <span
            // The sentence beside it already says the state; the dot is where
            // the eye lands, not how the state is communicated.
            aria-hidden
            style={{
              width: 6,
              height: 6,
              marginTop: 5,
              flexShrink: 0,
              borderRadius: 999,
              background: dotColor,
            }}
          />
        )}
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11.5,
            lineHeight: 1.5,
            color: report.level === "healthy" ? COLORS.textSecondary : COLORS.textPrimary,
          }}
        >
          {report.summary}
        </span>
      </div>

      <details data-tour="plugin:marketplace.storage-details">
        <summary
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textMuted,
            cursor: "pointer",
          }}
        >
          Details
        </summary>
        <dl style={{ margin: "8px 0 0", display: "grid", gap: 6 }}>
          {report.details.map((detail) => (
            <div
              key={detail.label}
              style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}
            >
              <dt style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{detail.label}</dt>
              <dd
                style={{
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  color: COLORS.textSecondary,
                  textAlign: "right",
                }}
              >
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
        <p
          style={{
            margin: "8px 0 0",
            fontFamily: SANS_FONT,
            fontSize: 10.5,
            lineHeight: 1.5,
            color: COLORS.textDim,
          }}
        >
          {PLUGIN_STORAGE_REASSURANCE}
        </p>
      </details>
    </RailSection>
  );
}
