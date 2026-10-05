import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { LinkSimple } from "@phosphor-icons/react";

import type { OpenProjectBinding } from "../../../shared/types/core";
import { ContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";

/**
 * Right-clicking a link in chat used to do nothing, which left clicking it
 * (and then digging the URL back out of the address bar) as the only way to
 * get the URL anywhere. This gives the two things a link is for: copy it, or
 * open it somewhere other than where the default would send it.
 *
 * Shared by both chat markdown renderers so a link behaves the same whether it
 * is in a reply, a user bubble, or a proposed-plan card.
 */
export function useChatLinkContextMenu(runtimePin: OpenProjectBinding | null | undefined): {
  onContextMenu: (event: MouseEvent, href: string | undefined | null) => void;
  menu: ReactNode;
} {
  const [anchor, setAnchor] = useState<{ x: number; y: number; href: string } | null>(null);

  const onContextMenu = useCallback((event: MouseEvent, href: string | undefined | null) => {
    if (!href) return;
    event.preventDefault();
    // The window's own context menu (and any row-level one) must not also fire.
    event.stopPropagation();
    setAnchor({ x: event.clientX, y: event.clientY, href });
  }, []);

  const close = useCallback(() => setAnchor(null), []);

  const entries = useMemo<ContextMenuEntry[]>(
    () =>
      anchor
        ? [
            {
              kind: "item",
              key: "copy",
              label: "Copy link",
              icon: LinkSimple,
              onSelect: () => {
                void copyLink(anchor.href);
              },
            },
            {
              kind: "open-link-in",
              key: "open-in",
              url: anchor.href,
              runtimePin: runtimePin ?? null,
            },
          ]
        : [],
    [anchor, runtimePin],
  );

  // Portalled: chat rows animate with `motion`, and a transform anywhere above
  // a `position: fixed` menu makes it anchor to that ancestor instead of the
  // viewport.
  const menu =
    anchor && entries.length > 0 ? (
      <ContextMenu
        menu={{ x: anchor.x, y: anchor.y }}
        entries={entries}
        onClose={close}
        label="Link"
        portal
      />
    ) : null;

  return { onContextMenu, menu };
}

async function copyLink(href: string): Promise<void> {
  const bridge = window.ade?.app?.writeClipboardText;
  if (typeof bridge === "function") {
    try {
      await bridge(href);
      return;
    } catch {
      // Fall through to the web API.
    }
  }
  try {
    await navigator.clipboard?.writeText(href);
  } catch {
    // Nothing else to try; the URL stays visible in the link itself.
  }
}
