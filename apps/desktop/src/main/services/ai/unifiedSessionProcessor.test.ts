import { describe, expect, it } from "vitest";
import { UnifiedSessionProcessor } from "./unifiedSessionProcessor";

describe("UnifiedSessionProcessor", () => {
  it("emits a blocked summary and stream-end after a policy break stops further tool use", async () => {
    const processor = new UnifiedSessionProcessor();
    processor.startTurn({
      cwd: "/repo",
      modelDescriptor: {
        authTypes: ["local"],
        harnessProfile: "guarded",
      },
      permissionMode: "plan",
    });

    const tools = processor.wrapTools({
      grep: {
        description: "stub",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ matches: [], matchCount: 0 }),
      } as any,
    });

    const eventTypes: string[] = [];
    let blockedSummary = "";
    let streamEnd: { assistantText: string; blockedByStopTools: boolean } | null = null;

    async function* fullStream() {
      for (let index = 1; index <= 3; index += 1) {
        const input = { path: "/repo", pattern: "Route" };
        yield { type: "tool-call", toolName: "grep", toolCallId: `tool-${index}`, input };
        const execute = (tools.grep as unknown as { execute: (input: unknown) => Promise<unknown> }).execute;
        const output = await execute(input);
        yield { type: "tool-result", toolName: "grep", toolCallId: `tool-${index}`, output };
      }
    }

    for await (const event of processor.processStream({ fullStream: fullStream() })) {
      eventTypes.push(event.type);
      if (event.type === "blocked-summary") {
        blockedSummary = event.text;
      }
      if (event.type === "stream-end") {
        streamEnd = {
          assistantText: event.assistantText,
          blockedByStopTools: event.blockedByStopTools,
        };
      }
    }

    expect(eventTypes).toEqual([
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
      "tool-call",
      "break",
      "blocked-summary",
      "stream-end",
    ]);
    expect(blockedSummary).toContain("I am stopping tool use for this turn because the tool pattern became repetitive.");
    expect(streamEnd).toMatchObject({
      blockedByStopTools: true,
    });
    expect(streamEnd?.assistantText).toContain("I am stopping tool use for this turn because the tool pattern became repetitive.");
  });
});
