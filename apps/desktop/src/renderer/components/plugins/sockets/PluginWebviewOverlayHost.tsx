import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { X } from "@phosphor-icons/react";

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
  const Icon = pluginIcon(resolved?.icon ?? undefined);

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
                    {resolved.title}
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
                        panelId={resolved.panelId}
                        active
                        {...(request.subject ? { surfaceContext: request.subject } : {})}
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

export default PluginWebviewOverlayHost;
