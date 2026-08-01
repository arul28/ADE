/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ProjectConfigSnapshot } from "../../../shared/types";
import { defaultEffectiveGitConfig } from "../../../shared/types/config";
import { LaneBehaviorSection } from "./LaneBehaviorSection";

/**
 * These settings save on change — there is no Save button. The invariant under
 * test is unchanged from when there was one: ADE must not write a local
 * `newLaneBaseSource` override unless the user actually diverges from the
 * value the project config resolves to, because a spurious local override
 * silently pins the lane base and stops tracking the shared config.
 */

function makeSnapshot(overrides: Partial<ProjectConfigSnapshot> = {}): ProjectConfigSnapshot {
  return {
    shared: {},
    local: {},
    effective: {
      version: 1,
      testSuites: [],
      laneOverlayPolicies: [],
      automations: [],
      git: defaultEffectiveGitConfig(),
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

/** A snapshot whose effective base source is "local". */
function localBaseEffective() {
  return {
    version: 1,
    testSuites: [],
    laneOverlayPolicies: [],
    automations: [],
    git: defaultEffectiveGitConfig({ newLaneBaseSource: "local" }),
  };
}

/**
 * A stateful config mock: `save` is reflected by the next `get`, and the
 * effective base source is recomputed local-over-shared the way
 * `projectConfigService` merges it. Instant-save controls re-read after every
 * write, so a mock that always replays the original snapshot would make each
 * control appear to snap back and swallow the next interaction.
 */
function renderLaneBehaviorSection(snapshot: ProjectConfigSnapshot) {
  let current = snapshot;
  const projectConfig = {
    get: vi.fn(async () => current),
    save: vi.fn(async (next: { shared: any; local: any }) => {
      const effectiveBase = next.local?.git?.newLaneBaseSource
        ?? next.shared?.git?.newLaneBaseSource
        ?? current.effective.git?.newLaneBaseSource;
      current = {
        ...current,
        shared: next.shared,
        local: next.local,
        effective: {
          ...current.effective,
          git: {
            ...current.effective.git,
            autoRebaseOnHeadChange: next.local?.git?.autoRebaseOnHeadChange
              ?? current.effective.git?.autoRebaseOnHeadChange,
            newLaneBaseSource: effectiveBase,
          },
        },
      } as ProjectConfigSnapshot;
      return current;
    }),
  };
  (window as any).ade = { projectConfig };

  render(
    <MemoryRouter>
      <LaneBehaviorSection />
    </MemoryRouter>,
  );

  return projectConfig;
}

const autoRebaseSwitch = () => screen.getByRole("switch", { name: "Auto-rebase child lanes" });
const baseSourceOption = (name: RegExp) => screen.getByRole("radio", { name });

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

describe("LaneBehaviorSection", () => {
  it("does not create a local base-source override when an unrelated setting changes", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      shared: { git: { newLaneBaseSource: "local" } },
      local: { git: { autoRebaseOnHeadChange: false } },
      effective: localBaseEffective(),
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(autoRebaseSwitch());

    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));
    expect(projectConfig.save.mock.calls[0]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: true,
    });
  });

  it("preserves an existing local base-source override when an unrelated setting changes", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      local: { git: { autoRebaseOnHeadChange: false, newLaneBaseSource: "local" } },
      effective: localBaseEffective(),
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(autoRebaseSwitch());

    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));
    expect(projectConfig.save.mock.calls[0]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: true,
      newLaneBaseSource: "local",
    });
  });

  it("writes a local base-source override as soon as the control changes", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      shared: { git: { newLaneBaseSource: "local" } },
      local: { git: { autoRebaseOnHeadChange: false } },
      effective: localBaseEffective(),
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(baseSourceOption(/Remote/));

    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));
    expect(projectConfig.save.mock.calls[0]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: false,
      newLaneBaseSource: "remote",
    });
  });

  it("drops the override again when the control returns to the inherited value", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      shared: { git: { newLaneBaseSource: "local" } },
      local: { git: { autoRebaseOnHeadChange: false } },
      effective: localBaseEffective(),
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(baseSourceOption(/Remote/));
    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));

    fireEvent.click(baseSourceOption(/Local/));
    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(2));

    // Back at the inherited value, so no local override should remain.
    expect(projectConfig.save.mock.calls[1]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: false,
    });
  });

  it("pins rebase-noise settings only once they diverge from the shared config", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      local: { git: { autoRebaseOnHeadChange: false } },
    }));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));

    // Toggling an unrelated setting must not pin the noise settings at their
    // default values — a stale local pin would shadow a later shared change.
    fireEvent.click(autoRebaseSwitch());
    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(1));
    expect(projectConfig.save.mock.calls[0]?.[0].local.git).toEqual({
      autoRebaseOnHeadChange: true,
    });

    fireEvent.click(screen.getByRole("radio", { name: /Off/ }));
    await waitFor(() => expect(projectConfig.save).toHaveBeenCalledTimes(2));
    expect(projectConfig.save.mock.calls[1]?.[0].local.git.rebaseSuggestions).toBe("off");
  });

  it("reports a failed write instead of leaving the optimistic value showing", async () => {
    const projectConfig = renderLaneBehaviorSection(makeSnapshot({
      local: { git: { autoRebaseOnHeadChange: false } },
    }));
    projectConfig.save.mockRejectedValueOnce(new Error("disk is full"));

    await waitFor(() => expect(projectConfig.get).toHaveBeenCalledTimes(1));
    fireEvent.click(autoRebaseSwitch());

    expect(await screen.findByText("disk is full")).toBeTruthy();
    // The control re-reads stored state rather than keeping the failed value.
    await waitFor(() => expect(autoRebaseSwitch().getAttribute("aria-checked")).toBe("false"));
  });
});
