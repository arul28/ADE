import { describe, expect, it } from "vitest";

import { copyToClipboard } from "../../lib/clipboard";
import {
  buildDeeplinkForRow,
  parseGitHubPrUrl,
  type DeeplinkRow,
} from "../deeplinkRow";
import {
  dispatchKeybinding,
  validateClaudeKeybindingsConfig,
} from "../keybindings";

const laneUuid = "550e8400-e29b-41d4-a716-446655440000";

describe("copy ADE deeplink keybinding", () => {
  it("registers as a known TUI action and dispatches under Tabs context", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Tabs", bindings: { "ctrl+y": "app:copyAdeDeeplink" } },
      ],
    });
    expect(diagnostics.bindingCount).toBe(1);
    expect(diagnostics.warnings).toEqual([]);
    expect(
      dispatchKeybinding(diagnostics.bindings, "Tabs", "y", { ctrl: true }),
    ).toBe("app:copyAdeDeeplink");
  });

  it("dispatches under the Select (lane-details) context too", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Select", bindings: { "ctrl+y": "app:copyAdeDeeplink" } },
      ],
    });
    expect(diagnostics.bindingCount).toBe(1);
    expect(
      dispatchKeybinding(diagnostics.bindings, "Select", "y", { ctrl: true }),
    ).toBe("app:copyAdeDeeplink");
  });

  it("does not dispatch in unrelated contexts (Chat)", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Tabs", bindings: { "ctrl+y": "app:copyAdeDeeplink" } },
      ],
    });
    expect(
      dispatchKeybinding(diagnostics.bindings, "Chat", "y", { ctrl: true }),
    ).toBeUndefined();
  });

  it("builds the ade:// deeplink for a lane row", () => {
    const row: DeeplinkRow = { kind: "lane", lane: { id: laneUuid } };
    expect(buildDeeplinkForRow(row)).toBe(`ade://lane/${laneUuid}`);
  });

  it("builds the ade:// deeplink for a PR row from explicit fields", () => {
    const row: DeeplinkRow = {
      kind: "pr",
      pr: { repoOwner: "anthropics", repoName: "ade", prNumber: 42 },
    };
    expect(buildDeeplinkForRow(row)).toBe("ade://pr/anthropics/ade/42");
  });

  it("builds the ade:// deeplink for a PR row by parsing the GitHub URL", () => {
    const row: DeeplinkRow = {
      kind: "pr",
      pr: { url: "https://github.com/anthropics/ade/pull/322", prNumber: 322 },
    };
    expect(buildDeeplinkForRow(row)).toBe("ade://pr/anthropics/ade/322");
  });

  it("returns null when the PR row has no URL and no owner/repo", () => {
    const row: DeeplinkRow = {
      kind: "pr",
      pr: { url: "not-a-url" },
    };
    expect(buildDeeplinkForRow(row)).toBeNull();
  });

  it("parseGitHubPrUrl rejects non-pull paths", () => {
    expect(
      parseGitHubPrUrl("https://github.com/anthropics/ade/issues/7"),
    ).toBeNull();
    expect(parseGitHubPrUrl("")).toBeNull();
  });
});

describe("clipboard helper dispatches the right OS command", () => {
  it("uses pbcopy on darwin with the deeplink as stdin", () => {
    const calls: Array<{ cmd: string; args: string[]; input: string }> = [];
    const ok = copyToClipboard("ade://lane/abc", {
      platform: "darwin",
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, input: opts.input });
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([{ cmd: "pbcopy", args: [], input: "ade://lane/abc" }]);
  });

  it("uses clip on win32", () => {
    const calls: Array<{ cmd: string; args: string[]; input: string }> = [];
    const ok = copyToClipboard("ade://pr/o/r/1", {
      platform: "win32",
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, input: opts.input });
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(calls[0]?.cmd).toBe("clip");
  });

  it("prefers wl-copy on linux, falling back to xclip", () => {
    const wlCalls: Array<string> = [];
    const okWl = copyToClipboard("ade://lane/x", {
      platform: "linux",
      commandExists: (cmd) => cmd === "wl-copy",
      spawn: (cmd, _args, _opts) => {
        wlCalls.push(cmd);
        return { status: 0 };
      },
    });
    expect(okWl).toBe(true);
    expect(wlCalls).toEqual(["wl-copy"]);

    const xclipCalls: Array<{ cmd: string; args: string[] }> = [];
    const okX = copyToClipboard("ade://lane/x", {
      platform: "linux",
      commandExists: (cmd) => cmd === "xclip",
      spawn: (cmd, args, _opts) => {
        xclipCalls.push({ cmd, args });
        return { status: 0 };
      },
    });
    expect(okX).toBe(true);
    expect(xclipCalls).toEqual([{ cmd: "xclip", args: ["-selection", "clipboard"] }]);
  });

  it("returns false when no linux clipboard tool is available", () => {
    const ok = copyToClipboard("ade://lane/x", {
      platform: "linux",
      commandExists: () => false,
      spawn: () => ({ status: 0 }),
    });
    expect(ok).toBe(false);
  });

  it("returns false when the spawn errors out", () => {
    const ok = copyToClipboard("ade://lane/x", {
      platform: "darwin",
      spawn: () => ({ error: new Error("ENOENT") }),
    });
    expect(ok).toBe(false);
  });
});

describe("end-to-end: keybinding action invokes clipboard with the right URL", () => {
  // This emulates how runKeybindingAction wires the dispatch path: resolve the
  // focused row to a DeeplinkRow, build the URL, and hand it to copyToClipboard.
  // We do not render the Ink app — this is the contract the TUI relies on.
  function runCopyAdeDeeplinkAction(row: DeeplinkRow | null, recorded: { url: string | null }): "copied" | "no-row" | "no-url" | "no-clipboard" {
    if (!row) return "no-row";
    const url = buildDeeplinkForRow(row);
    if (!url) return "no-url";
    const ok = copyToClipboard(url, {
      platform: "darwin",
      spawn: (_cmd, _args, opts) => {
        recorded.url = opts.input;
        return { status: 0 };
      },
    });
    return ok ? "copied" : "no-clipboard";
  }

  it("copies the canonical lane URL when a lane row is focused", () => {
    const recorded = { url: null as string | null };
    const result = runCopyAdeDeeplinkAction(
      { kind: "lane", lane: { id: laneUuid } },
      recorded,
    );
    expect(result).toBe("copied");
    expect(recorded.url).toBe(`ade://lane/${laneUuid}`);
  });

  it("copies the canonical PR URL when a PR row is focused", () => {
    const recorded = { url: null as string | null };
    const result = runCopyAdeDeeplinkAction(
      {
        kind: "pr",
        pr: { url: "https://github.com/anthropics/ade/pull/7", prNumber: 7 },
      },
      recorded,
    );
    expect(result).toBe("copied");
    expect(recorded.url).toBe("ade://pr/anthropics/ade/7");
  });

  it("reports no-row when nothing is focused", () => {
    const recorded = { url: null as string | null };
    expect(runCopyAdeDeeplinkAction(null, recorded)).toBe("no-row");
    expect(recorded.url).toBeNull();
  });
});
