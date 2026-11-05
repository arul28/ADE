import React, { useCallback, useMemo, type MutableRefObject } from "react";
import type { IosElementContextItem, OpenProjectBinding } from "../../../shared/types";
import { useDeviceInspect } from "../device/useDeviceInspect";
import { AppleInspectOverlay } from "./AppleInspectOverlay";
import { appleCommandForElement, appleElementContextItem } from "./appleDeviceState";
import { inspectContextFor, type IosSimulatorSnapshotElement } from "./appleInspectGeometry";

type DeviceToView = ((point: { x: number; y: number }) => { x: number; y: number }) | null;

/**
 * Inspect (§A4) for the Apple pane: the shared Inspect state, reading the
 * simulator's screen snapshot, and the Apple overlay over the picture.
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
  const takeSnapshot = useCallback(async (): Promise<IosSimulatorSnapshotElement[]> => {
    if (!deviceUdid) return [];
    const snapshot = await window.ade.iosSimulator.getScreenSnapshot({ deviceUdid, laneId, projectRoot }, runtimePinRef.current);
    return snapshot.elements ?? [];
  }, [deviceUdid, laneId, projectRoot, runtimePinRef]);
  const {
    inspectOn,
    toggleInspect,
    elements: inspectElements,
    hovered: inspectHovered,
    setHovered: setInspectHovered,
    selected: inspectSelected,
    setSelected: setInspectSelected,
    onErrorRef,
  } = useDeviceInspect<IosSimulatorSnapshotElement>({
    live: live && Boolean(deviceUdid),
    takeSnapshot,
    onSnapshot: onElements,
    onError,
  });

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
  }, [inspectElements, onAddContext, onErrorRef, onInsertDraft]);

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
    setInspectHovered,
    setInspectSelected,
  ]);

  return { inspectOn, toggleInspect, renderInspectOverlay };
}
