import { ComputerTower, Copy, Plugs } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";
import { cardPlacement } from "./ChipHoverCard";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { ContextMenuRows, type ContextMenuEntry } from "../ui/ContextMenu";
import { useMachineFacts } from "./useMachineFacts";

export function MachineChipCardBody({ machineKey }: { machineKey: string }) {
  const facts = useMachineFacts(machineKey);
  if (facts === undefined) return <div className="min-w-[190px] text-[11px] text-fg/45">Loading…</div>;
  if (!facts) return <div className="text-[11px] text-fg/55">Machine details unavailable</div>;
  // Green when reachable, amber asleep, grey offline — the Connections dots.
  const dot = facts.presenceState === "connected" || facts.presenceState === "online"
    ? "bg-emerald-400"
    : facts.presenceState === "asleep" ? "bg-amber-400" : "bg-white/35";
  return (
    <div className="min-w-[190px] max-w-[240px]">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg/90">
        <ComputerTower size={14} weight="regular" />
        <span className="truncate">{facts.name}</span>
        {facts.thisComputer ? <span className="shrink-0 rounded bg-fg/8 px-1 py-0.5 text-[9px] text-fg/55">This computer</span> : null}
      </div>
      {facts.version ? <div className="mt-1 text-[11px] text-fg/55">ADE {facts.version}</div> : null}
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg/65">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="truncate">{facts.route}{facts.latency ? ` · ${facts.latency}` : ""}</span>
      </div>
      {facts.address || facts.route === "ADE relay" ? (
        <div className="mt-0.5 truncate font-mono text-[10px] text-fg/45">{facts.address ?? "via ADE relay"}</div>
      ) : null}
    </div>
  );
}

/**
 * The same card for a machine chip in the prompt box. Composer chips are
 * contenteditable atoms, not React, so the composer hands over the chip's DOM
 * node and this anchors to it. Clicking a chip IS the request, so the actions
 * show at once; nothing here takes focus, so the caret stays in the prompt.
 */
export function ComposerMachineChipPopover({ machineKey, anchor, onClose }: {
  machineKey: string;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const facts = useMachineFacts(machineKey);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (anchor.contains(target) || cardRef.current?.contains(target))) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchor, onClose]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const place = () => {
      const next = cardPlacement(anchor, card);
      setCoords((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : { x: next.x, y: next.y }));
    };
    place();
    // Typing before the chip moves it without resizing the card, so the
    // editor's edits and the window both re-place it too.
    window.addEventListener("input", place, true);
    window.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(card);
    if (anchor.parentElement) observer?.observe(anchor.parentElement);
    return () => {
      window.removeEventListener("input", place, true);
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [anchor]);
  const entries: ContextMenuEntry[] = [
    {
      kind: "item",
      key: "open-connections",
      label: "Open in Connections",
      icon: Plugs,
      tone: "teal",
      onSelect: () => openConnectionsPanel({ tab: "machines", machineId: facts?.machineKey ?? machineKey }),
    },
  ];
  if (facts?.address) {
    const address = facts.address;
    entries.push({ kind: "item", key: "copy-address", label: "Copy address", icon: Copy, onSelect: () => void copyTextToClipboard(address) });
  }
  if (typeof document === "undefined") return null;
  return createPortal(
    <ViewportOverlayHost layer="tooltip">
      <div
        ref={cardRef}
        role="menu"
        aria-label={facts?.name ?? "Machine"}
        // Keep the caret where it is: a press inside the card is not a press
        // in the editor.
        onMouseDown={(event) => event.preventDefault()}
        className="pointer-events-auto absolute min-w-[200px] rounded-lg border border-fg/12 bg-(color:--work-popover-bg) px-2.5 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm"
        style={{ left: coords?.x ?? 0, top: coords?.y ?? 0, visibility: coords ? "visible" : "hidden" }}
      >
        <MachineChipCardBody machineKey={machineKey} />
        <div className="-mx-1.5 mt-2 border-t border-fg/10 pt-1">
          <ContextMenuRows entries={entries} onClose={onClose} />
        </div>
      </div>
    </ViewportOverlayHost>,
    document.body,
  );
}
