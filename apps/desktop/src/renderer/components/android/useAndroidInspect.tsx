import React, { useCallback, useMemo, type MutableRefObject } from "react";
import type { IosElementContextItem, OpenProjectBinding } from "../../../shared/types";
import type { AndroidUiElement } from "../../../shared/types/androidEmulator";
import { DeviceInspectOverlay, type DeviceInspectAdapter } from "../device/DeviceInspectOverlay";
import { useDeviceInspect } from "../device/useDeviceInspect";
import { logRendererDebugEvent } from "../../lib/debugLog";

type DeviceToView = ((point: { x: number; y: number }) => { x: number; y: number }) | null;

/** The element's best name: its label, else its text, else its identifier. */
function elementName(element: AndroidUiElement): string | null {
  return element.label?.trim() || element.text?.trim() || element.identifier?.trim() || null;
}

/** The query an agent can pass back: the ref, which stays the same between snapshots. */
export function androidCommandForElement(element: AndroidUiElement): string {
  return `ade android tap-element --ref ${JSON.stringify(element.ref)}`;
}

/** One line for the composer: what the element is, where, and how an agent taps it. */
export function androidElementContext(element: AndroidUiElement): string {
  const name = elementName(element);
  const what = [element.role ?? "Element", name ? `"${name}"` : null].filter(Boolean).join(" ");
  const where = `at (${element.center.x}, ${element.center.y})${element.packageName ? ` in ${element.packageName}` : ""}`;
  return `Android ${what} ${where}. Ref: ${element.ref} (\`${androidCommandForElement(element)}\`)`;
}

/** What the element takes, for the card. */
function abilities(element: AndroidUiElement): string {
  const parts = [
    element.clickable ? "tap" : null,
    element.longClickable ? "long press" : null,
    element.scrollable ? "scroll" : null,
    element.focusable && /EditText|TextField/iu.test(element.role ?? element.className ?? "") ? "text" : null,
  ].filter(Boolean);
  const state = [
    element.enabled ? null : "disabled",
    element.checked === true ? "checked" : null,
    element.selected ? "selected" : null,
    element.password ? "password" : null,
  ].filter(Boolean);
  return [parts.join(", ") || "nothing", ...state].join(" · ");
}

export const ANDROID_INSPECT_ADAPTER: DeviceInspectAdapter<AndroidUiElement> = {
  id: (element) => element.path,
  frame: (element) => element.bounds,
  describe: (element) => {
    const name = elementName(element);
    const bounds = element.bounds;
    return {
      title: name ?? element.role ?? "Element",
      subtitle: element.role ?? element.className ?? "",
      rows: [
        ["Ref", element.ref],
        ["Role", element.role ?? element.className ?? "—"],
        ["Identifier", element.resourceId ?? "—"],
        ["Text", element.text ?? "—"],
        ["Takes", abilities(element)],
        ["Bounds", `${bounds.x},${bounds.y} ${bounds.width}×${bounds.height}`],
      ],
    };
  },
  // The tree position names every ancestor: `0.1.2` has `0.1` and `0`.
  ancestors: (elements, element) => {
    const byPath = new Map(elements.map((candidate) => [candidate.path, candidate]));
    const chain: AndroidUiElement[] = [];
    const parts = element.path.split(".");
    for (let length = parts.length - 1; length > 0; length -= 1) {
      const parent = byPath.get(parts.slice(0, length).join("."));
      if (parent) chain.push(parent);
    }
    return chain;
  },
};

/**
 * Inspect for the Android pane: the shared Inspect state, reading a fresh UI
 * tree, and the shared overlay over the picture. A failed read turns it off.
 */
export function useAndroidInspect({
  laneId,
  live,
  runtimePinRef,
  onInsertDraft,
  onAddContext,
  onError,
}: {
  laneId: string;
  live: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onInsertDraft?: ((text: string) => void) | undefined;
  /** The context chip (Apple's Inspect packet: crop, source file:line). Used first; the draft line is the fallback. */
  onAddContext?: ((item: IosElementContextItem) => void) | undefined;
  onError: (cause: unknown) => void;
}): {
  inspectOn: boolean;
  toggleInspect: () => void;
  renderInspectOverlay: (deviceToView: DeviceToView) => React.ReactNode;
} {
  const takeSnapshot = useCallback(
    async () => (await window.ade.androidEmulator.getScreenSnapshot({ laneId, fresh: true }, runtimePinRef.current)).elements,
    [laneId, runtimePinRef],
  );
  const { inspectOn, toggleInspect, elements, hovered, setHovered, selected, setSelected, onErrorRef } =
    useDeviceInspect<AndroidUiElement>({ live, takeSnapshot, offOnError: true, onError });

  const insert = useMemo(() => {
    if (!onAddContext && !onInsertDraft) return undefined;
    return (element: AndroidUiElement) => {
      void (async () => {
        if (onAddContext) {
          try {
            // On the lane's machine (the pin): the brain reads the element, finds
            // its source in the lane's code and crops it.
            const result = await window.ade.androidEmulator.inspectPoint(
              { laneId, x: element.center.x, y: element.center.y, ref: element.ref, includeScreenshot: true },
              runtimePinRef.current,
            );
            if (result.item) {
              onAddContext(result.item);
              return;
            }
          } catch (cause: unknown) {
            // An older ADE on the machine, or a failed read. The draft line is the
            // fallback; with no draft to insert into, say why.
            if (!onInsertDraft) {
              onErrorRef.current(cause);
              return;
            }
            logRendererDebugEvent("android.inspect_point_failed", { error: cause instanceof Error ? cause.message : String(cause) });
          }
        }
        try {
          onInsertDraft?.(androidElementContext(element));
        } catch (cause: unknown) {
          // No chat, draft or CLI to insert into: say why.
          onErrorRef.current(cause);
        }
      })();
    };
  }, [laneId, onAddContext, onErrorRef, onInsertDraft, runtimePinRef]);

  const copy = useCallback((element: AndroidUiElement) => {
    void window.ade.app.writeClipboardText(androidCommandForElement(element)).catch(() => {});
  }, []);

  const renderInspectOverlay = useCallback((deviceToView: DeviceToView) => {
    if (!inspectOn) return null;
    return (
      <DeviceInspectOverlay<AndroidUiElement>
        tool="android"
        adapter={ANDROID_INSPECT_ADAPTER}
        elements={elements}
        deviceToView={deviceToView}
        hoveredRef={hovered}
        selectedRef={selected}
        onHover={setHovered}
        onSelect={setSelected}
        onInsertIntoChat={insert}
        onCopy={copy}
      />
    );
  }, [copy, elements, hovered, insert, inspectOn, selected, setHovered, setSelected]);

  return { inspectOn, toggleInspect, renderInspectOverlay };
}
