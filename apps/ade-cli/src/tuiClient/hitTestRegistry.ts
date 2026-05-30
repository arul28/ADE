import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";

export type HitRect = { x: number; y: number; w: number; h: number };

export type HitMouseEvent = {
  kind: "wheel" | "click" | "drag" | "release" | "move" | "other";
  x: number | null;
  y: number | null;
  direction?: "up" | "down" | "left" | "right";
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
};

export type HitTarget = {
  id: string;
  rect: HitRect;
  onClick?: (ev: HitMouseEvent) => void;
  onHover?: (hovered: boolean) => void;
  onDragStart?: (ev: HitMouseEvent) => void;
  onDrag?: (ev: HitMouseEvent) => void;
  onDrop?: (ev: HitMouseEvent) => void;
  zIndex?: number;
};

export interface HitTestRegistry {
  register(target: HitTarget): void;
  unregister(id: string): void;
  hitTest(x: number, y: number): HitTarget | null;
  hoverTest(x: number, y: number): HitTarget | null;
  clear(): void;
}

function contains(rect: HitRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function bestTarget(targets: HitTarget[], x: number, y: number): HitTarget | null {
  let best: HitTarget | null = null;
  for (const target of targets) {
    if (!contains(target.rect, x, y)) continue;
    if (!best || (target.zIndex ?? 0) >= (best.zIndex ?? 0)) {
      best = target;
    }
  }
  return best;
}

export function createHitTestRegistry(): HitTestRegistry {
  let targets: HitTarget[] = [];
  return {
    register(target) {
      targets = [...targets.filter((entry) => entry.id !== target.id), target];
    },
    unregister(id) {
      targets = targets.filter((entry) => entry.id !== id);
    },
    hitTest(x, y) {
      return bestTarget(targets, x, y);
    },
    hoverTest(x, y) {
      return bestTarget(targets, x, y);
    },
    clear() {
      targets = [];
    },
  };
}

type HitTestContextValue = {
  registry: HitTestRegistry;
  hoveredId: string | null;
};

const HitTestContext = createContext<HitTestContextValue | null>(null);

export function HitTestProvider({
  registry,
  hoveredId,
  children,
}: {
  registry?: HitTestRegistry;
  hoveredId?: string | null;
  children: React.ReactNode;
}) {
  const fallbackRegistry = useMemo(() => createHitTestRegistry(), []);
  const value = useMemo<HitTestContextValue>(() => ({
    registry: registry ?? fallbackRegistry,
    hoveredId: hoveredId ?? null,
  }), [fallbackRegistry, hoveredId, registry]);
  return React.createElement(HitTestContext.Provider, { value }, children);
}

export function useHitTest(): HitTestContextValue {
  const context = useContext(HitTestContext);
  if (!context) {
    throw new Error("useHitTest must be used inside HitTestProvider");
  }
  return context;
}

export function useHoveredHitId(): string | null {
  return useContext(HitTestContext)?.hoveredId ?? null;
}

export function useHitTestTarget(target: HitTarget | null | false | undefined): boolean {
  const { registry, hoveredId } = useHitTest();
  const latestTargetRef = useRef<HitTarget | null>(null);
  latestTargetRef.current = target || null;

  useEffect(() => {
    const latest = latestTargetRef.current;
    if (!latest) return;
    registry.register(latest);
    return () => registry.unregister(latest.id);
  }, [registry, target]);

  return Boolean(target && hoveredId === target.id);
}
