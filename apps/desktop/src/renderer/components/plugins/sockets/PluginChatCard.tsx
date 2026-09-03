import React from "react";

import { AdeCard } from "../../chat/AdeCard";
import { PluginPanelHost } from "../PluginPanelHost";
import { PluginWebviewHost, supportsPluginWebviews } from "../PluginWebviewHost";
import { pluginIdentity } from "../pluginIcons";
import { resolvePluginDeclaredWebview } from "./pluginDeclaredWebview";
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
 * How tall a page drawn inside a transcript card is.
 *
 * A card is a row in a conversation the reader scrolls, so its body cannot
 * size itself to whatever a page asks for: a page reporting 2,000 pixels would
 * push the rest of the conversation off the screen, and the transcript's own
 * scroll anchoring would fight the guest's. A fixed frame with the page
 * scrolling inside it is the honest shape, and it is the same rule a rail pane
 * keeps — which is why the placement a card's page is told is `pane`.
 */
const PLUGIN_CHAT_CARD_PAGE_HEIGHT = 320;

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

  /**
   * The declaration that permits this card to draw a panel at all, and the page
   * it may draw instead.
   *
   * One search rather than two: the contribution that permits the panel is also
   * the one that names the page, so a card whose plugin declared
   * `webviewSurfaceId` draws its own HTML — the `issue-context` case, where the
   * transcript row is the issue as the plugin renders it everywhere else —
   * while a card whose plugin declared none keeps the vocabulary panel. The
   * PERMISSION is unchanged either way: an emit still cannot paint a panel or a
   * page the manifest did not declare for this `panelId`.
   */
  const declaration = React.useMemo(
    () => (pluginId && panel
      ? contributions.find(
        (entry) => entry.pluginId === pluginId && entry.payload.panelId === panel.panelId,
      ) ?? null
      : null),
    [contributions, panel, pluginId],
  );
  const declared = declaration !== null;

  const webviewSupported = supportsPluginWebviews();
  const page = React.useMemo(
    () => (pluginId
      ? resolvePluginDeclaredWebview({
        pluginId,
        surfaceId: declaration?.payload.webviewSurfaceId,
        installed,
        supported: webviewSupported,
      })
      : null),
    [declaration, installed, pluginId, webviewSupported],
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
          {page ? (
            // A card body is a frame the transcript already sized, so the guest
            // fills it exactly as a rail pane's does — `pane` is the placement
            // the page is told, and `ui.resize` is read and dropped there. The
            // subject is the chat this row lives in, injected by the host and
            // unforgeable; `panel.context` rides as the plugin's own pointer,
            // which is what tells the page WHICH issue this card is about.
            <div style={{ display: "flex", height: PLUGIN_CHAT_CARD_PAGE_HEIGHT, minHeight: 0 }}>
              <PluginWebviewHost
                pluginId={pluginId}
                entryHtml={page.entryHtml}
                active={active}
                placement="pane"
                surfaceId={page.surfaceId}
                context={{
                  subject: context ?? null,
                  ...(panel.context ? { pointer: panel.context } : {}),
                }}
              />
            </div>
          ) : (
            <PluginPanelHost
              pluginId={pluginId}
              panelId={panel.panelId}
              active={active}
              {...(panel.context ? { renderContext: panel.context } : {})}
              {...(context ? { surfaceContext: context } : {})}
            />
          )}
        </SocketBoundary>
      )}
    />
  );
}
