import { describe, expect, it } from "vitest";
import {
  isAppleKeyboardPlatform,
  readDismissedScrollHints,
  terminalScrollHintFor,
  writeDismissedScrollHint,
} from "./terminalScrollHint";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("terminalScrollHintFor", () => {
  it("names PgUp/PgDn for the providers whose vendors document it", () => {
    expect(terminalScrollHintFor("claude", { applePlatform: false })?.keys).toBe("PgUp / PgDn");
    expect(terminalScrollHintFor("opencode", { applePlatform: false })?.keys).toBe("PgUp / PgDn");
  });

  it("tells Codex users to open the transcript overlay first", () => {
    // Codex scrolls through a Ctrl+T pager overlay, not the main view: a bare
    // PgUp hint would send people pressing a key that does nothing.
    expect(terminalScrollHintFor("codex", { applePlatform: false })?.keys).toBe("Ctrl+T, then PgUp / PgDn");
  });

  it("uses Fn+arrows on Apple keyboards, which have no PgUp/PgDn keys", () => {
    expect(isAppleKeyboardPlatform("MacIntel")).toBe(true);
    expect(isAppleKeyboardPlatform("Win32")).toBe(false);
    expect(terminalScrollHintFor("claude", { applePlatform: true })?.keys).toBe("Fn+↑ / Fn+↓");
    expect(terminalScrollHintFor("codex", { applePlatform: true })?.keys).toBe("Ctrl+T, then Fn+↑ / Fn+↓");
  });

  it("stays silent for providers whose scroll keys are unverified", () => {
    // droid and cursor-agent carry pageup handling in their binaries but no
    // vendor documentation. A wrong key hint is worse than none.
    expect(terminalScrollHintFor("droid")).toBeNull();
    expect(terminalScrollHintFor("cursor-cli")).toBeNull();
    expect(terminalScrollHintFor("shell")).toBeNull();
    expect(terminalScrollHintFor(null)).toBeNull();
  });
});

describe("scroll hint dismissal", () => {
  it("is remembered per provider, because the keys differ per provider", () => {
    const storage = memoryStorage();
    writeDismissedScrollHint(storage, "claude");
    const dismissed = readDismissedScrollHints(storage);
    expect(dismissed.has("claude")).toBe(true);
    expect(dismissed.has("codex")).toBe(false);
  });

  it("survives unreadable storage without throwing", () => {
    const hostile = {
      getItem: () => "not json",
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(readDismissedScrollHints(hostile).size).toBe(0);
    expect(() => writeDismissedScrollHint(hostile, "claude")).not.toThrow();
  });
});
