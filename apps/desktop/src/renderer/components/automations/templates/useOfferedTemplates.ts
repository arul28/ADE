import React from "react";

import { isBuiltinSurfaceVisible } from "../../plugins/builtinTabs";
import { useBuiltinGateInput } from "../../plugins/useBuiltinTabs";
import type { AutomationTemplate } from "./templateData";

/**
 * Which templates this machine may start a new rule from.
 *
 * `templateData` is a plain data module — no hooks, no store — so the question
 * "is the surface this template's trigger belongs to still ADE's to draw?" has
 * to be asked where React can answer it. Both galleries ask it here rather than
 * each writing the predicate, because a template offered in one place and
 * withheld in the other is worse than either answer on its own.
 *
 * Shaped as a filter callback, like `useVisibleBuiltinRoutes`, because the two
 * call sites hold different lists: one flat, one grouped.
 */
export function useOfferedTemplateFilter(): (template: AutomationTemplate) => boolean {
  const input = useBuiltinGateInput();
  return React.useCallback(
    (template: AutomationTemplate) =>
      !template.builtin || isBuiltinSurfaceVisible(template.builtin, input),
    [input],
  );
}
