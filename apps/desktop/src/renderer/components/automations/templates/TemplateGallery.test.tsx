/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../../test/builtinSurfaces";
import { TemplateGallery } from "./TemplateGallery";

/**
 * The two template playbooks built on ADE's compiled Linear trigger.
 *
 * A template is an offer to create a NEW rule. Once `ade-linear` owns Linear,
 * the trigger source picker no longer offers Linear, so using one of these
 * would drop the user into a builder whose picker has no row for the source the
 * rule was seeded with. The templates leave with the surface.
 *
 * `Linear label triage` shares the "Issue intake" group with the GitHub
 * playbooks, so the group itself survives — the group-level filter matters for
 * a future group whose every template is gated, and is asserted through the
 * heading below.
 */

const LINEAR_TEMPLATES = ["Linear issue → lane + agent", "Linear label triage"];
const GITHUB_TEMPLATE = "GitHub issue → lane + agent";

beforeEach(() => {
  resetBuiltinSurfacePlugins();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBuiltinSurfacePlugins();
});

describe("TemplateGallery", () => {
  it("offers the Linear templates on a machine without the plugin", () => {
    seedBuiltinSurfacePlugins([]);
    render(<TemplateGallery onUseTemplate={vi.fn()} />);
    for (const name of LINEAR_TEMPLATES) expect(screen.getByText(name)).toBeTruthy();
  });

  it("keeps offering them while the plugin registry has not resolved", () => {
    render(<TemplateGallery onUseTemplate={vi.fn()} />);
    for (const name of LINEAR_TEMPLATES) expect(screen.getByText(name)).toBeTruthy();
  });

  it("withholds them once ade-linear is installed and enabled", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    render(<TemplateGallery onUseTemplate={vi.fn()} />);
    for (const name of LINEAR_TEMPLATES) expect(screen.queryByText(name)).toBeNull();
  });

  it("keeps the rest of the gallery, including the group they shared", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    render(<TemplateGallery onUseTemplate={vi.fn()} />);
    expect(screen.getByText(GITHUB_TEMPLATE)).toBeTruthy();
    expect(screen.getByText("Issue intake")).toBeTruthy();
  });
});
