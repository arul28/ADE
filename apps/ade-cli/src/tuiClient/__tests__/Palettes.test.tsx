import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MentionPalette } from "../components/MentionPalette";
import { SlashPalette } from "../components/SlashPalette";
import type { MentionSuggestion } from "../types";

function stripAnsi(text: string): string {
  return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

const mentionSuggestions: MentionSuggestion[] = [
  {
    kind: "lane",
    label: "TUI picker polish",
    insertText: "@lane:lane-123",
    detail: "feature/tui-picker-polish",
  },
  {
    kind: "chat",
    label: "Current implementation thread",
    insertText: "@chat:chat-123",
    detail: "lane-123",
  },
  {
    kind: "file",
    label: "apps/ade-cli/src/tuiClient/components/MentionPalette.tsx",
    insertText:
      "@file:apps/ade-cli/src/tuiClient/components/MentionPalette.tsx",
    detail: "file",
    filePath: "apps/ade-cli/src/tuiClient/components/MentionPalette.tsx",
  },
  {
    kind: "commit",
    label: "Refine TUI command palettes",
    insertText: "@commit:abc1234",
    detail: "abc1234",
  },
  {
    kind: "pr",
    label: "Desktop parity for TUI pickers",
    insertText: "@pr:42",
    detail: "#42",
  },
  {
    kind: "file",
    label: "pasted-screenshot.png",
    insertText: "@pasted-screenshot.png",
    detail: "/tmp/pasted-screenshot.png",
    filePath: "/tmp/pasted-screenshot.png",
    attachment: true,
  },
];

describe("MentionPalette", () => {
  it("renders the desktop-style mention surface for mixed reference kinds", () => {
    const frame = stripAnsi(
      render(
        <MentionPalette
          suggestions={mentionSuggestions}
          selectedIndex={2}
          query="auth"
          width={100}
        />,
      ).lastFrame() ?? "",
    );

    expect(frame).toContain("References");
    expect(frame).toContain("@auth");
    expect(frame).toContain("6 matches");
    expect(frame).toContain("Lane");
    expect(frame).toContain("Chat");
    expect(frame).toContain("File");
    expect(frame).toContain("MentionPalette.tsx");
    expect(frame).toContain("Adds file context");
    expect(frame).toContain("Tab insert");
    expect(frame).not.toContain("Type");
  });
});

describe("SlashPalette", () => {
  it("uses the available center width for long slash command names", () => {
    const frame = stripAnsi(render(
      <SlashPalette
        query="/wide"
        userCommands={[{
          name: "/wide-subscription-localization",
          description: "Bulk-localize subscription and in-app purchase display names",
          source: "sdk",
        }]}
        selectedIndex={0}
        provider="claude"
        width={96}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("/wide-subscription-localization");
    expect(frame).toContain("Commands");
    expect(frame).toContain("1 match");
    expect(frame).toContain("Bulk-localize subscription");
    expect(frame).toContain("Tab insert");
    expect(frame).toContain("Enter run");
    expect(frame).not.toContain("Group");
    expect(frame.split("\n")[0]?.length).toBeGreaterThanOrEqual(90);
  });
});
