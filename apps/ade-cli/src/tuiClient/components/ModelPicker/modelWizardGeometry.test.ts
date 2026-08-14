import { describe, expect, it } from "vitest";
import {
  WIZARD_LIST_ROWS,
  modelWizardGeometry,
  wizardHeaderLines,
  wizardRowWindow,
} from "./modelWizardGeometry";
import type { ModelWizardView } from "../../modelWizard";

function view(overrides: Partial<ModelWizardView> = {}): ModelWizardView {
  return {
    step: "provider",
    title: "Choose a provider",
    breadcrumb: [],
    options: Array.from({ length: 4 }, (_, index) => ({
      id: `provider:${index}`,
      kind: "provider" as const,
      label: `Provider ${index}`,
    })),
    index: 0,
    hint: "↵ select · esc close",
    ...overrides,
  };
}

describe("modelWizardGeometry", () => {
  it("reserves a header line for the breadcrumb only when there is one", () => {
    expect(wizardHeaderLines(view())).toBe(2);
    expect(wizardHeaderLines(view({ breadcrumb: ["Cursor"] }))).toBe(3);
  });

  it("gives every visible option a 1-line rect below the header", () => {
    const geometry = modelWizardGeometry({ paneLeft: 10, paneTop: 5, paneWidth: 40, view: view() });
    expect(geometry.options).toHaveLength(4);
    expect(geometry.options[0]?.rect).toEqual({ x: 10, y: 7, w: 40, h: 1 });
    expect(geometry.options[3]?.rect).toEqual({ x: 10, y: 10, w: 40, h: 1 });
    expect(geometry.options[2]?.optionId).toBe("provider:2");
  });

  it("windows a long list and keeps rect indexes aligned with the window", () => {
    const options = Array.from({ length: WIZARD_LIST_ROWS + 8 }, (_, index) => ({
      id: `model:${index}`,
      kind: "model" as const,
      label: `Model ${index}`,
    }));
    const long = view({ step: "model", options, index: options.length - 1 });
    const window = wizardRowWindow(long);
    expect(window.end).toBe(options.length);
    const geometry = modelWizardGeometry({ paneLeft: 1, paneTop: 1, paneWidth: 30, view: long });
    expect(geometry.options).toHaveLength(WIZARD_LIST_ROWS);
    // The FIRST painted row is the window start, not option 0 — this is the
    // invariant that keeps a click on a scrolled list from selecting the wrong
    // model.
    expect(geometry.options[0]?.index).toBe(window.start);
    expect(geometry.options[0]?.rect.y).toBe(1 + wizardHeaderLines(long));
    expect(geometry.options.at(-1)?.index).toBe(options.length - 1);
  });
});
