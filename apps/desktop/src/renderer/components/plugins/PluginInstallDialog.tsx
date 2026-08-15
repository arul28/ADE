import React from "react";
import { ArrowSquareOut, Package } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { SettingsText } from "../settings/primitives/SettingsControls";
// The system browser: this button fires from inside an open dialog, so a page
// loaded into ADE's built-in browser pane would land somewhere nobody is
// looking and the button would read as doing nothing.
import { openExternalUrl } from "../../lib/openExternal";
import { useRootAppStore } from "../../state/appStore";
import {
  inspectPluginSource,
  installPlugin,
  pluginMarketplaceCapabilities,
} from "../../lib/pluginRuntimeBridge";
import { parsePluginManifest } from "../../../shared/plugins/manifest";
import { PLUGIN_SKILL_NEXT_TURN_NOTE } from "../../../shared/plugins/clientRendering";
import { pluginIdentity } from "./pluginIcons";
import { OfficialBadge, PluginIconTile } from "./marketplaceUi";
import {
  describePluginAdds,
  listingFromManifest,
  type MarketplaceListing,
} from "./marketplaceModel";

/**
 * The install confirmation.
 *
 * This dialog is the whole of ADE's plugin permission model, so what it says
 * matters more than what it does. Design decision D-permissions: plugins are
 * ambient — there is no capability picker, no per-permission checkbox — because
 * a plugin runs code on your machine and a checklist that implies otherwise is
 * theatre. What the reader gets instead is the two things that are actually
 * decidable: exactly what the plugin will add, derived from its own manifest,
 * and a link to the source before they agree.
 *
 * Two entry points share it. From the gallery the manifest is already in hand.
 * From "Install from URL" it is not, so the dialog reads the source first when
 * the host can (`inspectSource`) and otherwise says plainly that it will read
 * the manifest during install rather than pretending to know.
 */

export type InstallDialogTarget =
  | { kind: "listing"; listing: MarketplaceListing }
  | { kind: "url" };

type Phase =
  | { status: "idle" }
  | { status: "inspecting" }
  | { status: "installing" }
  | { status: "error"; message: string };

export function PluginInstallDialog({
  target,
  onOpenChange,
  onInstalled,
}: {
  /** Null closes the dialog. */
  target: InstallDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onInstalled?: (pluginId: string) => void;
}) {
  const capabilities = React.useMemo(() => pluginMarketplaceCapabilities(), []);
  const refreshInstalledPlugins = useRootAppStore((state) => state.refreshInstalledPlugins);

  const [sourceInput, setSourceInput] = React.useState("");
  const [resolved, setResolved] = React.useState<MarketplaceListing | null>(null);
  const [phase, setPhase] = React.useState<Phase>({ status: "idle" });

  const open = target !== null;
  React.useEffect(() => {
    if (open) return;
    // Reset on close, not on open: resetting on open would clobber a URL the
    // caller pre-filled, and leaving state behind would show the previous
    // plugin's details for a frame the next time it opens.
    setSourceInput("");
    setResolved(null);
    setPhase({ status: "idle" });
  }, [open]);

  const listing = target?.kind === "listing" ? target.listing : resolved;
  const source = target?.kind === "listing" ? target.listing.source : sourceInput.trim();
  const adds = listing ? describePluginAdds(listing) : [];
  // Only when the manifest is actually in hand. A directory listing carries no
  // manifest, and claiming a timing boundary for a plugin whose skills nobody
  // has read yet would be a guess — the note lands on the detail page once the
  // install has read it for real.
  const declaresSkill = (listing?.manifest?.skills.length ?? 0) > 0;
  const busy = phase.status === "installing" || phase.status === "inspecting";

  const inspect = async () => {
    if (!source) return;
    setPhase({ status: "inspecting" });
    try {
      const inspection = await inspectPluginSource(source);
      const parsed = inspection ? parsePluginManifest(inspection.manifest) : null;
      if (parsed?.manifest) {
        setResolved(listingFromManifest(parsed.manifest, source));
        setPhase({ status: "idle" });
        return;
      }
      // A source ADE could read but not parse is a real answer, not a blank:
      // installing it would fail on the same manifest a moment later.
      setPhase(parsed
        ? { status: "error", message: parsed.errors[0] ?? "That source has no usable plugin manifest." }
        : { status: "idle" });
    } catch (cause) {
      setPhase({
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not read that source.",
      });
    }
  };

  const install = async () => {
    if (!source) return;
    setPhase({ status: "installing" });
    try {
      const result = await installPlugin({
        source,
        ...(listing?.pluginId ? { pluginId: listing.pluginId } : {}),
        ...(target?.kind === "listing" ? { version: target.listing.version } : {}),
      });
      await refreshInstalledPlugins();
      onInstalled?.(result.pluginId);
      onOpenChange(false);
    } catch (cause) {
      setPhase({
        status: "error",
        message: cause instanceof Error ? cause.message : "The install did not finish.",
      });
    }
  };

  const identity = listing ? pluginIdentity(listing) : null;
  const title = listing ? `Install ${listing.displayName}` : "Install from a URL";

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      icon={Package}
      busy={busy}
      widthClassName="w-[min(560px,calc(100vw-1rem))]"
      footer={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, minWidth: 0 }}>
            {phase.status === "installing" ? "Installing…" : source || "Paste a repository URL"}
          </span>
          <span style={{ display: "inline-flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              style={outlineButton({ height: 30, fontSize: 12 })}
            >
              Cancel
            </button>
            <button
              type="button"
              data-tour="plugin:marketplace.install-confirm"
              onClick={() => void install()}
              disabled={busy || !source || !capabilities.install}
              style={{
                ...primaryButton({ height: 30, fontSize: 12 }),
                opacity: busy || !source || !capabilities.install ? 0.5 : 1,
                cursor: busy || !source ? "default" : "pointer",
              }}
            >
              {phase.status === "installing" ? "Installing…" : "Install"}
            </button>
          </span>
        </div>
      }
    >
      <div style={{ display: "grid", gap: 16 }}>
        {target?.kind === "url" ? (
          <div style={{ display: "grid", gap: 6 }}>
            <label
              htmlFor="plugin-install-source"
              style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}
            >
              Repository URL
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <SettingsText
                id="plugin-install-source"
                value={sourceInput}
                onChange={(value) => {
                  setSourceInput(value);
                  setResolved(null);
                  if (phase.status === "error") setPhase({ status: "idle" });
                }}
                placeholder="https://github.com/owner/repo"
                mono
                width="100%"
              />
              {capabilities.inspect ? (
                <button
                  type="button"
                  onClick={() => void inspect()}
                  disabled={busy || sourceInput.trim().length === 0}
                  style={outlineButton({ height: 30, fontSize: 11.5 })}
                >
                  {phase.status === "inspecting" ? "Reading…" : "Check"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {listing && identity ? (
          <div
            style={{
              display: "flex",
              gap: 12,
              padding: 12,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: RADII.md,
            }}
          >
            <PluginIconTile identity={identity} size={34} label={listing.displayName} />
            <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                  {listing.displayName}
                </span>
                {listing.official ? <OfficialBadge /> : null}
              </span>
              <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
                {listing.author} · version {listing.version}
              </span>
              {listing.description ? (
                <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.5 }}>
                  {listing.description}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 8 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, fontWeight: 600, color: COLORS.textPrimary }}>
            Adds
          </span>
          {adds.length > 0 ? (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
              {adds.map((line) => (
                <li
                  key={line}
                  style={{
                    display: "flex",
                    gap: 8,
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
          ) : (
            <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.5 }}>
              ADE reads the plugin’s manifest while installing and shows what it adds once it is in.
            </p>
          )}
          {/* A skill is the one thing in that list whose effect is not
              immediate, and this is the last screen before the decision. The
              approval card already says it; a reader who clicked Install here
              instead was the only one who never heard it. */}
          {declaresSkill ? (
            <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, lineHeight: 1.5 }}>
              {PLUGIN_SKILL_NEXT_TURN_NOTE}
            </p>
          ) : null}
        </div>

        {/* The disclosure. Short on purpose — a long notice is one nobody
            reads, and the sentence has to survive being the only thing read. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            background: "color-mix(in srgb, var(--color-fg) 3%, transparent)",
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: RADII.md,
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              color: COLORS.textSecondary,
              lineHeight: 1.5,
            }}
          >
            Runs with the same access as tools you install yourself.
          </span>
          {source ? (
            <button
              type="button"
              onClick={() => openExternalUrl(source)}
              style={{
                ...outlineButton({ height: 26, padding: "0 9px", fontSize: 11 }),
                background: "transparent",
              }}
            >
              View source
              <ArrowSquareOut size={11} weight="regular" aria-hidden />
            </button>
          ) : null}
        </div>

        {phase.status === "error" ? (
          <div
            style={{
              display: "grid",
              gap: 4,
              padding: "10px 12px",
              background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 22%, transparent)",
              borderRadius: RADII.md,
            }}
          >
            <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, fontWeight: 600, color: COLORS.textPrimary }}>
              That didn’t work
            </span>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.5 }}>
              {phase.message}
            </span>
          </div>
        ) : null}

        {!capabilities.install ? (
          <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.5 }}>
            This build can’t install plugins. Open ADE on the machine you want the plugin on.
          </span>
        ) : null}
      </div>
    </LaneDialogShell>
  );
}
