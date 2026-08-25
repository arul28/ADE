/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatCommandMenu } from "./ChatCommandMenu";

afterEach(() => {
  cleanup();
});

describe("ChatCommandMenu @ ranking", () => {
  it("lists a matching chat above a vaguely matching file and skips kind section headers", async () => {
    render(
      <ChatCommandMenu
        trigger={{ type: "at", query: "chat", start: 0 }}
        slashCommands={[]}
        onFileSearch={async () => [{ path: "apps/desktop/src/shared/chatMentions.ts" }]}
        onMentionSearch={async () => [{
          kind: "chat",
          id: "c1",
          title: "chat",
          lastActivityAt: 1,
        }]}
        anchor={{ top: 200, left: 20, bottom: 220 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("chat");
    await screen.findByText("chatMentions.ts");

    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-menu-index]"));
    expect(rows[0]?.textContent).toContain("chat");
    expect(rows[0]?.textContent).not.toContain("chatMentions.ts");
    expect(rows[1]?.textContent).toContain("chatMentions.ts");
    expect(screen.queryByText("Files")).toBeNull();
    expect(screen.queryByText("Chats")).toBeNull();
    expect(screen.queryByText("Lanes")).toBeNull();
  });

  it("keeps a kind icon on every mixed row", async () => {
    render(
      <ChatCommandMenu
        trigger={{ type: "at", query: "fix", start: 0 }}
        slashCommands={[]}
        onFileSearch={async () => [{ path: "src/fix.ts" }]}
        onMentionSearch={async () => [
          { kind: "lane", id: "l1", title: "fix-login", lastActivityAt: 20 },
          { kind: "chat", id: "c1", title: "Fix the chip", lastActivityAt: 10 },
        ]}
        anchor={{ top: 200, left: 20, bottom: 220 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.querySelectorAll("[data-menu-index]").length).toBeGreaterThanOrEqual(3);
    });
    for (const row of document.querySelectorAll("[data-menu-index]")) {
      expect(row.querySelector("svg")).not.toBeNull();
    }
  });

  it("splits Windows file paths on the last backslash for the row label", async () => {
    render(
      <ChatCommandMenu
        trigger={{ type: "at", query: "chatMentions", start: 0 }}
        slashCommands={[]}
        onFileSearch={async () => [{ path: "apps\\desktop\\src\\shared\\chatMentions.ts" }]}
        onMentionSearch={async () => []}
        anchor={{ top: 200, left: 20, bottom: 220 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("chatMentions.ts")).toBeTruthy();
    expect(screen.getByText("apps\\desktop\\src\\shared\\")).toBeTruthy();
  });
});
