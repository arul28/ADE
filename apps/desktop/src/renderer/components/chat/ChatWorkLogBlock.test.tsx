/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatToolActivityDetails, webResultCount } from "./ChatWorkLogBlock";
import type { ChatWorkLogEntry } from "./chatTranscriptRows";

const base = { id: "e", createdAt: "2026-09-23T00:00:00.000Z", label: "Web search", tone: "info", status: "completed" } as const;

describe("web result count on the collapsed row", () => {
  afterEach(cleanup);

  it("prefers the provider total, then results, then URL actions", () => {
    const search: ChatWorkLogEntry = { ...base, entryKind: "web_search", query: "q", results: [{ url: "https://a.dev" }], resultsTotal: 12 };
    expect(webResultCount(search)).toBe(12);
    expect(webResultCount({ ...search, resultsTotal: undefined })).toBe(1);
    expect(webResultCount({
      ...base,
      entryKind: "web_search",
      query: "q",
      actions: [{ type: "open_page", url: "https://a.dev" }, { type: "search", query: "q" }],
    })).toBe(1);
    expect(webResultCount({ ...base, entryKind: "web_search", query: "q" })).toBeNull();
    expect(webResultCount({ ...base, entryKind: "command", command: "ls" })).toBeNull();
  });

  it("shows the count in the header without expanding the row", () => {
    render(
      <ChatToolActivityDetails
        entries={[{ ...base, entryKind: "web_search", query: "vite docs", results: [{ url: "https://vitejs.dev" }, { url: "https://b.dev" }] }]}
      />,
    );
    expect(screen.getByTestId("work-log-web-result-count").textContent).toBe("2 results");
    expect(screen.queryByText("vitejs.dev")).toBeNull();
  });
});
