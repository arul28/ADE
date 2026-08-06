import { useCallback, useMemo, useState } from "react";

/**
 * Per-surface collapsed-section memory.
 *
 * Two surfaces, two keys, on purpose: the popover is a glance and the pane is a
 * work session, and the shape you want each in is rarely the same — collapsing
 * Done in the dropdown should not fold it away in the full list you opened
 * precisely to read it. New settings get new keys; the `ade:attention:notch-*`
 * keys stay frozen wire for anyone who already made a choice on this Mac.
 */
export type ActivityCollapseSurface = "popover" | "pane";

const KEY_BY_SURFACE: Record<ActivityCollapseSurface, string> = {
  popover: "ade:activity:collapsed-sections-popover",
  pane: "ade:activity:collapsed-sections-pane",
};

function readCollapsed(surface: ActivityCollapseSurface): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY_BY_SURFACE[surface]);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or older value must not throw a header off the screen.
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function writeCollapsed(surface: ActivityCollapseSurface, ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_BY_SURFACE[surface], JSON.stringify([...ids]));
  } catch {
    // A restricted renderer still collapses for this session; only the memory
    // of it is lost, which is not worth failing a click over.
  }
}

export type ActivitySectionCollapse = {
  isCollapsed: (sectionId: string) => boolean;
  toggle: (sectionId: string) => void;
};

export function useActivitySectionCollapse(
  surface: ActivityCollapseSurface,
): ActivitySectionCollapse {
  const [collapsed, setCollapsed] = useState<string[]>(() => readCollapsed(surface));

  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);

  const toggle = useCallback((sectionId: string) => {
    setCollapsed((current) => {
      const next = current.includes(sectionId)
        ? current.filter((entry) => entry !== sectionId)
        : [...current, sectionId];
      writeCollapsed(surface, next);
      return next;
    });
  }, [surface]);

  return {
    isCollapsed: useCallback(
      (sectionId: string) => collapsedSet.has(sectionId),
      [collapsedSet],
    ),
    toggle,
  };
}

/** Test seam: clears both surfaces' memory. */
export function resetActivitySectionCollapseForTests(): void {
  if (typeof window === "undefined") return;
  for (const key of Object.values(KEY_BY_SURFACE)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to clear on a restricted renderer.
    }
  }
}
