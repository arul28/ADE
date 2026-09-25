import { describe, expect, it } from "vitest";
import type { AgentChatEvent } from "../../../shared/types/chat";
import { createSessionActivityDetector } from "./sessionActivityDetector";

const command = (text: string, itemId?: string): AgentChatEvent => ({
  type: "command",
  command: text,
  cwd: "/lane",
  output: "",
  status: "running",
  itemId: itemId ?? text,
});

const tool = (
  name: string,
  args: unknown = {},
  extra: Record<string, unknown> = {},
): AgentChatEvent => ({ type: "tool_call", tool: name, args, ...extra } as AgentChatEvent);

const read = (itemId = "read"): AgentChatEvent => ({ type: "tool_call", tool: "read", args: { path: "src" }, itemId });

describe("session activity detection", () => {
  it.each([
    ["ignores runner names in file paths and arguments", "cat vitest.config.ts", "rg availableModels", "shipping", "git commit -m 'fix jest'", "jestify test", "avax test"],
    ["classifies wrapped test commands", "/bin/zsh -lc 'npm test'", "powershell.exe -NoProfile -Command \"pnpm.cmd test\"", "cmd /c npm test"],
  ])("uses command position for shell evidence: %s", (_name, ...commands) => {
    for (const text of commands) {
      const detector = createSessionActivityDetector();
    detector.observe(read("initial"), 0);
      const outcome = detector.observe(command(text), 1_000);
      const expected = /^(?:cat |rg |shipping$|git commit|jestify|avax)/.test(text) ? "exploring" : "testing";
      expect(outcome.counted).toBe(true);
      if (text.includes("vitest.config") || text.includes("availableModels") || text === "shipping"
        || text.includes("git commit") || text.startsWith("jestify") || text.startsWith("avax")) {
        expect(outcome.activity, text).toBe("exploring");
      } else {
        expect(outcome.activity, text).toBe("testing");
      }
      expect(detector.current).toBe(expected);
    }
  });

  it("requires two weak signals after activity evidence, while strong signals switch at once", () => {
    const detector = createSessionActivityDetector();
    detector.observe(command("npm test", "test-1"), 1_000);
    expect(detector.observe(command("git push", "push-1"), 181_000).activity).toBe("testing");
    expect(detector.observe(command("git push", "push-2"), 182_000).activity).toBe("shipping");
    expect(detector.observe({ type: "subagent_started", taskId: "review", description: "Review implementation" }, 183_000).activity)
      .toBe("reviewing");
  });

  it("reclassifies a refined command once and ignores unchanged repeats", () => {
    const detector = createSessionActivityDetector();
    expect(detector.observe(command("npm", "exec-1"), 1_000)).toEqual({ activity: "exploring", counted: true });
    expect(detector.observe(command("npm test", "exec-1"), 2_000)).toEqual({ activity: "testing", counted: true });
    expect(detector.observe(command("npm test", "exec-1"), 3_000)).toEqual({ activity: "testing", counted: false });
  });

  it("does not count same-class command refinements as additional weak signals or reads", () => {
    const shipping = createSessionActivityDetector();
    shipping.observe(read("initial"), 1_000);
    expect(shipping.observe(command("git push", "push-1"), 2_000)).toEqual({ activity: "exploring", counted: true });
    expect(shipping.observe(command("git push origin", "push-1"), 3_000)).toEqual({ activity: "exploring", counted: false });
    expect(shipping.observe(command("git push", "push-2"), 4_000)).toEqual({ activity: "shipping", counted: true });

    const reads = createSessionActivityDetector();
    reads.observe(command("npm test", "test"), 1_000);
    expect(reads.observe(command("cat README.md", "read-1"), 2_000)).toEqual({ activity: "testing", counted: true });
    expect(reads.observe(command("cat docs.md", "read-1"), 3_000)).toEqual({ activity: "testing", counted: false });
    for (let index = 0; index < 10; index += 1) {
      expect(reads.observe(command(`cat file-${index}.md`, `read-${index + 2}`), 4_000 + index).activity).toBe("testing");
    }
    expect(reads.observe(command("cat final.md", "read-final"), 5_000).activity).toBe("exploring");
  });

  it("does not carry weak evidence across a strong activity transition", () => {
    const detector = createSessionActivityDetector();
    detector.observe(read("initial"), 1_000);
    expect(detector.observe(command("git push", "push-before-test"), 2_000).activity).toBe("exploring");
    expect(detector.observe(command("npm test", "test"), 3_000).activity).toBe("testing");
    expect(detector.observe(command("git push", "push-after-test-1"), 4_000).activity).toBe("testing");
    expect(detector.observe(command("git push", "push-after-test-2"), 5_000).activity).toBe("shipping");
  });

  it("keeps edits in a test loop, and returns to exploring after twelve reads", () => {
    const detector = createSessionActivityDetector();
    detector.observe(command("npm test"), 1_000);
    expect(detector.observe(tool("edit", { path: "src/fix.ts" }), 30_000).activity).toBe("testing");
    for (let index = 0; index < 11; index += 1) {
      expect(detector.observe(read(`read-${index}`), 40_000 + index).activity).toBe("testing");
    }
    expect(detector.observe(read("read-11"), 50_000).activity).toBe("exploring");
  });

  it("ignores nested and placeholder calls and deduplicates streamed item ids", () => {
    const detector = createSessionActivityDetector();
    expect(detector.observe(command("command", "placeholder"), 1_000)).toEqual({ activity: null, counted: false });
    expect(detector.observe(tool("bash", { command: "npm test" }, { parentItemId: "parent" }), 2_000))
      .toEqual({ activity: null, counted: false });
    expect(detector.observe(command("npm test", "runner"), 3_000)).toEqual({ activity: "testing", counted: true });
    expect(detector.observe(command("npm test", "runner"), 4_000)).toEqual({ activity: "testing", counted: false });
  });

  it("waits for a shell command field but treats an explicit empty command as a read", () => {
    const detector = createSessionActivityDetector();
    expect(detector.observe(tool("bash", { cwd: "/lane" }), 1_000)).toEqual({ activity: null, counted: false });
    expect(detector.observe(tool("unnamed", { cwd: "/lane" }, { toolKind: "execute" }), 2_000))
      .toEqual({ activity: null, counted: false });
    expect(detector.observe(tool("bash", { command: "" }), 3_000)).toEqual({ activity: "exploring", counted: true });
  });
});
