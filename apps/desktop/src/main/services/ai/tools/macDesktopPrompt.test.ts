import { describe, expect, it } from "vitest";
import {
  MAC_DESKTOP_PROMPT_LINE,
  buildMacDesktopDirective,
} from "./macDesktopPrompt";

/**
 * The Mac Desktop prompt gate.
 *
 * The feature's entire agent-facing prompt budget is one line, and a lane with
 * the tool off must pay nothing for it — not a blank line, not a heading, not
 * a "(no desktop)" note. `composeLaunchDirectives` drops nulls and empty
 * strings, so "pays nothing" is provable here as "returns null", plus the
 * byte-identity check below over the composer's own rule.
 */

/** `composeLaunchDirectives` from agentChatService, reproduced exactly. */
function composeLaunchDirectives(baseText: string, directives: Array<string | null | undefined>): string {
  const filtered = directives
    .map((directive) => (typeof directive === "string" ? directive.trim() : ""))
    .filter((directive) => directive.length > 0);
  if (filtered.length === 0) return baseText;
  return `${filtered.join("\n\n")}\n\nUser request:\n${baseText}`;
}

describe("buildMacDesktopDirective", () => {
  it("emits exactly one line, and only for a lane whose desktop tool is on", () => {
    expect(buildMacDesktopDirective(true)).toBe(MAC_DESKTOP_PROMPT_LINE);
    expect(MAC_DESKTOP_PROMPT_LINE.split("\n")).toHaveLength(1);
    // It must name the command and the skill, or the line buys nothing.
    expect(MAC_DESKTOP_PROMPT_LINE).toContain("ade mac-desktop");
    expect(MAC_DESKTOP_PROMPT_LINE).toContain("ade-desktop");
  });

  it("says nothing for a lane with no desktop", () => {
    expect(buildMacDesktopDirective(false)).toBeNull();
  });

  it("leaves the desktop-off prompt byte-identical to the prompt built without it", () => {
    const otherDirectives = ["## Lane worktree\nWork in /repo/.ade/worktrees/lane-1.", "## Computer Use\nProof is intentional."];
    const before = composeLaunchDirectives("ship the thing", otherDirectives);
    const afterOff = composeLaunchDirectives("ship the thing", [
      ...otherDirectives,
      buildMacDesktopDirective(false),
    ]);
    expect(afterOff).toBe(before);
    expect(Buffer.byteLength(afterOff)).toBe(Buffer.byteLength(before));

    // And an idle lane with NO other directives still gets the bare prompt.
    expect(composeLaunchDirectives("ship the thing", [buildMacDesktopDirective(false)]))
      .toBe("ship the thing");

    // On, it costs exactly the line and the separator — nothing else moves.
    const afterOn = composeLaunchDirectives("ship the thing", [
      ...otherDirectives,
      buildMacDesktopDirective(true),
    ]);
    expect(afterOn).toBe(
      before.replace("\n\nUser request:", `\n\n${MAC_DESKTOP_PROMPT_LINE}\n\nUser request:`),
    );
  });
});
