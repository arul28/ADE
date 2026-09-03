import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINEAR_BRAND,
  LINEAR_LOGO_PATH,
  LinearMark,
  LinearPriorityIcon,
  LinearProjectIcon,
  LinearStateIcon,
  branchExistsForLinearIssue,
  formatRelativeTime,
  issueProjectLabel,
  issueUpdatedLabel,
  linearPriorityLabel,
  resolveLinearProjectIcon,
} from "../src/index";

afterEach(cleanup);

describe("brand", () => {
  it("keeps the canonical logo path and palette", () => {
    expect(LINEAR_BRAND.primary).toBe("#5E6AD2");
    expect(LINEAR_LOGO_PATH.startsWith("M2.886 4.18")).toBe(true);
    const { container } = render(<LinearMark size={20} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe(LINEAR_LOGO_PATH);
  });
});

describe("state and priority icons", () => {
  it("draws every state type, and falls back for an unknown one", () => {
    for (const type of ["backlog", "unstarted", "started", "completed", "canceled", "triage", "???"]) {
      const { container, unmount } = render(<LinearStateIcon stateType={type} />);
      expect(container.querySelector("svg"), type).toBeTruthy();
      unmount();
    }
  });

  it("draws one bar for low, three for high, and a plate for urgent", () => {
    const low = render(<LinearPriorityIcon priority={4} />);
    expect(low.container.querySelectorAll("rect")).toHaveLength(3);
    low.unmount();
    const none = render(<LinearPriorityIcon priority={0} />);
    expect(none.container.querySelectorAll("rect")).toHaveLength(1);
    none.unmount();
    const urgent = render(<LinearPriorityIcon priority={1} />);
    expect(urgent.container.querySelectorAll("rect")).toHaveLength(3);
  });
});

describe("project icon", () => {
  it("resolves shortcodes, raw emoji and unknown names", () => {
    expect(resolveLinearProjectIcon(":rocket:")).toBe("🚀");
    expect(resolveLinearProjectIcon("robot")).toBe("🤖");
    expect(resolveLinearProjectIcon("🎯")).toBe("🎯");
    expect(resolveLinearProjectIcon("not_a_known_alias")).toBeNull();
    expect(resolveLinearProjectIcon(null)).toBeNull();
  });

  it("falls back to the project's initial when there is no glyph", () => {
    render(<LinearProjectIcon icon={null} color="#5E6AD2" name="platform" />);
    expect(screen.getByText("P").className).toContain("ade-linear-project-icon-initial");
  });

  it("tints the glyph background from the project colour", () => {
    const { container } = render(<LinearProjectIcon icon=":bug:" color="#5E6AD2" name="bugs" />);
    const span = container.querySelector(".ade-linear-project-icon") as HTMLElement;
    expect(span.textContent).toBe("🐛");
    expect(span.style.background).toBeTruthy();
  });
});

describe("issue labels", () => {
  it("capitalises the priority and names the empty case", () => {
    expect(linearPriorityLabel({ priorityLabel: "urgent" })).toBe("Urgent");
    expect(linearPriorityLabel({ priorityLabel: "none" })).toBe("No priority");
    expect(linearPriorityLabel({})).toBe("No priority");
  });

  it("prefers the project name, then the slug, then the team key", () => {
    expect(issueProjectLabel({ projectName: " Platform ", projectSlug: "p", teamKey: "ADE" })).toBe("Platform");
    expect(issueProjectLabel({ projectName: "  ", projectSlug: "p", teamKey: "ADE" })).toBe("p");
    expect(issueProjectLabel({ projectName: null, projectSlug: "", teamKey: "ADE" })).toBe("ADE");
  });

  it("formats relative time exactly as the desktop does", () => {
    // Pinned against apps/desktop/.../branchPickerSearch.ts. Changing one
    // without the other is the drift this test exists to catch.
    const now = Date.parse("2026-09-03T00:00:00.000Z");
    expect(formatRelativeTime("2026-09-02T23:59:30.000Z", now)).toBe("30s");
    expect(formatRelativeTime("2026-09-02T23:30:00.000Z", now)).toBe("30m");
    expect(formatRelativeTime("2026-09-02T01:00:00.000Z", now)).toBe("23h");
    expect(formatRelativeTime("2026-09-02T00:00:00.000Z", now)).toBe("1d");
    expect(formatRelativeTime("2026-08-25T00:00:00.000Z", now)).toBe("9d");
    expect(formatRelativeTime("2026-06-03T00:00:00.000Z", now)).toBe("3mo");
    expect(formatRelativeTime("2024-09-03T00:00:00.000Z", now)).toBe("2y");
    expect(formatRelativeTime("2026-09-03T00:01:00.000Z", now)).toBe("now");
    expect(formatRelativeTime(undefined)).toBe("");
    expect(formatRelativeTime("not-a-date")).toBe("");
  });

  it("names the updated label, with a fallback when the date is unusable", () => {
    expect(issueUpdatedLabel({ updatedAt: "not-a-date" })).toBe("Updated recently");
    expect(issueUpdatedLabel({ updatedAt: new Date(Date.now() - 5000).toISOString() })).toMatch(/^\d+s$/);
  });

  it("matches a branch with or without its remote prefix", () => {
    const branches = [{ name: "origin/ade-148-page-tier" }, { name: "main" }];
    expect(branchExistsForLinearIssue("ade-148-page-tier", branches)).toBe(true);
    expect(branchExistsForLinearIssue("MAIN", branches)).toBe(true);
    expect(branchExistsForLinearIssue("other", branches)).toBe(false);
    expect(branchExistsForLinearIssue("  ", branches)).toBe(false);
  });
});
