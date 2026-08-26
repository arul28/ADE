import React from "react";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import type { PluginSocketKind, PluginSurfaceId } from "../../../../shared/plugins/sockets";
import { useRootAppStore } from "../../../state/appStore";
import { pluginIcon } from "../pluginIcons";
import { PluginPanelHost } from "../PluginPanelHost";
import { PluginWebviewHost, supportsPluginWebviews } from "../PluginWebviewHost";
import { contributionKey } from "./contributionModel";
import { pluginPanelSlotId } from "./panelSlotId";
import { SocketBoundary } from "./SocketBoundary";
import { SocketIcon } from "./socketUi";
import { usePluginSurfaceContributions, useSurfaceContributions } from "./useSurfaceContributions";

/**
 * The two panel-host sockets — `work-rail-pane` and `drawer-tab` — as one
 * mechanism.
 *
 * They share a payload for a reason stated in the taxonomy (`sockets.ts`): they
 * are the same contribution wearing different chrome, a labelled icon-bearing
 * entry that reveals a panel. Sharing the payload but not the code would have
 * meant two answers to the questions neither payload asks — what a slot's
 * persisted id looks like, whether an entry survives the plugin being disabled,
 * and who draws the attribution — so the mechanism lives here once and the two
 * hosts contribute only their own chrome.
 *
 * Together they are what stops the Work rail's six entries and the drawer's
 * five tabs from being literals only ADE can extend — the built-in panes become
 * a template rather than a privilege.
 */

/**
 * A contributed pane or tab, flattened for a host that draws its own chrome.
 *
 * A projection rather than the contribution itself because both hosts feed a
 * `GlowMenu`, which wants `{id, label, icon}` and knows nothing about plugins.
 */
export type PluginPanelSlot = {
  /** The persisted slot id — what the host stores as its selected tab. */
  id: string;
  /** React key: contribution identity, which `id` alone does not carry. */
  key: string;
  pluginId: string;
  panelId: string;
  label: string;
  /** Resolved Phosphor component, so a host can hand it straight to GlowMenu. */
  icon: ReturnType<typeof pluginIcon>;
  /** The plugin's own name, for the attribution line and the tab tooltip. */
  displayName: string;
  /**
   * The plugin-relative HTML page to draw INSTEAD of the panel, when this slot's
   * `panelId` also names a `webview` surface of the same plugin and this client
   * can host a guest. Absent on every other client and every ordinary slot, so
   * its absence is what makes {@link PluginSlotPanel} fall back to the panel —
   * which is the surface's own declared cross-client fallback. Reveal-gated by
   * the host's `active` exactly as the panel is: nothing loads until shown.
   */
  entryHtml?: string;
};

/**
 * The contributed slots for one host, in the host's placement order.
 *
 * Always after the surface's own entries — the caller concatenates, and
 * invariant 1 is why it never interleaves. The result keeps its identity until
 * the contributions themselves change, which matters because the Work rail
 * derives a Set from it and feeds that Set into the availability rule three
 * separate consumers memo on.
 */
export function usePluginPanelSlots(
  surface: PluginSurfaceId,
  socket: Extract<PluginSocketKind, "work-rail-pane" | "drawer-tab">,
  options: { active?: boolean; context?: PluginSurfaceContext | null } = {},
): PluginPanelSlot[] {
  const active = options.active ?? true;
  const context = options.context ?? null;
  const contributions = useSurfaceContributions(surface, socket, {
    active,
    ...(context ? { context } : {}),
  });
  const { identities } = usePluginSurfaceContributions(surface, active);
  // The plugin registry, for resolving a slot's `panelId` to a `webview`
  // surface. A slot draws the plugin's own HTML page when it names one AND this
  // client can host a guest; otherwise it draws the panel, which is the webview
  // surface's own required fallback. Read once here rather than per slot.
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const webviewSupported = supportsPluginWebviews();

  return React.useMemo(
    () => {
      // `id` is derived from `panelId`, and nothing upstream forbids two socket
      // entries of one plugin from naming the same panel — the manifest only
      // makes the socket `id` unique. Two slots sharing an `id` would be a
      // duplicate React key in the host's `GlowMenu` AND a tab that can never be
      // selected, because both the rail and the drawer resolve a selection by
      // finding the FIRST slot with that id. First declaration wins, which is
      // the one that resolution would have picked anyway.
      const seen = new Set<string>();
      const slots: PluginPanelSlot[] = [];
      for (const contribution of contributions) {
        const id = pluginPanelSlotId(contribution.pluginId, contribution.payload.panelId);
        if (seen.has(id)) continue;
        seen.add(id);
        const identity = identities.get(contribution.pluginId);
        // A `webview` surface of the same plugin whose panel this slot names is
        // what turns the slot into a custom-HTML host. Matched on `panelId`
        // because that is the link the surface already declares — a webview
        // surface names the very panel every non-desktop client renders in its
        // place — so no new manifest field is needed to point a drawer tab at a
        // page. Resolved only where a guest can run; elsewhere `entryHtml` stays
        // absent and the panel is drawn.
        const entryHtml = webviewSupported
          ? installedPlugins
            .find((plugin) => plugin.pluginId === contribution.pluginId)
            ?.tabs.find(
              (tab) => tab.kind === "webview"
                && tab.panelId === contribution.payload.panelId
                && Boolean(tab.entryHtml),
            )
            ?.entryHtml ?? undefined
          : undefined;
        slots.push({
          id,
          key: contributionKey(contribution),
          pluginId: contribution.pluginId,
          panelId: contribution.payload.panelId,
          label: contribution.payload.label,
          icon: pluginIcon(contribution.payload.icon),
          displayName: identity?.displayName ?? contribution.pluginId,
          ...(entryHtml ? { entryHtml } : {}),
        });
      }
      return slots;
    },
    [contributions, identities, installedPlugins, webviewSupported],
  );
}

/**
 * The body behind a contributed pane or tab.
 *
 * The attribution header is not decoration. A rail pane sits where Git and
 * Files sit and a drawer tab sits where Proof and Handoff sit, so without a
 * line naming its owner a third-party panel reads as a part of ADE — and the
 * one thing a user needs to be able to do about a panel that misbehaves is know
 * whose it is.
 */
export function PluginSlotPanel({
  slot,
  active = true,
  context,
}: {
  slot: PluginPanelSlot;
  /** False while the host is mounted but not showing this slot. */
  active?: boolean;
  /** The subject this panel's actions receive. Omit where there is none. */
  context?: PluginSurfaceContext | null;
}) {
  const header = (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.textMuted,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.sm,
      }}
    >
      <SocketIcon size={12} color={COLORS.textMuted} />
      <span>{slot.displayName}</span>
    </header>
  );

  // A webview slot fills the host: the header sits on top and the guest takes
  // the rest, the same full-container shape a webview tab or pane has. The
  // subject the host injects is whatever the slot was given — the chat a drawer
  // tab sits on — and the page reads it as `adePlugin.context.subject`, never
  // claiming it. `active` reveal-gates the guest exactly as it does the panel.
  if (slot.entryHtml) {
    return (
      <SocketBoundary>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
          {header}
          <PluginWebviewHost
            pluginId={slot.pluginId}
            entryHtml={slot.entryHtml}
            active={active}
            context={{ subject: context ?? null }}
          />
        </div>
      </SocketBoundary>
    );
  }

  return (
    <SocketBoundary>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {header}
        <PluginPanelHost
          pluginId={slot.pluginId}
          panelId={slot.panelId}
          active={active}
          {...(context ? { surfaceContext: context } : {})}
        />
      </div>
    </SocketBoundary>
  );
}
