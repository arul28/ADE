/**
 * Named CSS Custom Highlights shared by several owners.
 *
 * `CSS.highlights` is one registry for the whole document, and several
 * surfaces paint the same highlight names at once (two chats in a grid, a chat
 * and a diff). Each owner files its ranges under its own id; every publish
 * rebuilds the group's named highlights from all owners.
 *
 * Ranges are added one by one: spreading them into the `Highlight`
 * constructor throws a RangeError past V8's argument limit (~120k), which a
 * one-character find over a large diff can reach.
 */
type HighlightGroup<Name extends string> = {
  publish: (ownerId: string, next: Partial<Record<Name, readonly Range[]>> | null) => void;
};

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && Boolean(CSS.highlights) && typeof Highlight === "function";
}

export function createHighlightGroup<Name extends string>(names: readonly Name[]): HighlightGroup<Name> {
  const byOwner = new Map<string, Partial<Record<Name, readonly Range[]>>>();
  return {
    publish(ownerId, next) {
      if (next) byOwner.set(ownerId, next);
      else if (!byOwner.delete(ownerId)) return;
      if (!highlightsSupported()) return;
      for (const name of names) {
        const highlight = new Highlight();
        for (const entry of byOwner.values()) {
          for (const range of entry[name] ?? []) highlight.add(range);
        }
        if (highlight.size) CSS.highlights.set(name, highlight);
        else CSS.highlights.delete(name);
      }
    },
  };
}
