import { Fragment, type ReactNode } from "react";

export type ChatActionsDrawerSection = {
  key: string;
  /**
   * One root element, or a component that renders `null` when it has nothing.
   * Sections carry no borders or heights of their own: the drawer draws the
   * dividers between siblings and owns the only scroll.
   */
  content: ReactNode;
};

export const CHAT_ACTIONS_DRAWER_EMPTY_COPY =
  "Nothing here yet. Agents, tasks, proof and sources show up as the chat runs.";

/**
 * One scroll for everything that used to be a chat-actions tab.
 *
 * The drawer has no predefined areas. Hosts pass only sections that have
 * something to show (falsy entries are dropped), in order: progress (goal,
 * tasks, subagents, background work), proof, sources, Droid missions. A section
 * that turns out empty at render renders `null`, which leaves no DOM, so the
 * sibling divider rule and the empty line both still see the truth. There is
 * no tab strip: the header icon is the only control.
 */
export function ChatActionsDrawerPanel({
  sections,
}: {
  sections: ReadonlyArray<ChatActionsDrawerSection | null | false | undefined>;
}) {
  const present = sections.filter((section): section is ChatActionsDrawerSection => Boolean(section));
  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div data-testid="chat-actions-drawer-scroll" className="min-h-0 flex-1 overflow-auto">
        <div
          data-testid="chat-actions-drawer-sections"
          className="flex flex-col [&>*+*]:border-t [&>*+*]:border-white/[0.06]"
        >
          {present.map((section) => (
            <Fragment key={section.key}>{section.content}</Fragment>
          ))}
          {/* Last so it never takes the divider slot of a real section. With no
           * sections it is plain; otherwise it shows only if every section
           * rendered null (`only:` = it is the sole child left). */}
          <p
            data-testid="chat-actions-drawer-empty"
            className={
              present.length === 0
                ? "px-4 py-4 font-sans text-[12px] leading-5 text-fg/40"
                : "hidden px-4 py-4 font-sans text-[12px] leading-5 text-fg/40 only:block"
            }
          >
            {CHAT_ACTIONS_DRAWER_EMPTY_COPY}
          </p>
        </div>
      </div>
    </div>
  );
}
