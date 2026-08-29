import React from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";

import type { PendingInputRequest } from "../../../shared/types";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";
import { navigateToAppTarget } from "../../lib/openExternal";
import { pluginIdentity } from "../plugins/pluginIcons";
import { PluginIconTile } from "../plugins/marketplaceUi";
import { ProviderLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";

/**
 * Who a pending-input card says is asking.
 *
 * One module because two surfaces draw the same header — the approval banner in
 * `AgentChatComposer` and the question composer in `AskQuestionComposer` — and
 * the whole defect this fixes was those headers naming the host instead of the
 * asker. Two copies of that decision would fix one card and leave the other.
 *
 * The rule: a request carrying a plugin {@link PendingInputRequest.origin} is
 * drawn as that plugin — its own icon, its own name — and everything else is
 * drawn exactly as it was, by `source`.
 */

/** "Focus · Approval" for a plugin card; "Codex asks" for everything else. */
export function pendingInputAskerLabel(request: PendingInputRequest): string {
  return pendingInputHeaderLabel(request.source, request.kind, {
    displayName: request.origin?.kind === "plugin" ? request.origin.displayName : null,
  });
}

/**
 * The mark beside that label.
 *
 * A plugin gets the Marketplace's own tile, resolved through `pluginIdentity`,
 * so a `brand:*` token draws the vendor's mark and a plugin that named no icon
 * gets the same derived glyph-and-colour it has in the gallery and the tab rail.
 * Drawing it any other way would give one plugin two faces.
 */
export function PendingInputAskerMark({
  request,
  size,
  className,
}: {
  request: PendingInputRequest;
  size: number;
  className?: string;
}) {
  const origin = request.origin?.kind === "plugin" ? request.origin : null;
  if (!origin) return <ProviderLogo family={request.source} size={size} className={className} />;
  const identity = pluginIdentity({
    pluginId: origin.pluginId,
    icon: origin.icon ?? null,
    accent: origin.accent ?? null,
  });
  return (
    <span data-testid="pending-input-plugin-mark" data-plugin-id={origin.pluginId}>
      <PluginIconTile identity={identity} size={size} label={origin.displayName} />
    </span>
  );
}

/**
 * Where "View in Marketplace" goes, or null when the card is not about a plugin.
 *
 * Two destinations, because a plugin being installed for the first time has no
 * Marketplace page yet. The catalogue is the bundled index plus the registry
 * plus what is installed, so a folder on this machine is in none of them, and a
 * detail route for it would be a 404 dressed as a link.
 *
 * - **Official** (`trust: "official"`, the plugins ADE ships) and anything the
 *   host is asking about because it is already installed — a remove, a disable,
 *   an enable — have a page. Go to it.
 * - **Everything else** hands the Marketplace's own install dialog the source,
 *   which reads the manifest and shows the full disclosure page. That is the
 *   cheap correct version of "let me see the whole thing before I answer": no
 *   candidate detail route, no second copy of the disclosure, and the reader
 *   lands on the surface that already knows how to render one.
 *
 * Either way this is a LINK. It never answers the card — see
 * `PendingInputMarketplaceLink`.
 */
export function pendingInputMarketplaceRoute(request: PendingInputRequest): string | null {
  const origin = request.origin?.kind === "plugin" ? request.origin : null;
  if (!origin) return null;
  const metadata = request.providerMetadata ?? {};
  const isInstall = metadata.pluginInstall === true;
  const official = metadata.trust === "official";
  if (!isInstall || official) return `/marketplace/${encodeURIComponent(origin.pluginId)}`;
  const source = typeof metadata.source === "string" ? metadata.source.trim() : "";
  if (!source.length) return `/marketplace/${encodeURIComponent(origin.pluginId)}`;
  return `/marketplace?install=${encodeURIComponent(source)}`;
}

/**
 * The link itself.
 *
 * Deliberately not shaped like the decision buttons beside it and deliberately
 * not one of them: the approval row answers the card and settles the agent's
 * blocked call, and a control that merely navigates must not be mistakable for
 * one that does. It carries the external-link glyph every other "this opens
 * somewhere else" affordance in chat uses, sits on its own line under the
 * buttons, and leaves the card open behind it.
 *
 * Desktop only. The phone's card has no Marketplace to open — plugins are
 * installed from a machine, not from the companion.
 */
export function PendingInputMarketplaceLink({
  request,
  className,
}: {
  request: PendingInputRequest;
  className?: string;
}) {
  const route = pendingInputMarketplaceRoute(request);
  if (!route) return null;
  return (
    <button
      type="button"
      data-testid="pending-input-marketplace-link"
      data-route={route}
      onClick={() => navigateToAppTarget({ kind: "route", route })}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1 py-0.5 font-sans",
        "text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/45",
        "underline decoration-fg/20 underline-offset-2 transition-colors",
        "hover:text-fg/75 hover:decoration-fg/45",
        className,
      )}
    >
      <ArrowSquareOut size={11} weight="regular" aria-hidden />
      View in Marketplace
    </button>
  );
}
