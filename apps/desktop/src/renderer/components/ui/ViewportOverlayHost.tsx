import type { CSSProperties, ReactNode, Ref } from "react";
import { Z_LAYERS, type ZLayer } from "./zLayers";

type ViewportFrame = Omit<CSSProperties, "position" | "zIndex">;

/** Owns viewport anchoring and the named stacking layer for transient overlays. */
export function ViewportOverlayHost({
  layer,
  children,
  style,
  testId,
  hostRef,
}: {
  layer: ZLayer;
  children: ReactNode;
  style?: CSSProperties;
  testId?: string;
  hostRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={hostRef}
      style={{
        ...style,
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: Z_LAYERS[layer],
      }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** Create the same named viewport layer for DOM-only compositor animations. */
export function createViewportOverlayHost(
  layer: ZLayer,
  frame: ViewportFrame = {},
): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  applyViewportOverlayHostStyle(host, layer, frame);
  return host;
}

/** Reapply host-owned positioning after an animation copies appearance styles. */
export function applyViewportOverlayHostStyle(
  host: HTMLElement,
  layer: ZLayer,
  frame: ViewportFrame = {},
): void {
  Object.assign(host.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: String(Z_LAYERS[layer]),
    ...frame,
  });
}
