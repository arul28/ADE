import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { CaretLeft, X } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { fadeScale } from "../../../lib/motion";
import { useRootAppStore } from "../../../state/appStore";
import { pluginIcon } from "../pluginIcons";
import { PluginPanelHost } from "../PluginPanelHost";
import { PluginWebviewHost, supportsPluginWebviews } from "../PluginWebviewHost";
import { closePluginWebviewOverlay, usePluginWebviewOverlay } from "./pluginWebviewOverlayStore";

/**
 * The one focused overlay a plugin button can summon over the app.
 *
 * Mounted once in `AppShell`, it draws whatever `pluginWebviewOverlayStore`
 * holds: a plugin's own `webview` surface, filling a large dismissible modal,
 * with the subject the button sat on injected into the page. It is the
 * highest-integration, lowest-cost custom-UI host — any plugin button, anywhere,
 * can open rich HTML on top of what the user was doing — because it reuses the
 * whole webview stack and adds only a modal frame around it.
 *
 * Everything about a single guest holds here: one open at a time (the store
 * replaces), reveal-gated (nothing loads until this renders), and full-container
 * (the guest fills the body, so no size protocol). On a client that cannot host
 * a guest, or for a surface that turned out not to be a webview, the surface's
 * required panel is drawn instead — the same cross-client fallback a webview tab
 * has.
 */
export function PluginWebviewOverlayHost() {
  const request = usePluginWebviewOverlay();
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);

  const resolved = React.useMemo(() => {
    if (!request) return null;
    const plugin = installedPlugins.find((entry) => entry.pluginId === request.pluginId);
    if (!plugin || !plugin.enabled) return null;
    const surface = plugin.tabs.find((tab) => tab.id === request.surfaceId) ?? null;
    if (!surface) return null;
    const entryHtml = surface.kind === "webview" && surface.entryHtml && supportsPluginWebviews()
      ? surface.entryHtml
      : null;
    return {
      pluginId: plugin.pluginId,
      displayName: plugin.displayName,
      icon: plugin.icon,
      accent: plugin.accent,
      brandIcons: plugin.brandIcons,
      title: surface.title,
      panelId: surface.panelId,
      entryHtml,
    };
  }, [installedPlugins, request]);

  // A request that no longer resolves — the plugin was disabled or uninstalled,
  // or names a surface that is gone — closes the overlay rather than showing an
  // empty frame, the same way the drawer falls off a plugin tab that vanished.
  React.useEffect(() => {
    if (request && !resolved) closePluginWebviewOverlay();
  }, [request, resolved]);

  const open = Boolean(request && resolved);
  const Icon = pluginIcon(resolved?.icon ?? undefined, resolved?.brandIcons);
  const stack = usePluginOverlayStack(resolved?.panelId ?? null, resolved?.title ?? null);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : closePluginWebviewOverlay())}>
      <AnimatePresence>
        {open && request && resolved ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-2xl"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild onOpenAutoFocus={(event) => event.preventDefault()}>
              <motion.div
                className="fixed left-1/2 top-1/2 z-[130] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl focus:outline-none"
                style={{
                  width: "min(1040px, 92vw)",
                  height: "min(760px, 86vh)",
                  background: "var(--color-popup-bg)",
                  border: `1px solid ${COLORS.borderMuted}`,
                  boxShadow: "0 36px 100px -28px rgba(0,0,0,0.88), 0 0 0 1px rgba(167,139,250,0.14)",
                  ...(resolved.accent ? ({ "--plugin-accent": resolved.accent } as React.CSSProperties) : {}),
                }}
                variants={fadeScale}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <div
                  className="flex items-center gap-2 border-b px-4 py-3"
                  style={{ borderColor: COLORS.borderMuted }}
                >
                  {/* The way back out of a panel the plugin navigated into.
                      Before the stack existed the `{navigate}` verb was DROPPED
                      here — the overlay passed no `onNavigate` at all — so a
                      panel that sent the reader to a detail view did nothing
                      visible and the plugin had no way to learn why. */}
                  {stack.canGoBack ? (
                    <button
                      type="button"
                      onClick={stack.goBack}
                      aria-label={`Back to ${stack.previousTitle}`}
                      title={`Back to ${stack.previousTitle}`}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[var(--color-muted-fg)] transition-colors hover:bg-white/10 hover:text-fg"
                      style={{ fontFamily: SANS_FONT, fontSize: 12 }}
                    >
                      <CaretLeft size={13} weight="regular" aria-hidden />
                      <span
                        style={{
                          maxWidth: 160,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {stack.previousTitle}
                      </span>
                    </button>
                  ) : null}
                  <Icon size={15} weight="regular" color={COLORS.textMuted} aria-hidden />
                  <Dialog.Title
                    style={{
                      margin: 0,
                      fontFamily: SANS_FONT,
                      fontSize: 13,
                      fontWeight: 600,
                      color: COLORS.textPrimary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {stack.title ?? resolved.title}
                  </Dialog.Title>
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 11,
                      color: COLORS.textDim,
                    }}
                  >
                    · {resolved.displayName}
                  </span>
                  <div style={{ flex: 1 }} />
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => closePluginWebviewOverlay()}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted-fg)] transition-colors hover:bg-white/10 hover:text-fg"
                    >
                      <X size={14} weight="regular" />
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="sr-only">
                  A page from the {resolved.displayName} plugin.
                </Dialog.Description>
                <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
                  {resolved.entryHtml ? (
                    <PluginWebviewHost
                      pluginId={resolved.pluginId}
                      entryHtml={resolved.entryHtml}
                      active
                      context={{
                        subject: request.subject,
                        ...(request.pointer ? { pointer: request.pointer } : {}),
                      }}
                    />
                  ) : (
                    <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 20 }}>
                      <PluginPanelHost
                        pluginId={resolved.pluginId}
                        panelId={stack.panelId ?? resolved.panelId}
                        active
                        {...(stack.context ? { renderContext: stack.context } : {})}
                        {...(request.subject ? { surfaceContext: request.subject } : {})}
                        onNavigate={stack.push}
                      />
                    </div>
                  )}
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/**
 * One entry of the overlay's own back stack.
 *
 * The title is carried rather than looked up: a panel reached by `{navigate}` is
 * not a declared surface, so the manifest has no title for it, and the honest
 * label for the way back is the title of the panel the reader came FROM — which
 * this entry is.
 */
export type PluginOverlayFrame = {
  panelId: string;
  title: string;
  context?: Record<string, unknown>;
};

/**
 * The push half of the stack, as a pure function.
 *
 * Out of the hook so it can be tested as what it is — four rules about an array
 * — rather than through a modal that needs the app store, a Radix portal and a
 * motion runtime to say anything at all.
 */
export function pushPluginOverlayFrame(
  frames: readonly PluginOverlayFrame[],
  navigation: { panelId: string; context?: Record<string, unknown> },
  root: { panelId: string | null; title: string | null },
): readonly PluginOverlayFrame[] {
  const currentId = frames[frames.length - 1]?.panelId ?? root.panelId;
  // A navigation to the panel already on top REPLACES it. The plugin is
  // re-addressing the screen the reader is on — usually with a new context —
  // and pushing would leave a Back that goes nowhere visible.
  if (navigation.panelId === currentId) {
    if (frames.length === 0) return frames;
    const replaced: PluginOverlayFrame = {
      panelId: navigation.panelId,
      title: frames[frames.length - 1]?.title ?? root.title ?? navigation.panelId,
      ...(navigation.context ? { context: navigation.context } : {}),
    };
    return [...frames.slice(0, -1), replaced];
  }
  const next = [
    ...frames,
    {
      panelId: navigation.panelId,
      title: navigation.panelId,
      ...(navigation.context ? { context: navigation.context } : {}),
    },
  ];
  // Capped, oldest dropped. A plugin that navigates in a loop must not be able
  // to grow this without bound; the reader keeps the eight screens they can
  // plausibly remember walking through.
  return next.length > PLUGIN_OVERLAY_STACK_MAX
    ? next.slice(next.length - PLUGIN_OVERLAY_STACK_MAX)
    : next;
}

/**
 * The panel stack inside the plugin overlay.
 *
 * A tab has the router: `PluginTabPage` writes `?panel=` with `replace: false`,
 * so Back is the browser's and costs nothing. The overlay has no address — it is
 * a modal over whatever the reader was doing — so it needs its own, and this is
 * it: the same push/pop/replace/cap rules the phone's pane sheet follows, so a
 * plugin's navigation behaves the same in both places.
 *
 * Panel STATE is not restored here, unlike on the phone. `PluginPanelHost` drops
 * its filters, ticks and folds whenever `panelId` changes, and threading a
 * snapshot back through it would mean giving the host a second way to be told
 * what its state is. Named as the deferred half rather than half-built.
 */
function usePluginOverlayStack(rootPanelId: string | null, rootTitle: string | null) {
  const [frames, setFrames] = React.useState<readonly PluginOverlayFrame[]>([]);

  // A different overlay is a different stack. Cleared on the ROOT panel rather
  // than on every render, so a republish of the surface the reader is inside
  // does not throw away the way back.
  React.useEffect(() => {
    setFrames([]);
  }, [rootPanelId]);

  const push = React.useCallback(
    (navigation: { panelId: string; context?: Record<string, unknown> }) => {
      setFrames((previous) => pushPluginOverlayFrame(
        previous,
        navigation,
        { panelId: rootPanelId, title: rootTitle },
      ));
    },
    [rootPanelId, rootTitle],
  );

  const goBack = React.useCallback(() => {
    setFrames((previous) => (previous.length === 0 ? previous : previous.slice(0, -1)));
  }, []);

  const top = frames[frames.length - 1] ?? null;
  const beneath = frames[frames.length - 2] ?? null;
  return {
    panelId: top?.panelId ?? null,
    context: top?.context ?? null,
    title: top?.title ?? null,
    canGoBack: frames.length > 0,
    previousTitle: beneath?.title ?? rootTitle ?? "back",
    push,
    goBack,
  };
}

/**
 * How deep the overlay's back stack goes.
 *
 * Eight, the same number the phone's pane uses. It is a bound on a plugin's
 * ability to grow the stack, not a design target: nobody walks eight panels
 * deep in a modal, and a plugin that tries has already lost the reader.
 */
export const PLUGIN_OVERLAY_STACK_MAX = 8;

export default PluginWebviewOverlayHost;
