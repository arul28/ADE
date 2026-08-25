import type { ModelWizardView } from "../../modelWizard";
import { rowWindow, type HitRect } from "./modelPickerGeometry";

/**
 * Single source of truth for the /model wizard's on-screen geometry, shared by
 * ModelWizardPane's render and app.tsx's click hit-test — the same discipline
 * modelPickerGeometry enforces for the legacy picker. Change the layout here
 * and both follow; hand-roll offsets in either place and clicks drift.
 */

/** Visible option rows before the list windows/scrolls. */
export const WIZARD_LIST_ROWS = 12;

/** Every option paints exactly one line. */
export const WIZARD_ROW_HEIGHT = 1;

/**
 * Lines above the first option row:
 *   title (1) + breadcrumb (0 or 1) + blank separator (1)
 */
export function wizardHeaderLines(view: ModelWizardView): number {
  return 1 + (view.breadcrumb.length ? 1 : 0) + 1;
}

export function wizardRowWindow(view: ModelWizardView): { start: number; end: number } {
  return rowWindow(view.options.length, view.index, WIZARD_LIST_ROWS);
}

export type ModelWizardGeometry = {
  window: { start: number; end: number };
  /** One rect per visible option, keyed by the option's stable id. */
  options: Array<{ id: string; index: number; optionId: string; rect: HitRect }>;
};

export function modelWizardGeometry(input: {
  /** 1-based screen column of the pane body left edge. */
  paneLeft: number;
  /** 1-based screen row of the pane body first line. */
  paneTop: number;
  /** Pane body width in columns. */
  paneWidth: number;
  view: ModelWizardView;
}): ModelWizardGeometry {
  const { paneLeft, paneTop, paneWidth, view } = input;
  const listTop = paneTop + wizardHeaderLines(view);
  const window = wizardRowWindow(view);
  const options: ModelWizardGeometry["options"] = [];
  view.options.slice(window.start, window.end).forEach((option, sliceIndex) => {
    const index = window.start + sliceIndex;
    options.push({
      id: `right:model-wizard:option:${option.id}`,
      index,
      optionId: option.id,
      rect: {
        x: paneLeft,
        y: listTop + (sliceIndex * WIZARD_ROW_HEIGHT),
        w: Math.max(8, paneWidth),
        h: WIZARD_ROW_HEIGHT,
      },
    });
  });
  return { window, options };
}
