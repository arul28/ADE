import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Trash } from "@phosphor-icons/react";

export function ComposerSmartLinkMenu({
  anchor,
  onClose,
  onRemove,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  onRemove: (anchor: HTMLElement) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const url = anchor.dataset.smartLinkUrl ?? "";

  useLayoutEffect(() => {
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const width = 224;
      setPosition({
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        top: Math.max(8, rect.top - 8),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Link actions"
      className="fixed z-[1000] flex -translate-y-full overflow-hidden rounded-lg border border-white/[0.08] bg-[color:color-mix(in_srgb,var(--chat-panel-bg-strong)_95%,black_5%)] shadow-[0_16px_42px_rgba(0,0,0,0.48)] backdrop-blur-xl"
      style={{ left: position.left, top: position.top, width: 224 }}
    >
      <button
        type="button"
        role="menuitem"
        className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium text-fg/78 transition-colors hover:bg-violet-500/[0.10] hover:text-violet-100"
        onClick={() => {
          void window.ade.app.writeClipboardText(url);
          onClose();
        }}
      >
        <Copy size={13} weight="bold" />
        Copy link
      </button>
      <div className="w-px bg-white/[0.06]" />
      <button
        type="button"
        role="menuitem"
        className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium text-fg/78 transition-colors hover:bg-red-500/[0.10] hover:text-red-200"
        onClick={() => onRemove(anchor)}
      >
        <Trash size={13} weight="bold" />
        Remove link
      </button>
    </div>,
    document.body,
  );
}
