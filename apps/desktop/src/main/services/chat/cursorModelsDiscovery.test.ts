import { describe, expect, it } from "vitest";
import { parseCursorCliModelsStdout } from "./cursorModelsDiscovery";

describe("parseCursorCliModelsStdout", () => {
  it("parses table lines with optional (current) suffix", () => {
    const raw = [
      "\x1b[2mLoading models…\x1b[0m",
      "Available models",
      "",
      "auto - Auto  (current)",
      "composer-2 - Composer 2",
      "claude-4.6-sonnet-medium - Sonnet 4.6 1M",
    ].join("\n");

    const rows = parseCursorCliModelsStdout(raw);
    expect(rows.map((r) => r.id)).toEqual(["auto", "composer-2", "claude-4.6-sonnet-medium"]);
    expect(rows[0]?.displayName).toBe("Auto");
    expect(rows[1]?.displayName).toBe("Composer 2");
  });

  it("dedupes repeated ids", () => {
    const rows = parseCursorCliModelsStdout("auto - Auto\nauto - Auto");
    expect(rows).toHaveLength(1);
  });
});
