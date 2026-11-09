import React, { useContext } from "react";
import { COLORS } from "../../lanes/laneDesignTokens";

type HastNode = { type: string; tagName?: string; position?: unknown; properties?: Record<string, unknown>; children?: HastNode[] };
type HastRoot = HastNode & { children: HastNode[] };

export const PrTaskScopeContext = React.createContext<{ toggle: (index: number, nextChecked: boolean) => void } | null>(null);

export function PrTaskCheckbox({ checked, taskIndex }: { checked?: boolean; taskIndex?: number }) {
  const scope = useContext(PrTaskScopeContext);
  const interactive = scope != null && taskIndex !== undefined;
  return (
    <input
      type="checkbox"
      checked={!!checked}
      readOnly={!interactive}
      disabled={!interactive}
      aria-readonly={!interactive}
      onChange={interactive ? (event) => scope.toggle(taskIndex, event.target.checked) : undefined}
      className="pr-md-task-checkbox relative mr-1.5 inline-block h-[12px] w-[12px] shrink-0 appearance-none rounded-[3px] border align-middle"
      style={{
        borderColor: checked ? COLORS.accent : COLORS.outlineBorder,
        background: checked ? COLORS.accent : "transparent",
        cursor: interactive ? "pointer" : "default",
      }}
    />
  );
}

/**
 * Numbers the task-list boxes, after sanitizing so the attribute survives. A box
 * from a markdown task list has no source position; raw HTML inputs have one and
 * are never numbered, so the numbering matches `findPrTaskBoxes`.
 */
export function rehypeNumberTaskBoxes() {
  return (tree: HastRoot) => {
    let index = 0;
    const visit = (node: HastNode) => {
      for (const child of node.children ?? []) {
        if (child.type === "element" && child.tagName === "input" && child.properties?.type === "checkbox" && !child.position) {
          child.properties.dataTaskIndex = index;
          index += 1;
        } else if (child.type === "element") {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}
