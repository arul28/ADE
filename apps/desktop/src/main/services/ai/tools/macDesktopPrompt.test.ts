import { describe, expect, it } from "vitest";
import { buildMacDesktopDirective } from "./macDesktopPrompt";

/**
 * The Mac Desktop prompt gate.
 *
 * The feature's entire agent-facing prompt budget is one line, and a lane with
 * the tool off must pay nothing for it — not a blank line, not a heading, not
 * a "(no desktop)" note. `composeLaunchDirectives` drops nulls and empty
 * strings, so "pays nothing" is provable here as "returns null". Insertion is
 * that composer's contract in `agentChatService`, which is not exported; this
 * file does not copy it, because a hand-copied composer asserts its own output
 * and keeps passing when the real one changes.
 */

describe("buildMacDesktopDirective", () => {
  // The line names the screen of the machine running the chat: a Windows
  // brain's agent was once told it had a macOS screen (2026-10-20).
  it.each([
    { host: "darwin", command: "ade mac-desktop", wrongHost: /Windows|ade screen/, safety: /do not fall back to the user's real screen/ },
    { host: "win32", command: "ade screen", wrongHost: /macOS|mac-desktop|Mac Desktop/, safety: /default seat is private.*needs their yes.*never use `--allow-prompt` or `--consent`/ },
  ] as const)("emits one $host line before and after screen activation", ({ host, command, wrongHost, safety }) => {
    for (const active of [false, true]) {
      const line = buildMacDesktopDirective(true, host, active)!;
      expect(line.split("\n")).toHaveLength(1);
      // Both the capability notice and active notice name the command, skill,
      // host, and the safety rule for the user's real screen.
      expect(line).toContain(command);
      expect(line).toContain("ade-computer-use");
      expect(line).toMatch(safety);
      expect(line).not.toMatch(wrongHost);
    }
  });

  it("says nothing for a lane with no desktop", () => {
    expect(buildMacDesktopDirective(false)).toBeNull();
  });
});
