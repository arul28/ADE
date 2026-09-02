import React from "react";

import { AdeCard } from "../../chat/AdeCard";
import { PluginPanelHost } from "../PluginPanelHost";
import { pluginIdentity } from "../pluginIcons";
import { useRootAppStore } from "../../../state/appStore";
import { SocketBoundary } from "./SocketBoundary";
import { useSurfaceContributions } from "./useSurfaceContributions";
import { pluginSessionContext } from "./surfaceContexts";
import { handlePluginChatCardAction } from "./pluginChatCardBridge";
import {
  readAdeCardAuthor,
  readAdeCardPanel,
  type AdeCardPayload,
} from "../../../../shared/adeCard";

/**
 * The `chat-card` socket: a plugin's panel, drawn inside a transcript card.
 *
 * Two halves that have to meet, and this component is where they do:
 *
 * - **The card** supplies chronology. A transcript row has a position in a
 *   conversation; a `plugin_contributions` row does not. So the plugin PLACES
 *   the card by emitting an `ade_card` through `chat.emitAdeCard`, which is
 *   also what gives it `cardId` merge-on-re-emit, `navTarget`, and the
 *   fallback text every non-desktop client already knows how to draw.
 * - **The socket** supplies permission. The panel renders only when the plugin
 *   DECLARED a `chat-card` contribution naming this `panelId` — which is what
 *   makes the user's per-contribution toggle work, and what stops an emit from
 *   painting an arbitrary panel into a conversation.
 *
 * When the declaration is missing the card still renders, without the panel.
 * That is the honest degradation: the title, rows and metrics the plugin also
 * sent are real, and a blank frame would say less than they do.
 *
 * Live updates come from `PluginPanelHost`, which re-reads the panel and its
 * bound collections whenever the host reports the plugin's data changed —
 * exactly as a panel behaves in a tab or a detail section. Nothing about a
 * panel is re-fetched by re-emitting the card.
 */
export function PluginChatCard({
  card,
  sessionId,
  sessionTitle,
  provider,
  active = true,
  onAction,
}: {
  card: AdeCardPayload;
  /** The chat this row lives in. Null in a preview with no session. */
  sessionId: string | null;
  sessionTitle?: string | null;
  provider?: string | null;
  /** False while the transcript is mounted but not visible. */
  active?: boolean;
  /** Card action dispatcher, unchanged from an ordinary `ade_card`. */
  onAction?: (actionId: string) => void;
}) {
  const author = readAdeCardAuthor(card);
  const panel = readAdeCardPanel(card);
  const pluginId = author?.pluginId ?? null;

  /**
   * The byline's glyph: the plugin's own, not a puzzle piece.
   *
   * Read off the installed summary — the same manifest `icon` the approval card,
   * the tab rail and the Marketplace draw — and resolved through
   * `pluginIdentity`, so a brand token works here too and a plugin that named no
   * icon gets the glyph it is drawn as everywhere else rather than a fallback
   * this one surface invented. A card from a plugin no longer installed keeps
   * the puzzle piece, which is the honest answer: nothing left to read an icon
   * from.
   */
  const installed = useRootAppStore((state) => state.installedPlugins);
  const authorIcon = React.useMemo(() => {
    if (!pluginId) return undefined;
    const summary = installed.find((entry) => entry.pluginId === pluginId);
    if (!summary) return undefined;
    return pluginIdentity({
      pluginId,
      icon: summary.icon,
      accent: summary.accent,
      brandIcons: summary.brandIcons,
    }).Icon;
  }, [installed, pluginId]);

  /**
   * Which of this card's buttons is running, so the pressed one can say so and
   * refuse a second press.
   *
   * Per-action, following `PluginActivityEntries`: a plugin action is a round
   * trip to another process and a card routinely offers several. One shared
   * flag would grey out buttons the user never touched, and no flag at all
   * makes a double-click two invokes — which for "Approve" or "Deploy" is two
   * of whatever the plugin does.
   */
  const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);

  /**
   * Dispatch this card's button press to its plugin.
   *
   * Called directly rather than through the window broadcast the bridge also
   * listens on: the press arrived here, at the one card that owns it, and the
   * direct call is what returns a promise — which is the only way the button
   * can know when to stop saying "working". The bridge's own listener stays for
   * cards drawn outside this component.
   */
  const dispatch = React.useCallback((actionId: string) => {
    if (!pluginId) return;
    if (pendingActionId === actionId) return;
    setPendingActionId(actionId);
    void Promise.resolve(handlePluginChatCardAction({
      actionId,
      cardId: card.cardId,
      variant: card.variant,
      pluginId,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(provider ? { provider } : {}),
    })).finally(() => {
      setPendingActionId((current) => (current === actionId ? null : current));
    });
  }, [card.cardId, card.variant, pendingActionId, pluginId, provider, sessionId, sessionTitle]);

  const handleAction = React.useCallback((actionId: string) => {
    if (pluginId) {
      dispatch(actionId);
      return;
    }
    onAction?.(actionId);
  }, [dispatch, onAction, pluginId]);

  /**
   * The session this card belongs to, as the plugin sees it.
   *
   * Also what selects the plugin's dynamic `chat-card` rows: a plugin that
   * publishes a per-session contribution can point one conversation's card at a
   * different panel than another's.
   */
  const context = React.useMemo(
    () => (sessionId
      ? pluginSessionContext({ id: sessionId, title: sessionTitle ?? "", provider: provider ?? null })
      : null),
    [provider, sessionId, sessionTitle],
  );

  // A plugin card with no panel has nothing to resolve, so it must not put a
  // contribution fetch on every transcript row that carries one.
  const contributions = useSurfaceContributions("work", "chat-card", {
    active: active && Boolean(panel),
    ...(context ? { context } : {}),
  });

  const declared = React.useMemo(
    () => (pluginId && panel
      ? contributions.some(
        (entry) => entry.pluginId === pluginId && entry.payload.panelId === panel.panelId,
      )
      : false),
    [contributions, panel, pluginId],
  );

  if (!pluginId || !panel || !declared) {
    return (
      <AdeCard
        card={card}
        onAction={handleAction}
        pendingActionId={pendingActionId}
        {...(authorIcon ? { authorIcon } : {})}
      />
    );
  }

  return (
    <AdeCard
      card={card}
      onAction={handleAction}
      pendingActionId={pendingActionId}
      {...(authorIcon ? { authorIcon } : {})}
      panel={(
        <SocketBoundary>
          <PluginPanelHost
            pluginId={pluginId}
            panelId={panel.panelId}
            active={active}
            {...(panel.context ? { renderContext: panel.context } : {})}
            {...(context ? { surfaceContext: context } : {})}
          />
        </SocketBoundary>
      )}
    />
  );
}
