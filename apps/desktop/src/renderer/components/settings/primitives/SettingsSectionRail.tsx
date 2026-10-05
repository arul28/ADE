import { useCallback, useEffect, useRef, useState } from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

export type SettingsRailEntry = { id: string; title: string };

/**
 * A sticky list of the sections on one settings page, with the one you are
 * looking at marked. Clicking an entry scrolls to it.
 *
 * Drawn only where the page has room: the CSS container query hides the rail
 * below the split width. `TabContent` leaves it out for a page with fewer than
 * two named sections.
 */
export function SettingsSectionRail({ entries }: { entries: readonly SettingsRailEntry[] }) {
  const railRef = useRef<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null);
  // The page hands over a fresh array each render; the listeners follow the
  // sections, not the array.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const entriesKey = entries.map((entry) => entry.id).join("\u0000");

  useEffect(() => {
    // The nearest scrollable ancestor — the settings page's own scroller. It is
    // the frame the "which section am I looking at" question is measured in.
    let root: HTMLElement | null = railRef.current?.parentElement ?? null;
    while (root) {
      const overflowY = window.getComputedStyle(root).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      root = root.parentElement;
    }
    if (!root) return undefined;
    const scroller = root;
    const update = () => {
      // A section counts as current once its top passes under this line, 96px
      // below the scroller's own top.
      const threshold = scroller.getBoundingClientRect().top + 96;
      const sections = entriesRef.current;
      let current = sections[0]?.id ?? null;
      for (const entry of sections) {
        const element = document.getElementById(entry.id);
        if (element && element.getBoundingClientRect().top <= threshold) current = entry.id;
      }
      setActiveId(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [entriesKey]);

  const jump = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  return (
    <nav ref={railRef} className="ade-settings-rail" aria-label="On this page">
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {entries.map((entry) => {
          const active = entry.id === activeId;
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => jump(entry.id)}
                aria-current={active ? "true" : undefined}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "5px 10px",
                  border: "none",
                  borderRadius: 7,
                  background: active ? "var(--shell-sidebar-item-active-bg)" : "transparent",
                  color: active ? COLORS.textPrimary : COLORS.textMuted,
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  letterSpacing: "-0.01em",
                  cursor: "pointer",
                }}
              >
                {entry.title}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
