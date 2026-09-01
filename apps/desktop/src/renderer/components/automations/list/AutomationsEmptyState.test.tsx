/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../../test/builtinSurfaces";
import { FLAGSHIP_TEMPLATES } from "../templates/templateData";
import { AutomationsEmptyState } from "./AutomationsEmptyState";

/**
 * The first three flagship playbooks, on a machine where one of them is gone.
 *
 * "Linear issue → lane + agent" is flagship two of four, so withholding it must
 * pull the fourth forward rather than leave a short stack. That is the whole
 * reason the filter runs before the slice, and it is what the count case below
 * pins.
 */

const LINEAR_FLAGSHIP = "Linear issue → lane + agent";

beforeEach(() => {
  resetBuiltinSurfacePlugins();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBuiltinSurfacePlugins();
});

describe("AutomationsEmptyState", () => {
  it("features the Linear flagship on a machine without the plugin", () => {
    seedBuiltinSurfacePlugins([]);
    render(<AutomationsEmptyState onUseTemplate={vi.fn()} onBrowseTemplates={vi.fn()} />);
    expect(screen.getByText(LINEAR_FLAGSHIP)).toBeTruthy();
  });

  it("keeps featuring it while the plugin registry has not resolved", () => {
    render(<AutomationsEmptyState onUseTemplate={vi.fn()} onBrowseTemplates={vi.fn()} />);
    expect(screen.getByText(LINEAR_FLAGSHIP)).toBeTruthy();
  });

  it("withholds it once ade-linear is installed and enabled", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    render(<AutomationsEmptyState onUseTemplate={vi.fn()} onBrowseTemplates={vi.fn()} />);
    expect(screen.queryByText(LINEAR_FLAGSHIP)).toBeNull();
  });

  it("still shows three cards, filled from the flagships behind it", () => {
    const expected = FLAGSHIP_TEMPLATES.filter((template) => template.builtin !== "linear").slice(0, 3);
    expect(expected).toHaveLength(3);
    seedBuiltinSurfacePlugins(["linear"]);
    render(<AutomationsEmptyState onUseTemplate={vi.fn()} onBrowseTemplates={vi.fn()} />);
    for (const template of expected) expect(screen.getByText(template.name)).toBeTruthy();
  });
});
