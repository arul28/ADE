import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../ui/cn";

export type ChatActionsDrawerSection = {
  key: string;
  /**
   * One root element, or a component that renders `null` when it has nothing.
   * Sections carry no borders or heights of their own: the drawer draws the
   * dividers between siblings and gives each section its own region.
   */
  content: ReactNode;
  /**
   * Space priority. A section with `priority` keeps its whole content (up to
   * {@link PRIORITY_FLOOR_PX}) when the drawer runs out of room, and the other
   * sections shrink and scroll first.
   */
  priority?: boolean;
};

export const CHAT_ACTIONS_DRAWER_EMPTY_COPY =
  "Nothing here yet. Agents, tasks, proof and sources show up as the chat runs.";

/**
 * The height a section keeps when the drawer runs out of room: its whole
 * content, up to this. Enough for a header and two or three rows.
 */
const SECTION_FLOOR_PX = 160;

/** The floor of a priority section: enough for proof's controls and first row. */
const PRIORITY_FLOOR_PX = 280;

/** How much faster an ordinary section gives up height than a priority one. */
const YIELD_SHRINK = 4;

/**
 * One region per section. The region is as tall as its content until the
 * drawer is full; then the regions share the height and each one scrolls
 * inside. The drawer itself scrolls only when even every section's floor
 * does not fit, so a section is never cut off out of reach.
 *
 * Flexbox does the sharing: every region shrinks from its natural height in
 * proportion to it, so a long section gives up the most. The floor stops a
 * short section from shrinking to its header; it is the smaller of the
 * content's height and {@link SECTION_FLOOR_PX}, measured because CSS cannot
 * take the minimum of a length and a content size.
 */
function DrawerSectionRegion({
  children,
  hidden,
  divided,
  priority = false,
  yieldToPriority = false,
  onEmptyChange,
}: {
  children: ReactNode;
  /** The section rendered nothing; the drawer decides, from `onEmptyChange`. */
  hidden: boolean;
  /** Draw the divider above: this is not the first section with content. */
  divided: boolean;
  /** Keep more of this section when space runs out. */
  priority?: boolean;
  /** Another section has priority: shrink first. */
  yieldToPriority?: boolean;
  onEmptyChange: (empty: boolean) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [floor, setFloor] = useState(0);
  // More below: fade the region's bottom edge so a row cut by the next
  // section reads as "scroll for more", not as a broken row.
  const [moreBelow, setMoreBelow] = useState(false);
  const onEmptyChangeRef = useRef(onEmptyChange);
  onEmptyChangeRef.current = onEmptyChange;
  const priorityRef = useRef(priority);
  priorityRef.current = priority;
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const measure = () => {
      // A section component that renders null leaves this wrapper empty.
      onEmptyChangeRef.current(node.childElementCount === 0);
      setFloor(Math.min(node.offsetHeight, priorityRef.current ? PRIORITY_FLOOR_PX : SECTION_FLOOR_PX));
      updateMoreBelow();
    };
    const scroller = scrollRef.current;
    const updateMoreBelow = () => {
      if (!scroller) return;
      setMoreBelow(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2);
    };
    scroller?.addEventListener("scroll", updateMoreBelow, { passive: true });
    measure();
    // The child-list observer is what un-hides a section that gains content
    // after mount (tasks or proof arrive mid-chat); it must not depend on
    // ResizeObserver being available.
    const children = new MutationObserver(measure);
    children.observe(node, { childList: true });
    if (typeof ResizeObserver === "undefined") {
      return () => {
        children.disconnect();
        scroller?.removeEventListener("scroll", updateMoreBelow);
      };
    }
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    if (scroller) resize.observe(scroller);
    return () => {
      resize.disconnect();
      children.disconnect();
      scroller?.removeEventListener("scroll", updateMoreBelow);
    };
  }, []);
  return (
    <div
      data-testid="chat-actions-drawer-region"
      className={cn(
        "flex min-h-0 shrink flex-col",
        hidden && "hidden",
        divided && "border-t border-fg/[0.06]",
      )}
      style={{ flexBasis: "auto", flexShrink: yieldToPriority ? YIELD_SHRINK : 1, minHeight: floor }}
    >
      <div
        ref={scrollRef}
        data-more-below={moreBelow ? "" : undefined}
        className={cn(
          "min-h-0 overflow-y-auto overscroll-contain",
          moreBelow && "[mask-image:linear-gradient(to_bottom,black_calc(100%-20px),transparent)]",
        )}
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Everything that used to be a chat-actions tab, stacked.
 *
 * The drawer has no predefined areas. Hosts pass only sections that have
 * something to show (falsy entries are dropped), in order: progress (goal,
 * tasks, subagents, background work), proof, sources, Droid missions. A section
 * that turns out empty at render renders `null`, and its region is hidden, so
 * the sibling divider rule and the empty line both still see the truth. There
 * is no tab strip: the header icon is the only control.
 */
export function ChatActionsDrawerPanel({
  sections,
  footer,
}: {
  sections: ReadonlyArray<ChatActionsDrawerSection | null | false | undefined>;
  /**
   * Pinned below the sections and never scrolled away (the chat's account
   * note). Shown with the empty line too. A footer component that renders
   * null leaves no divider behind.
   */
  footer?: ReactNode;
}) {
  const present = sections.filter((section): section is ChatActionsDrawerSection => Boolean(section));
  const [emptyKeys, setEmptyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const setSectionEmpty = useCallback((key: string, empty: boolean) => {
    setEmptyKeys((current) => {
      if (current.has(key) === empty) return current;
      const next = new Set(current);
      if (empty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const shown = present.filter((section) => !emptyKeys.has(section.key));
  const firstShownKey = shown[0]?.key ?? null;
  const priorityShown = shown.some((section) => section.priority);
  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      {/* Sections shrink before this scrolls: it moves only when even their
          smallest heights do not fit (a short pane), so no section is ever cut
          off out of reach. */}
      <div data-testid="chat-actions-drawer-scroll" className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <div data-testid="chat-actions-drawer-sections" className="flex min-h-0 flex-1 flex-col">
          {present.map((section) => (
            <DrawerSectionRegion
              key={section.key}
              hidden={emptyKeys.has(section.key)}
              divided={!emptyKeys.has(section.key) && section.key !== firstShownKey}
              priority={section.priority === true}
              yieldToPriority={priorityShown && section.priority !== true}
              onEmptyChange={(empty) => setSectionEmpty(section.key, empty)}
            >
              {section.content}
            </DrawerSectionRegion>
          ))}
          {/* Shown when no section has anything, including when every one
           * rendered null. */}
          <p
            data-testid="chat-actions-drawer-empty"
            className={cn("px-4 py-4 font-sans text-[12px] leading-5 text-fg/40", shown.length > 0 && "hidden")}
          >
            {CHAT_ACTIONS_DRAWER_EMPTY_COPY}
          </p>
        </div>
      </div>
      {footer ? (
        <div data-testid="chat-actions-drawer-footer" className="shrink-0 border-t border-fg/[0.06] empty:hidden">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
