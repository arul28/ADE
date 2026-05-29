import { describe, expect, it } from "vitest";

import {
  ensureAdeDeeplinkFooter,
  hasAdeDeeplinkFooter,
  renderAdeDeeplinkFooter,
} from "./adeDeeplinkFooter";

describe("renderAdeDeeplinkFooter", () => {
  it("renders both branch and pr links when prNumber is provided", () => {
    const block = renderAdeDeeplinkFooter({
      repoOwner: "anthropics",
      repoName: "claude-code",
      branch: "feat-x",
      prNumber: 1234,
    });
    expect(block).toContain("<!-- ade:link v=1 type=pr repo=anthropics/claude-code");
    expect(block).toContain("branch=feat-x");
    expect(block).toContain("num=1234");
    expect(block).toContain("Open in ADE");
    expect(block).toMatch(/ade-app\.dev\/open\?type=branch/);
    expect(block).toMatch(/ade-app\.dev\/open\?type=pr/);
    expect(block).toContain("https://ade-app.dev/images/ade-mark.svg");
    expect(block).toContain("<!-- /ade:link -->");
  });

  it("omits the pr link when prNumber is missing", () => {
    const block = renderAdeDeeplinkFooter({
      repoOwner: "a",
      repoName: "b",
      branch: "feat",
    });
    expect(block).toMatch(/ade-app\.dev\/open\?type=branch/);
    expect(block).not.toMatch(/type=pr/);
    expect(block).toContain("<!-- ade:link v=1 type=branch");
  });

  it("escapes branch names with HTML-special characters", () => {
    const block = renderAdeDeeplinkFooter({
      repoOwner: "a",
      repoName: "b",
      branch: "feat<&>",
    });
    expect(block).toContain("feat&lt;&amp;&gt; branch");
  });
});

describe("ensureAdeDeeplinkFooter", () => {
  it("appends the footer to an existing body", () => {
    const body = "Closes #5\n\nThis PR ships deeplinks.";
    const next = ensureAdeDeeplinkFooter(body, {
      repoOwner: "a",
      repoName: "b",
      branch: "feat",
      prNumber: 7,
    });
    expect(next.startsWith(body)).toBe(true);
    expect(next).toContain("Open in ADE");
  });

  it("appends a fresh block to an empty body", () => {
    const next = ensureAdeDeeplinkFooter("", {
      repoOwner: "a",
      repoName: "b",
      branch: "feat",
    });
    expect(next).toContain("Open in ADE");
  });

  it("replaces the existing block in place — idempotent across runs", () => {
    const initial = ensureAdeDeeplinkFooter("hello\n", {
      repoOwner: "a",
      repoName: "b",
      branch: "feat",
    });
    const updated = ensureAdeDeeplinkFooter(initial, {
      repoOwner: "a",
      repoName: "b",
      branch: "feat",
      prNumber: 99,
    });
    // Only one marker should remain.
    const openCount = (updated.match(/<!-- ade:link v=1/gi) ?? []).length;
    expect(openCount).toBe(1);
    expect(updated).toContain("num=99");
    expect(updated).toContain("PR #99");
    expect(updated.startsWith("hello")).toBe(true);
  });
});

describe("hasAdeDeeplinkFooter", () => {
  it("detects a present marker", () => {
    expect(
      hasAdeDeeplinkFooter("body\n\n<!-- ade:link v=1 type=branch repo=a/b branch=f -->"),
    ).toBe(true);
  });
  it("returns false for missing markers", () => {
    expect(hasAdeDeeplinkFooter("body")).toBe(false);
    expect(hasAdeDeeplinkFooter(null)).toBe(false);
    expect(hasAdeDeeplinkFooter(undefined)).toBe(false);
  });
});
