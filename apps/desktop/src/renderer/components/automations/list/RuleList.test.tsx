/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationAction, AutomationRuleSummary } from "../../../../shared/types";
import { RuleList, ruleHasHandoffAction, ruleOriginFilterCounts } from "./RuleList";
import { ctoBadgeTooltip, oneShotNote } from "./RuleRow";

function rule(partial: Partial<AutomationRuleSummary> & { id: string }): AutomationRuleSummary {
  return {
    name: partial.id,
    mode: "review",
    origin: "user",
    triggers: [{ type: "manual" }],
    trigger: { type: "manual" },
    executor: { mode: "automation-bot" },
    reviewProfile: "quick",
    toolPalette: [],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only" },
    verification: { verifyBeforePublish: false },
    billingCode: "auto:test",
    actions: [],
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    lastRunStatus: null,
    running: false,
    confidence: null,
    source: "local",
    ...partial,
  } as AutomationRuleSummary;
}

function builtIn(actions: AutomationAction[]): Pick<AutomationRuleSummary, "execution"> {
  return { execution: { kind: "built-in", builtIn: { actions } } };
}

function renderList(rules: AutomationRuleSummary[]) {
  return render(
    <RuleList
      rules={rules}
      selectedRuleId={null}
      search=""
      loading={false}
      error={null}
      configTrustRequired={false}
      ingressStatus={null}
      delivery={null}
      onSearch={vi.fn()}
      onSelect={vi.fn()}
      onToggle={vi.fn()}
      onRunNow={vi.fn()}
      onOpenHistory={vi.fn()}
      onDelete={vi.fn()}
      onNew={vi.fn()}
      onOpenTemplates={vi.fn()}
      onUseTemplate={vi.fn()}
      onRefresh={vi.fn()}
      onConfirmTrust={vi.fn()}
    />,
  );
}

/** The row element for a rule, found by its visible name. */
function rowFor(name: string): HTMLElement {
  const label = screen.getByText(name);
  const row = label.closest("[role=button]");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}

afterEach(() => {
  cleanup();
});

describe("RuleRow provenance", () => {
  it("badges a CTO rule and leaves a user rule unbadged", () => {
    renderList([
      rule({ id: "cto-rule", name: "Watch the queue", origin: "cto" }),
      rule({ id: "user-rule", name: "Nightly tests", origin: "user" }),
    ]);

    const ctoBadge = within(rowFor("Watch the queue")).getByTestId("rule-origin-cto");
    expect(ctoBadge.textContent).toContain("CTO");
    expect(ctoBadge.getAttribute("aria-label")).toBe("Written by the CTO");
    expect(within(rowFor("Nightly tests")).queryByTestId("rule-origin-cto")).toBeNull();
  });

  it("renders a rule with no origin (older config) exactly as a user rule", () => {
    const legacy = rule({ id: "legacy", name: "Legacy rule" });
    delete (legacy as { origin?: unknown }).origin;
    renderList([legacy]);

    expect(screen.queryByTestId("rule-origin-cto")).toBeNull();
    expect(screen.queryByTestId("rule-scope-label")).toBeNull();
    expect(screen.queryByTestId("rule-one-shot-note")).toBeNull();
  });

  it("shows the originRequest sentence when the CTO badge is hovered", async () => {
    vi.useFakeTimers();
    try {
      renderList([
        rule({
          id: "cto-rule",
          name: "Watch the queue",
          origin: "cto",
          originRequest: "Retry my chat when it hits the usage limit",
        }),
      ]);

      const badge = screen.getByTestId("rule-origin-cto");
      const wrapper = badge.parentElement as HTMLElement;
      fireEvent.mouseEnter(wrapper);
      act(() => {
        vi.advanceTimersByTime(400);
      });

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.textContent).toContain("Written by the CTO");
      expect(tooltip.textContent).toContain("Retry my chat when it hits the usage limit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a readable sentence when the rule has no originRequest", () => {
    expect(ctoBadgeTooltip({ originRequest: "Do the thing" }).description).toBe(
      'From your request: "Do the thing"',
    );
    const fallback = ctoBadgeTooltip({}).description;
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toContain("CTO");
    expect(ctoBadgeTooltip({ originRequest: "   " }).description).toBe(fallback);
  });

  it("reads the scope label from the rule's stored sessionTitle", () => {
    renderList([
      rule({
        id: "scoped",
        name: "Scoped rule",
        scope: { sessionId: "chat-gone", sessionTitle: "Fix the sync cursor" },
      }),
    ]);

    const label = screen.getByTestId("rule-scope-label");
    expect(label.textContent).toBe("Handoff: Fix the sync cursor");
    expect(label.getAttribute("title")).toBe("Fix the sync cursor");
  });

  it("keeps the scope label truncated with the full title in the title attribute", () => {
    const long = "A very long chat title that will never fit inside the three-hundred-and-forty pixel list";
    renderList([
      rule({ id: "scoped", name: "Scoped rule", scope: { sessionId: "chat-1", sessionTitle: long } }),
    ]);

    const label = screen.getByTestId("rule-scope-label");
    expect(label.className).toContain("truncate");
    expect(label.getAttribute("title")).toBe(long);
  });

  it("labels a scoped rule whose chat title was never recorded", () => {
    renderList([
      rule({ id: "scoped", name: "Scoped rule", scope: { sessionId: "chat-1", sessionTitle: "" } }),
    ]);

    expect(screen.getByTestId("rule-scope-label").textContent).toBe("Handoff: Untitled chat");
  });

  it("warns on the row that a one-shot rule deletes itself", () => {
    renderList([
      rule({ id: "once", name: "One and done", oneShot: true }),
      rule({ id: "capped", name: "Capped", oneShot: true, maxRuns: 3 }),
      rule({ id: "normal", name: "Repeating" }),
    ]);

    expect(within(rowFor("One and done")).getByTestId("rule-one-shot-note").textContent).toBe(
      "Deletes itself after one run",
    );
    expect(within(rowFor("Capped")).getByTestId("rule-one-shot-note").textContent).toBe(
      "Deletes itself after 3 runs",
    );
    expect(within(rowFor("Repeating")).queryByTestId("rule-one-shot-note")).toBeNull();
  });

  it("keeps the one-shot note out of rules that only cap their runs", () => {
    expect(oneShotNote({ maxRuns: 5 })).toBeNull();
    expect(oneShotNote({ oneShot: true, maxRuns: 1 })).toBe("Deletes itself after one run");
  });
});

describe("handoff detection", () => {
  it("keys on the action list, not the rule name", () => {
    const namedNotHandoff = rule({
      id: "named",
      name: "Handoff when limits hit",
      ...builtIn([{ type: "run-tests", suiteId: "unit" }]),
    });
    const unnamedHandoff = rule({
      id: "unnamed",
      name: "Keep going",
      ...builtIn([{ type: "handoff", targetModelId: "anthropic/claude-opus-5" }]),
    });

    expect(ruleHasHandoffAction(namedNotHandoff)).toBe(false);
    expect(ruleHasHandoffAction(unnamedHandoff)).toBe(true);
  });

  it("finds handoff actions on the legacy action lists too", () => {
    expect(ruleHasHandoffAction(rule({ id: "legacy-actions", actions: [{ type: "handoff" }] }))).toBe(true);
    expect(
      ruleHasHandoffAction(rule({ id: "legacy-block", legacy: { actions: [{ type: "handoff" }] } })),
    ).toBe(true);
  });
});

describe("RuleList filter chips", () => {
  const ctoRule = rule({ id: "a", name: "CTO rule", origin: "cto" });
  const ctoHandoff = rule({
    id: "b",
    name: "CTO handoff",
    origin: "cto",
    ...builtIn([{ type: "handoff", targetModelId: "anthropic/claude-opus-5" }]),
  });
  const chatHandoff = rule({
    id: "c",
    name: "Chat handoff",
    origin: "chat-menu",
    ...builtIn([{ type: "handoff", targetModelId: "anthropic/claude-opus-5" }]),
  });
  const plainRule = rule({ id: "d", name: "Plain rule" });
  const all = [ctoRule, ctoHandoff, chatHandoff, plainRule];

  function visibleRuleNames(): string[] {
    return all.map((r) => r.name).filter((name) => screen.queryByText(name) !== null);
  }

  it("counts each axis over every rule in the list", () => {
    expect(ruleOriginFilterCounts(all)).toEqual({ all: 4, cto: 2, handoff: 2 });
  });

  it("defaults to All and shows every rule", () => {
    renderList(all);
    expect(screen.getByTestId("automations-filter-all").getAttribute("aria-pressed")).toBe("true");
    expect(visibleRuleNames()).toEqual(["CTO rule", "CTO handoff", "Chat handoff", "Plain rule"]);
  });

  it("labels every chip with its live count", () => {
    renderList(all);
    expect(screen.getByTestId("automations-filter-all").getAttribute("aria-label")).toBe("All, 4");
    expect(screen.getByTestId("automations-filter-cto").getAttribute("aria-label")).toBe("By CTO, 2");
    expect(screen.getByTestId("automations-filter-handoff").getAttribute("aria-label")).toBe("Handoffs, 2");
  });

  it("By CTO selects only origin cto", () => {
    renderList(all);
    fireEvent.click(screen.getByTestId("automations-filter-cto"));
    expect(visibleRuleNames()).toEqual(["CTO rule", "CTO handoff"]);
  });

  it("Handoffs selects every rule with a handoff action, whatever its origin", () => {
    renderList(all);
    fireEvent.click(screen.getByTestId("automations-filter-handoff"));
    expect(visibleRuleNames()).toEqual(["CTO handoff", "Chat handoff"]);
  });

  it("goes inert on a chip that matches nothing", () => {
    renderList([plainRule]);
    const cto = screen.getByTestId("automations-filter-cto") as HTMLButtonElement;
    expect(cto.disabled).toBe(true);
    expect(cto.getAttribute("aria-label")).toBe("By CTO, 0");
    fireEvent.click(cto);
    expect(screen.getByText("Plain rule")).toBeTruthy();
  });

  it("names the active filter when it hides everything, and offers the way back", () => {
    // The search box narrows the list the parent hands down, so an active chip
    // can empty out after the fact — the empty state has to explain that.
    const { rerender } = renderList(all);
    fireEvent.click(screen.getByTestId("automations-filter-cto"));
    expect(screen.queryByTestId("automations-filter-empty")).toBeNull();

    rerender(
      <RuleList
        rules={[plainRule]}
        selectedRuleId={null}
        search="plain"
        loading={false}
        error={null}
        configTrustRequired={false}
        ingressStatus={null}
        delivery={null}
        onSearch={vi.fn()}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
        onOpenHistory={vi.fn()}
        onDelete={vi.fn()}
        onNew={vi.fn()}
        onOpenTemplates={vi.fn()}
        onUseTemplate={vi.fn()}
        onRefresh={vi.fn()}
        onConfirmTrust={vi.fn()}
      />,
    );

    const empty = screen.getByTestId("automations-filter-empty");
    expect(empty.textContent).toContain("By CTO");
    fireEvent.click(within(empty).getByText("Show all"));
    expect(screen.queryByTestId("automations-filter-empty")).toBeNull();
    expect(screen.getByText("Plain rule")).toBeTruthy();
  });

  it("keeps the no-rules-at-all empty state when there is nothing to filter", () => {
    renderList([]);
    expect(screen.getByText("No automations yet")).toBeTruthy();
    expect(screen.queryByTestId("automations-filter-empty")).toBeNull();
  });
});
