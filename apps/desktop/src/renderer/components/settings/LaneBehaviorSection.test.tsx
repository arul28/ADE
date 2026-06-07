/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ProjectConfigSnapshot } from "../../../shared/types";
import { LaneBehaviorSection } from "./LaneBehaviorSection";

function makeSnapshot(overrides: Partial<ProjectConfigSnapshot> = {}): ProjectConfigSnapshot {
  return {
    shared: {},
    local: {},
    effective: {
      version: 1,
      processes: [],
      stackButtons: [],
      processGroups: [],
      testSuites: [],
      laneOverlayPolicies: [],
      automations: [],
      git: {
        autoRebaseOnHeadChange: false,
        newLaneBaseSource: "remote",
      },
    },
    validation: { ok: true, issues: [] },
    trust: {
      sharedHash: "shared",
      localHash: "local",
      approvedSharedHash: "shared",
      requiresSharedTrust: false,
    },
    paths: {
      sharedPath: "/tmp/project/.ade/project.json",
      localPath: "/tmp/project/.ade/project.local.json",
    },
    ...overrides,
  };
}

function renderLaneBehaviorSection(snapshot: ProjectConfigSnapshot) {
  const projectConfig = {
    get: vi.fn().mockResolvedValue(snapshot),
    save: vi.fn().mockResolvedValue(snapshot),
  };
  (window as any).ade = { projectConfig };

  render(
    <MemoryRouter>
      <LaneBehaviorSection />
    </MemoryRouter>,
  );

  return projectConfig;
}

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

describe("LaneBehaviorSection", () => {
  it("does not create a local base-source override when saving unrelated settings", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      shared: { git: { newLaneBaseSource: "local" } },
      local: { git: { autoRebaseOnHeadChange: false } },
      effective: {
        version: 1,
        processes: [],
        stackButtons: [],
        processGroups: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        git: {
          autoRebaseOnHeadChange: false,
          newLaneBaseSource: "local",
        },
      },
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));
    expect(projectConfig.save.mock.calls[0]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: false,
    });
  });

  it("preserves an existing local base-source override when saving", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      local: { git: { autoRebaseOnHeadChange: false, newLaneBaseSource: "local" } },
      effective: {
        version: 1,
        processes: [],
        stackButtons: [],
        processGroups: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        git: {
          autoRebaseOnHeadChange: false,
          newLaneBaseSource: "local",
        },
      },
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));
    expect(projectConfig.save.mock.calls[0]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: false,
      newLaneBaseSource: "local",
    });
  });

  it("writes a local base-source override when the control changes", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      shared: { git: { newLaneBaseSource: "local" } },
      local: { git: { autoRebaseOnHeadChange: false } },
      effective: {
        version: 1,
        processes: [],
        stackButtons: [],
        processGroups: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        git: {
          autoRebaseOnHeadChange: false,
          newLaneBaseSource: "local",
        },
      },
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Remote/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));
    expect(projectConfig.save.mock.calls[0]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: false,
      newLaneBaseSource: "remote",
    });
  });
});
