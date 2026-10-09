/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatToolActivityDetails, ChatWorkLogBlock, webResultCount } from "./ChatWorkLogBlock";
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


describe("localhost terminal drafts", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each([
    ["API_KEY=fake npm start", false],
    ["npm start --token <redacted>", false],
    ["npm start", true],
  ])("offers only runnable unmasked commands: %s", async (command, includeCommand) => {
    const draft = vi.fn();
    vi.stubGlobal("ade", { localhost: { probePort: async () => true } });
    render(<ChatWorkLogBlock entries={[{
      ...base, entryKind: "command", command,
      localUrls: [{ url: "http://localhost:4321", href: "http://localhost:4321", host: "localhost", port: 4321 }],
    }]} onInsertDraft={draft} />);
    const logs = await screen.findByRole("button", { name: /Open terminal logs/ });
    fireEvent.click(logs);
    await waitFor(() => expect(draft).toHaveBeenCalledOnce());
    const text = draft.mock.calls[0]![0] as string;
    expect(text.includes("Detected command:")).toBe(includeCommand);
    expect(text).not.toContain("API_KEY=fake");
    expect(text).not.toContain("<redacted>");
    expect(text).toContain("http://localhost:4321");
  });
});
