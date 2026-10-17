import { describe, expect, it } from "vitest";
import { releaseDeletedTerminalIds, rememberKnownTerminalId } from "./knownTerminalIds";

describe("rememberKnownTerminalId", () => {
  it("never forgets an id on its own, however many newer ids arrive", () => {
    const known = new Set<string>();
    rememberKnownTerminalId(known, "terminal-live");
    for (let i = 0; i < 20_000; i += 1) rememberKnownTerminalId(known, `terminal-${i}`);

    expect(known.has("terminal-live")).toBe(true);
    expect(known.size).toBe(20_001);
  });

  it("keeps one entry for an id remembered twice", () => {
    const known = new Set<string>();
    rememberKnownTerminalId(known, "terminal-a");
    rememberKnownTerminalId(known, "terminal-a");

    expect(known.size).toBe(1);
  });
});

describe("releaseDeletedTerminalIds", () => {
  const setup = () => {
    const known = new Set(["gone", "live-omitted", "listed", "other-chat-gone", "lookup-fails"]);
    const owners = new Map([
      ["gone", "chat-a"],
      ["live-omitted", "chat-a"],
      ["listed", "chat-a"],
      ["other-chat-gone", "chat-b"],
      ["lookup-fails", "chat-a"],
    ]);
    return { known, owners };
  };

  it("releases only this chat's omitted ids that the lookup reports gone", async () => {
    const { known, owners } = setup();
    const lookup = async (id: string) => {
      if (id === "lookup-fails") throw new Error("offline");
      if (id === "live-omitted") return { id, status: "running" };
      return null;
    };
    await releaseDeletedTerminalIds({ known, owners, chatSessionId: "chat-a", listedIds: new Set(["listed"]), lookup });

    expect([...known].sort()).toEqual(["listed", "live-omitted", "lookup-fails", "other-chat-gone"]);
    expect(owners.has("gone")).toBe(false);
  });

  it("does not look up ids the read listed or that belong to another chat", async () => {
    const { known, owners } = setup();
    const looked: string[] = [];
    await releaseDeletedTerminalIds({
      known, owners, chatSessionId: "chat-a", listedIds: new Set(["listed"]),
      lookup: async (id) => { looked.push(id); return { id }; },
    });

    expect(looked.sort()).toEqual(["gone", "live-omitted", "lookup-fails"]);
    expect(known.size).toBe(5);
  });
});
