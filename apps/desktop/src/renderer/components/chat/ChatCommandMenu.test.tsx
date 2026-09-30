/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatCommandMenu } from "./ChatCommandMenu";

afterEach(() => {
  cleanup();
});

describe("ChatCommandMenu @ ranking", () => {
  it("groups rows under kind sections with the best match leading", async () => {
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

    // The better-matching chat is still first, and each kind is now a section.
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-menu-index]"));
    expect(rows[0]?.textContent).toContain("chat");
    expect(rows[0]?.textContent).not.toContain("chatMentions.ts");
    expect(screen.getByText("Chats")).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
  });

  it("expands a + N more section row in place instead of closing", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <ChatCommandMenu
        trigger={{ type: "at", query: "fix", start: 0 }}
        slashCommands={[]}
        onFileSearch={async () => ["fix1.ts", "fix2.ts", "fix3.ts", "fix4.ts"].map((path) => ({ path }))}
        onMentionSearch={async () => [{ kind: "chat", id: "c1", title: "fix", lastActivityAt: 1 }]}
        anchor={{ top: 200, left: 20, bottom: 220 }}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const more = await screen.findByText(/\+ 1 more files/);
    fireEvent.click(more);
    await waitFor(() => {
      expect(screen.queryByText(/\+ 1 more files/)).toBeNull();
    });
    // Expanding is an in-place action, not a selection: the menu stays open.
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(await screen.findByText("fix4.ts")).toBeTruthy();
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

describe("ChatCommandMenu / ranking", () => {
  it("ranks /test above longer names that only contain its letters", async () => {
    render(
      <ChatCommandMenu
        trigger={{ type: "slash", query: "test", start: 0 }}
        slashCommands={[
          { name: "asc-testflight-orchestration", description: "Orchestrate TestFlight", source: "sdk" },
          { name: "clerk-testing", description: "E2E testing for Clerk", source: "sdk" },
          { name: "test", description: "Prove the new code works", source: "sdk" },
        ]}
        anchor={{ top: 200, left: 20, bottom: 220 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("/test");
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-menu-index]"));
    expect(rows[0]?.textContent).toContain("/test");
    expect(rows[0]?.textContent).not.toContain("testflight");
  });
});

