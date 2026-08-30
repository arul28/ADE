/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * Why a plugin's slash command has to be ranked, not merely included.
 *
 * A live dogfood run installed a plugin declaring `/note`. Typing it ran the
 * plugin; the command menu never listed it, so the only way to use it was to
 * already know it existed. Nothing dropped the row — a Claude session offers
 * ~285 commands sorted by name, the subsequence filter admits nearly all of
 * them for a short query, and the ten-row cut then kept whichever ten sorted
 * first. `/note` had to win the alphabet.
 */
describe("ChatCommandMenu slash ranking", () => {
  // jsdom has no layout, so it ships no `scrollIntoView`; the menu calls it to
  // keep the selected row visible.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  const core = (name: string) => ({ name, description: `Core ${name}`, source: "sdk" as const });
  const plugin = (name: string) => ({
    name,
    description: `Plugin ${name}`,
    source: "plugin" as const,
    pluginName: "Journal",
  });

  function menu(query: string, commands: Array<ReturnType<typeof core> | ReturnType<typeof plugin>>) {
    render(
      <ChatCommandMenu
        trigger={{ type: "slash", query, start: 0 }}
        slashCommands={commands}
        anchor={{ top: 200, left: 20, bottom: 220 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    return Array.from(document.querySelectorAll<HTMLElement>("[data-menu-index]"))
      .map((row) => row.textContent ?? "");
  }

  /** Enough alphabetically-early core commands to fill the ten-row menu. */
  const alphabet = ["agents", "add-dir", "bashes", "clear", "compact", "config", "context", "cost", "doctor", "exit", "export"]
    .sort()
    .map(core);

  it("shows a plugin's command with an empty query, where the alphabet used to bury it", () => {
    const rows = menu("", [...alphabet, plugin("note")].sort((a, b) => a.name.localeCompare(b.name)));

    expect(rows[0]).toContain("note");
    expect(rows[0]).toContain("Journal");
  });

  it("puts a prefix match above a merely-fuzzy one", () => {
    // "co" is a subsequence of "cost" and "context" and a prefix of "compact"
    // and "config" — the old filter treated all four the same and let the
    // alphabet decide.
    const rows = menu("co", [core("compact"), core("config"), core("context"), core("cost")]);

    expect(rows[0]).toContain("compact");
    expect(rows[1]).toContain("config");
  });

  it("prefers an exact match over everything, including a plugin's row", () => {
    const rows = menu("clear", [core("clear"), plugin("cleanup-lanes")]);

    expect(rows[0]).toContain("clear");
  });

  it("still lists a plugin command a query only fuzzily matches", () => {
    const rows = menu("nt", [...alphabet, plugin("note")]);

    expect(rows.some((row) => row.includes("note"))).toBe(true);
  });
});
