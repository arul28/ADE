import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_VALUE_FLAGS, buildCliPlan } from "./cli";
import {
  CHAT_PARENT_FLAGS,
  DEFAULT_PARENT_FLAGS,
  SPAWN_TYPE_FLAGS,
} from "./launchFlagNames";

type ActionCall = {
  domain?: string;
  action?: string;
  args?: Record<string, unknown>;
  argsList?: unknown[];
};

function planOf(argv: string[]) {
  const plan = buildCliPlan(argv);
  if (plan.kind !== "execute") throw new Error(`Expected execute plan, got ${plan.kind}`);
  return plan;
}

function firstAction(argv: string[]): ActionCall {
  const step = planOf(argv).steps[0] as { params?: { arguments?: ActionCall } } | undefined;
  return step?.params?.arguments ?? {};
}

/** A value each flag's reader accepts, so the only thing under test is where the value goes. */
function sampleValue(flag: string): string {
  if (/^--(arg|set)$/.test(flag)) return "k=v";
  if (/^--(arg-json|set-json)$/.test(flag)) return "k=1";
  if (/json|^--input$/.test(flag)) return "{}";
  if (/-ms$/.test(flag)) return "5000";
  return "zz-value";
}

// Plan builders read the spawn-lineage default from the ambient chat session,
// so a suite running inside an ADE agent shell must not inherit one.
let ambientChatSession: string | undefined;
beforeEach(() => {
  ambientChatSession = process.env.ADE_CHAT_SESSION_ID;
  delete process.env.ADE_CHAT_SESSION_ID;
});
afterEach(() => {
  if (ambientChatSession === undefined) delete process.env.ADE_CHAT_SESSION_ID;
  else process.env.ADE_CHAT_SESSION_ID = ambientChatSession;
});

describe("ade browser argv grammar", () => {
  it.each<[string, string[], string, Record<string, unknown>]>([
    ["--tab-id before the subcommand", ["browser", "--tab-id", "t1", "close"], "closeTab", { tabId: "t1" }],
    ["--browser-session before the subcommand", ["browser", "--browser-session", "bs1", "close", "--tab", "t1"], "closeTab", { sessionId: "bs1", tabId: "t1" }],
    ["--upload before the subcommand", ["browser", "--upload", "/tmp/f.png", "upload", "--selector", "input"], "uploadFile", { paths: ["/tmp/f.png"], selector: "input" }],
    ["--keep (alias of --keep-count)", ["browser", "--keep", "3", "proof"], "observe", { keepCount: 3 }],
    ["--keep-count", ["browser", "--keep-count", "4", "proof"], "observe", { keepCount: 4 }],
    ["--selector before the fill text", ["browser", "--selector", "#q", "fill", "--tab", "t1", "hello"], "fill", { selector: "#q", text: "hello" }],
    ["--factor", ["browser", "--factor", "1.5", "zoom", "--tab", "tab-1"], "setZoom", { factor: 1.5 }],
    ["--mode", ["browser", "--mode", "bottom", "devtools", "--tab", "tab-1"], "setDevTools", { mode: "bottom" }],
    ["--reason", ["browser", "--reason", "sign in", "handoff", "--tab", "tab-1", "--no-wait"], "startHandoff", { reason: "sign in" }],
    ["--timeout", ["browser", "--timeout", "5m", "handoff", "--tab", "tab-1", "--reason", "r"], "startHandoff", { timeoutMs: 300_000 }],
    ["--device before the URL", ["browser", "--device", "ipad", "open", "https://x.test"], "navigate", { url: "https://x.test" }],
    ["--browser-session before the URL", ["browser", "open", "--browser-session", "s1", "https://x.test"], "navigate", { url: "https://x.test" }],
    ["--tab before the session mode word", ["browser", "session", "--tab", "t1", "end", "s1"], "endSession", { sessionId: "s1", tabId: "t1" }],
  ])("%s: the flag keeps its value and the positionals stay positional", (_name, argv, action, args) => {
    const call = firstAction(argv);
    expect(call).toMatchObject({ domain: "built_in_browser", action });
    expect(call.args).toMatchObject(args);
  });

  it.each(BROWSER_VALUE_FLAGS.map((flag) => [flag]))(
    "%s placed before the subcommand does not become the subcommand",
    (flag) => {
      expect(planOf(["browser", flag, sampleValue(flag), "sessions"]).label).toBe("browser sessions");
    },
  );

  it.each<[string, string[], string, Record<string, unknown>]>([
    ["--new-tab", ["browser", "--new-tab", "open", "https://x.test"], "navigate", { url: "https://x.test", newTab: true }],
    ["--reset", ["browser", "--reset", "zoom", "--tab", "tab-1"], "setZoom", { tabId: "tab-1", reset: true }],
    ["--mobile", ["browser", "--mobile", "emulate", "--tab", "t1", "--width", "1024", "--height", "768"], "setEmulation", { mobile: true, width: 1024 }],
    ["--off", ["browser", "--off", "emulate", "--tab", "tab-1"], "setEmulation", { tabId: "tab-1", preset: null }],
    ["--match-case", ["browser", "--match-case", "find", "--tab", "tab-1", "x"], "findInPage", { text: "x", matchCase: true }],
  ])("boolean %s does not swallow the token after it", (_flag, argv, action, args) => {
    const call = firstAction(argv);
    expect(call.action).toBe(action);
    expect(call.args).toMatchObject(args);
  });

  it.each(["--json", "--text", "--pretty", "--compact"])(
    "global output switch %s stays a boolean inside a browser command",
    (flag) => {
      expect(firstAction(["browser", flag, "close", "--tab", "t1"])).toMatchObject({
        action: "closeTab",
        args: { tabId: "t1" },
      });
    },
  );

  it("sees --help past a `--` that a browser flag takes as its value, and not past a real terminator", () => {
    // `--upload --` passes the literal "--" as the upload path, so the help
    // flag after it is still live.
    expect(
      buildCliPlan(["browser", "upload", "--selector", "input", "--upload", "--", "--help"]).kind,
    ).toBe("help");
    // An unclaimed `--` fences the tail: "--help" after it is a literal path.
    expect(firstAction(["browser", "upload", "--selector", "input", "--", "--help"])).toMatchObject({
      action: "uploadFile",
      args: { paths: ["--help"] },
    });
  });
});

describe("launch-lineage flags", () => {
  const lineageFlags = [
    ...new Set<string>([...SPAWN_TYPE_FLAGS, ...CHAT_PARENT_FLAGS, ...DEFAULT_PARENT_FLAGS]),
  ];

  it.each(lineageFlags.map((flag) => [flag]))(
    "%s carries its value outside the browser grammar, so the positional after it survives",
    (flag) => {
      expect(firstAction(["session", "show", flag, "p1", "s1"])).toMatchObject({
        domain: "session",
        action: "get",
        args: { sessionId: "s1" },
      });
    },
  );
});
