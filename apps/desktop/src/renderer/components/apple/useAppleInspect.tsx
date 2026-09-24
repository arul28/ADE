import React, { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { IosElementContextItem, OpenProjectBinding } from "../../../shared/types";
import { AppleInspectOverlay } from "./AppleInspectOverlay";
import { appleCommandForElement, appleElementContextItem } from "./appleDeviceState";
import { inspectContextFor, type IosSimulatorSnapshotElement } from "./appleInspectGeometry";

type DeviceToView = ((point: { x: number; y: number }) => { x: number; y: number }) | null;

/**
 * Inspect (§A4) for the Apple pane: one screen snapshot per switch-on, the
 * hovered and selected element, and the overlay drawn over the picture.
 */
export function useAppleInspect({
  deviceUdid,
  live,
  laneId,
  projectRoot,
  runtimePinRef,
  onAddContext,
  onInsertDraft,
  onElements,
  onError,
}: {
  deviceUdid: string | null;
  /** The device is streaming; a snapshot is only taken then. */
  live: boolean;
  laneId: string | null;
  projectRoot: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onAddContext?: ((item: IosElementContextItem) => void) | undefined;
  onInsertDraft?: ((text: string) => void) | undefined;
  /** Each snapshot, for what else it tells (the orientation). */
  onElements: (elements: IosSimulatorSnapshotElement[]) => void;
  onError: (cause: unknown) => void;
}): {
  inspectOn: boolean;
  toggleInspect: () => void;
  renderInspectOverlay: (deviceToView: DeviceToView) => React.ReactNode;
} {
  const [inspectOn, setInspectOn] = useState(false);
  const [inspectElements, setInspectElements] = useState<IosSimulatorSnapshotElement[]>([]);
  const [inspectHovered, setInspectHovered] = useState<string | null>(null);
  const [inspectSelected, setInspectSelected] = useState<string | null>(null);
  // Read through refs so a new closure from the pane never re-takes a snapshot.
  const onElementsRef = useRef(onElements);
  onElementsRef.current = onElements;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const toggleInspect = useCallback(() => {
    setInspectOn((on) => !on);
    setInspectSelected(null);
    setInspectHovered(null);
  }, []);

  /**
   * One snapshot per switch-on. The frames describe the screen as it was when
   * Inspect was turned on; driving the device is off while it is on, so they
   * cannot go stale underneath the pointer.
   */
  useEffect(() => {
    if (!inspectOn || !deviceUdid || !live) {
      if (!inspectOn) setInspectElements([]);
      return undefined;
    }
    let cancelled = false;
    void window.ade.iosSimulator
      .getScreenSnapshot({ deviceUdid, laneId, projectRoot }, runtimePinRef.current)
      .then((snapshot) => {
        if (cancelled) return;
        const elements = snapshot.elements ?? [];
        setInspectElements(elements);
        onElementsRef.current(elements);
      })
      .catch((cause: unknown) => {
        if (!cancelled) onErrorRef.current(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceUdid, inspectOn, laneId, live, projectRoot, runtimePinRef]);

  // Escape closes the card wherever the focus happens to be (§A4).
  useEffect(() => {
    if (!inspectSelected) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInspectSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectSelected]);

  const insertInspectElement = useMemo(() => {
    if (!onAddContext && !onInsertDraft) return undefined;
    return (element: IosSimulatorSnapshotElement) => {
      try {
        if (onAddContext) onAddContext(appleElementContextItem(element));
        else onInsertDraft?.(inspectContextFor(element, inspectElements));
      } catch (cause: unknown) {
        // `workToolContextInsertion` throws with the reason when there is no
        // chat, draft or CLI session to insert into. Say it, never swallow it.
        onErrorRef.current(cause);
      }
    };
  }, [inspectElements, onAddContext, onInsertDraft]);

  const copyInspectElement = useCallback((element: IosSimulatorSnapshotElement) => {
    void window.ade.app.writeClipboardText(appleCommandForElement(element)).catch(() => {});
  }, []);

  const renderInspectOverlay = useCallback((deviceToView: DeviceToView) => {
    if (!inspectOn) return null;
    return (
      <AppleInspectOverlay
        elements={inspectElements}
        deviceToView={deviceToView}
        hoveredRef={inspectHovered}
        selectedRef={inspectSelected}
        onHover={setInspectHovered}
        onSelect={setInspectSelected}
        onInsertIntoChat={insertInspectElement}
        onCopy={copyInspectElement}
      />
    );
  }, [
    copyInspectElement,
    insertInspectElement,
    inspectElements,
    inspectHovered,
    inspectOn,
    inspectSelected,
  ]);

  return { inspectOn, toggleInspect, renderInspectOverlay };
}
