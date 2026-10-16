/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AutomationsWorkspace, readCursorCloudConnectionForAutomation } from "./AutomationsWorkspace";

describe("automation Cursor Cloud connection probe", () => {
  it("does not fail the automation refresh when AI status is unavailable", async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error("AI bridge unavailable"));

    await expect(readCursorCloudConnectionForAutomation(getStatus)).resolves.toBe(false);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});

describe("New automation", () => {
  /**
   * Automation events fire often (runs, saves, ingress), and each one refreshes
   * the rule list. A new draft is also "no rule selected", which is the state a
   * first load fills with the first rule — so the refresh used to replace the
   * blank draft with that rule a moment after New automation was pressed.
   */
  it("keeps a new draft open across a background refresh", async () => {
    const listeners: Array<() => void> = [];
    const rule = {
      id: "rule-a",
      name: "Rule A",
      enabled: true,
      mode: "review",
      triggers: [{ type: "manual" }],
      trigger: { type: "manual" },
      actions: [],
      origin: "user",
      executor: { mode: "automation-bot" },
      reviewProfile: "quick",
      toolPalette: [],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only" },
      verification: { verifyBeforePublish: false },
      billingCode: "",
      execution: { kind: "built-in" },
      lastRunAt: null,
      nextRunAt: null,
      lastRunStatus: null,
      running: false,
      confidence: null,
      source: "local",
    };
    const ade = new Proxy({
      automations: new Proxy({
        list: vi.fn(async () => [rule]),
        onEvent: (listener: () => void) => {
          listeners.push(listener);
          return () => {};
        },
        getIngressStatus: vi.fn(async () => null),
      }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : vi.fn(async () => null)) }),
      tests: { listSuites: vi.fn(async () => []) },
      lanes: new Proxy({ list: vi.fn(async () => []) }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : vi.fn(async () => [])) }),
      projectConfig: { get: vi.fn(async () => ({})) },
      ai: { getStatus: vi.fn(async () => ({})) },
    }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : new Proxy({}, { get: () => vi.fn(async () => null) })) });
    Object.defineProperty(window, "ade", { configurable: true, writable: true, value: ade });

    try {
      render(
        <MemoryRouter>
          <AutomationsWorkspace pendingDraft={null} onDraftConsumed={() => {}} onOpenTemplates={() => {}} />
        </MemoryRouter>,
      );
      const name = () => screen.getByPlaceholderText("e.g. Triage new GitHub issues") as HTMLInputElement;
      await waitFor(() => expect(name().value).toBe("Rule A"));

      fireEvent.click(screen.getByRole("button", { name: "New automation" }));
      await waitFor(() => expect(name().value).toBe(""));

      await act(async () => {
        for (const listener of listeners) listener();
      });
      await act(async () => {});
      expect(name().value).toBe("");
      expect(screen.getAllByText("New automation").length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
