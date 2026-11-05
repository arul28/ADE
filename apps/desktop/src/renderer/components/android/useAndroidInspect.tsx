import React, { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidUiElement } from "../../../shared/types/androidEmulator";
import { DeviceInspectOverlay, type DeviceInspectAdapter } from "../device/DeviceInspectOverlay";

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
 * Inspect for the Android pane: one UI tree per switch-on, the hovered and
 * picked element, and the shared overlay over the picture. Driving the device
 * is off while Inspect is on, so the boxes cannot go stale under the pointer.
 */
export function useAndroidInspect({
  laneId,
  live,
  runtimePinRef,
  onInsertDraft,
  onError,
}: {
  laneId: string;
  live: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onInsertDraft?: ((text: string) => void) | undefined;
  onError: (cause: unknown) => void;
}): {
  inspectOn: boolean;
  inspectLoading: boolean;
  toggleInspect: () => void;
  renderInspectOverlay: (deviceToView: DeviceToView) => React.ReactNode;
} {
  const [inspectOn, setInspectOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elements, setElements] = useState<AndroidUiElement[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const toggleInspect = useCallback(() => {
    setInspectOn((on) => !on);
    setSelected(null);
    setHovered(null);
  }, []);

  useEffect(() => {
    if (!inspectOn || !live) {
      if (!inspectOn) setElements([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    void window.ade.androidEmulator
      .getScreenSnapshot({ laneId, fresh: true }, runtimePinRef.current)
      .then((snapshot) => {
        if (!cancelled) setElements(snapshot.elements);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        onErrorRef.current(cause);
        setInspectOn(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectOn, laneId, live, runtimePinRef]);

  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const insert = useMemo(() => {
    if (!onInsertDraft) return undefined;
    return (element: AndroidUiElement) => {
      try {
        onInsertDraft(androidElementContext(element));
      } catch (cause: unknown) {
        // No chat, draft or CLI to insert into: say why.
        onErrorRef.current(cause);
      }
    };
  }, [onInsertDraft]);

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
  }, [copy, elements, hovered, insert, inspectOn, selected]);

  return { inspectOn, inspectLoading: loading, toggleInspect, renderInspectOverlay };
}
