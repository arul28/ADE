import React from "react";
import { ArrowSquareOut, Cpu, Database, FolderOpen, Globe, LinkSimple, Package, Plugs, Plus, Sparkle, SquaresFour, Terminal, User } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { SettingsText } from "../settings/primitives/SettingsControls";
// The system browser: this button fires from inside an open dialog, so a page
// loaded into ADE's built-in browser pane would land somewhere nobody is
// looking and the button would read as doing nothing.
import { openExternalUrl } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
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
 * From the Marketplace's own Install button it is not, so the dialog reads the
 * source first when the host can (`inspectSource`) and otherwise says plainly
 * that it will read the manifest during install rather than pretending to know.
 *
 * That second entry point takes a repository URL OR a folder on this machine —
 * `resolvePluginInstallSource` has always tried a local directory before git,
 * so a plugin someone just wrote installs from here. It read as URL-only
 * because every word on the screen said URL and nothing offered a folder, which
 * is how a user with a working plugin on disk concluded ADE could not take it.
 */

/**
 * The machine an install acts on, when a control names one.
 *
 * Only the machine matrix does — every other entry point installs on whichever
 * machine the page's plugin calls already reach. Carried here rather than
 * resolved inside the dialog because the row the reader pressed is the only
 * thing that knows which machine they meant.
 */
export type InstallDialogMachine = {
  machineKey: string;
  machineName: string;
  isThisMachine: boolean;
};

export type InstallDialogTarget =
  | {
    kind: "listing";
    listing: MarketplaceListing;
    /** Absent → whichever machine this page's plugin calls already reach. */
    machine?: InstallDialogMachine;
    /**
     * `update` only changes the wording. An update replaces running code with
     * code nobody here has read, so it discloses exactly as an install does and
     * goes through this same dialog.
     */
    intent?: "install" | "update";
  }
  /**
   * The source-first form. `source` pre-fills the field and reads the manifest
   * immediately, which is how the in-chat approval card's "View in Marketplace"
   * hands a candidate over: the reader gets the full disclosure page for the
   * exact source they were asked about, without the card having to grow a
   * second copy of it.
   */
  | { kind: "url"; source?: string };

type Phase =
  | { status: "idle" }
  | { status: "inspecting" }
  | { status: "installing" }
  | { status: "error"; message: string };

/**
 * The native folder picker, or null where there isn't one.
 *
 * The hosted web client answers every unimplemented preload member with a stub
 * callable (`webclient/adapter/infra/proxy.ts`), and its own `chooseDirectory`
 * resolves `null` unconditionally — so `typeof … === "function"` is not evidence
 * there, and a button gated on it alone would open nothing on web. The web-client
 * flag is the only reliable half of the test; the `typeof` guard covers a desktop
 * preload older than the channel.
 */
function nativeFolderPicker():
  | ((args: { title?: string; defaultPath?: string }) => Promise<string | null>)
  | null {
  if (typeof window === "undefined" || isWebClientMode()) return null;
  const choose = window.ade?.project?.chooseDirectory;
  return typeof choose === "function" ? choose : null;
}

function addLineIcon(line: string) {
  if (line.includes(" tab") || line.includes(" pane")) return SquaresFour;
  if (line.includes("addition")) return Plus;
  if (line.startsWith("Terminal commands")) return Terminal;
  if (/agent skill/i.test(line)) return Sparkle;
  if (line.startsWith("Turns ") && line.includes("chips")) return LinkSimple;
  if (line.startsWith("Stores data")) return Database;
  if (line.startsWith("Runs code")) return Cpu;
  if (line.startsWith("Talks to")) return Globe;
  if (line.startsWith("Signs you in") || line.startsWith("Asks to use")) return User;
  if (line.includes("listens on port")) return Plugs;
  if (line.startsWith("Issue pickers")) return SquaresFour;
  return Package;
}

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
  const [picking, setPicking] = React.useState(false);
  const folderPicker = React.useMemo(nativeFolderPicker, []);

  const open = target !== null;
  const handedSource = target?.kind === "url" ? target.source?.trim() ?? "" : "";
  React.useEffect(() => {
    if (open) return;
    // Reset on close, not on open: resetting on open would clobber a URL the
    // caller pre-filled, and leaving state behind would show the previous
    // plugin's details for a frame the next time it opens.
    setSourceInput("");
    setResolved(null);
    setPhase({ status: "idle" });
    setPicking(false);
  }, [open]);

  /**
   * Take the handed-in source once per open.
   *
   * Keyed on the source rather than on `open` so re-renders do not re-inspect,
   * and a `sourceInput` the reader has since edited is left alone: the effect
   * runs when the HANDOFF changes, not when the field does. Reading the manifest
   * here is the point of the handoff — the disclosure is what the reader came
   * for, and making them press a button to see it would waste the trip.
   */
  const inspectRef = React.useRef<(override?: string) => Promise<void>>();
  React.useEffect(() => {
    if (!open || !handedSource) return;
    setSourceInput(handedSource);
    setResolved(null);
    setPhase({ status: "idle" });
    if (capabilities.inspect) void inspectRef.current?.(handedSource);
  }, [capabilities.inspect, handedSource, open]);

  const listing = target?.kind === "listing" ? target.listing : resolved;
  const source = target?.kind === "listing" ? target.listing.source : sourceInput.trim();
  const adds = listing ? describePluginAdds(listing) : [];
  // Only when the manifest is actually in hand. A directory listing carries no
  // manifest, and claiming a timing boundary for a plugin whose skills nobody
  // has read yet would be a guess — the note lands on the detail page once the
  // install has read it for real.
  const declaresSkill = (listing?.manifest?.skills.length ?? 0) > 0;
  const busy = phase.status === "installing" || phase.status === "inspecting" || picking;

  /**
   * Read a source's manifest.
   *
   * Takes the source explicitly rather than closing over `sourceInput`: the
   * folder picker sets the field and inspects in the same tick, and a read of
   * the state variable there would inspect the source the field held BEFORE the
   * pick — showing the previous plugin's "Adds" list under the new path.
   */
  const inspect = async (override?: string) => {
    // Not `target`: that name is the dialog's own prop one scope out.
    const readSource = override ?? source;
    if (!readSource) return;
    setPhase({ status: "inspecting" });
    try {
      const inspection = await inspectPluginSource(readSource);
      const parsed = inspection ? parsePluginManifest(inspection.manifest) : null;
      if (parsed?.manifest) {
        setResolved(listingFromManifest(parsed.manifest, readSource));
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

  inspectRef.current = inspect;

  const chooseFolder = async () => {
    if (!folderPicker) return;
    setPicking(true);
    try {
      const picked = await folderPicker({ title: "Choose the plugin folder" });
      // Cancelling leaves the field exactly as it was — a cancel that wiped a
      // typed URL would be worse than doing nothing.
      if (!picked) return;
      setSourceInput(picked);
      // Cleared before the read, not after: leaving the previous source's
      // listing up would show one plugin's "Adds" under another one's path for
      // as long as the inspection takes.
      setResolved(null);
      setPhase({ status: "idle" });
      if (capabilities.inspect) await inspect(picked);
    } catch (cause) {
      setPhase({
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not open the folder picker.",
      });
    } finally {
      setPicking(false);
    }
  };

  const install = async () => {
    if (!source) return;
    setPhase({ status: "installing" });
    try {
      const machine = target?.kind === "listing" ? target.machine : undefined;
      const result = await installPlugin({
        source,
        ...(listing?.pluginId ? { pluginId: listing.pluginId } : {}),
        ...(target?.kind === "listing" ? { version: target.listing.version } : {}),
        // No `machineKey` for this machine: the host reads its own presence key
        // as "install somewhere else" and takes the remote path, which fails.
        ...(machine && !machine.isThisMachine ? { machineKey: machine.machineKey } : {}),
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
  const updating = target?.kind === "listing" && target.intent === "update";
  const verb = updating ? "Update" : "Install";
  const onMachine = target?.kind === "listing" && target.machine && !target.machine.isThisMachine
    ? ` on ${target.machine.machineName}`
    : "";
  const title = listing ? `${verb} ${listing.displayName}${onMachine}` : "Install a plugin";

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
            {phase.status === "installing"
              ? `${updating ? "Updating" : "Installing"}…`
              : source || (folderPicker
                ? "Paste a repository URL, or choose a folder"
                : "Paste a repository URL")}
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
              {phase.status === "installing" ? `${updating ? "Updating" : "Installing"}…` : verb}
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
              Repository URL or folder
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
                placeholder="https://github.com/owner/repo · or a folder"
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
              {/* The affordance the field was missing. A local folder has always
                  installed — `resolvePluginInstallSource` tries a directory
                  before git — but with no picker and URL-only wording, someone
                  holding a plugin they just wrote read the Marketplace as having
                  no way to take it. */}
              {folderPicker ? (
                <button
                  type="button"
                  onClick={() => void chooseFolder()}
                  disabled={busy}
                  style={{ ...outlineButton({ height: 30, fontSize: 11.5 }), flexShrink: 0 }}
                >
                  <FolderOpen size={12} weight="regular" aria-hidden />
                  {picking ? "Choosing…" : "Choose folder…"}
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
            <ul style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "grid",
              gap: 8,
              maxHeight: "min(36vh, 280px)",
              overflowY: "auto",
            }}>
              {adds.map((line) => {
                const Icon = addLineIcon(line);
                return (
                  <li
                    key={line}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      fontFamily: SANS_FONT,
                      fontSize: 11.5,
                      color: COLORS.textSecondary,
                      lineHeight: 1.5,
                    }}
                  >
                    <Icon size={14} weight="duotone" style={{ flexShrink: 0, marginTop: 1, color: COLORS.textMuted }} />
                    <span>{line}</span>
                  </li>
                );
              })}
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
          {/* Only for a source the system browser can actually open. The
              external-URL bridge rejects every non-http(s) scheme silently, so
              offering "View source" for a folder path — now that folders are an
              advertised way in — would be a button that does nothing. */}
          {/^https?:\/\//i.test(source) ? (
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
