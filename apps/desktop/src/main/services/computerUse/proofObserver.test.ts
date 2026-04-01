import { describe, expect, it, vi } from "vitest";
import type { ComputerUseArtifactIngestionRequest } from "../../../shared/types";
import { createProofObserver } from "./proofObserver";

function createHarness() {
  const requests: ComputerUseArtifactIngestionRequest[] = [];
  const broker = {
    ingest: vi.fn((request: ComputerUseArtifactIngestionRequest) => {
      requests.push(request);
      return { artifacts: [], links: [] };
    }),
  } as any;
  return {
    requests,
    broker,
    observer: createProofObserver({ broker }),
  };
}

describe("proofObserver", () => {
  it("captures embedded screenshot and trace paths from generic tool output", () => {
    const { observer, requests } = createHarness();

    observer.observe({
      type: "tool_result",
      tool: "functions.exec_command",
      result: "Saved screenshot to /tmp/proof.png\nSaved trace to /tmp/session-trace.zip",
      itemId: "item-1",
      status: "completed",
    }, "chat-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.backend).toMatchObject({
      style: "external_cli",
      name: "functions",
      toolName: "functions.exec_command",
    });
    expect(requests[0]?.inputs).toEqual([
      expect.objectContaining({
        kind: "screenshot",
        path: "/tmp/proof.png",
      }),
      expect.objectContaining({
        kind: "browser_trace",
        path: "/tmp/session-trace.zip",
      }),
    ]);
  });

  it("normalizes file URLs and ingests console log artifacts", () => {
    const { observer, requests } = createHarness();

    observer.observe({
      type: "tool_result",
      tool: "functions.exec_command",
      result: {
        consoleLogPath: "file:///tmp/browser-console.log",
      },
      itemId: "item-2",
      status: "completed",
    }, "chat-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.inputs).toEqual([
      expect.objectContaining({
        kind: "console_logs",
        path: "/tmp/browser-console.log",
      }),
    ]);
  });

  it("attributes ADE-proxied external MCP tools to the proxied server", () => {
    const { observer, requests } = createHarness();

    observer.observe({
      type: "tool_result",
      tool: "mcp__ade__ext.playwright.browser_take_screenshot",
      result: {
        outputPath: "/tmp/playwright-shot.png",
      },
      itemId: "item-3",
      status: "completed",
    }, "chat-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.backend).toMatchObject({
      style: "external_mcp",
      name: "playwright",
      toolName: "mcp__ade__ext.playwright.browser_take_screenshot",
    });
    expect(requests[0]?.inputs).toEqual([
      expect.objectContaining({
        kind: "screenshot",
        path: "/tmp/playwright-shot.png",
      }),
    ]);
  });

  it("ignores image URLs embedded inside PR comment bodies", () => {
    const { observer, requests } = createHarness();

    observer.observe({
      type: "tool_result",
      tool: "mcp__ade__pr_get_review_comments",
      result: {
        comments: [
          {
            author: "cursor[bot]",
            body: "Cursor logo: https://cursor.com/assets/logo.png",
          },
        ],
      },
      itemId: "item-4",
      status: "completed",
    }, "chat-1");

    expect(requests).toHaveLength(0);
  });
});
