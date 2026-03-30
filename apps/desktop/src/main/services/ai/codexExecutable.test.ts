import { describe, expect, it } from "vitest";
import { resolveCodexExecutable } from "./codexExecutable";

describe("resolveCodexExecutable", () => {
  it("uses the detected Codex auth path before falling back to PATH lookup", () => {
    expect(
      resolveCodexExecutable({
        auth: [
          {
            type: "cli-subscription",
            cli: "codex",
            path: "/Users/arul/.npm-global/bin/codex",
            authenticated: true,
            verified: true,
          },
        ],
        env: {
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({
      path: "/Users/arul/.npm-global/bin/codex",
      source: "auth",
    });
  });
});
