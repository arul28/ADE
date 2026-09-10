import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSER_VALUE_FLAGS, VALUE_CARRIER_FLAGS, buildCliPlan } from "./cli";

const SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"),
  "utf8",
);

/** The body of a top-level `function <name>(…) { … }`, braces balanced. */
function functionBody(name: string): string {
  const match = new RegExp(`\\nfunction ${name}\\b`).exec(SOURCE);
  if (!match) throw new Error(`no function ${name} in cli.ts`);
  const start = SOURCE.indexOf("{", match.index + match[0].length);
  let depth = 0;
  for (let i = start; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}" && (depth -= 1) === 0) return SOURCE.slice(start, i);
  }
  throw new Error(`unbalanced ${name}`);
}

function flagsReadFor(pattern: RegExp, source: string): Set<string> {
  const flags = new Set<string>();
  for (const call of source.matchAll(pattern))
    for (const flag of call[1]!.matchAll(/"(--?[^"]+)"/g)) flags.add(flag[1]!);
  return flags;
}

const PLAN_SOURCE = [
  "buildBrowserPlan",
  "buildBrowserPlanWithLiteralTail",
  "buildBrowserHandoffPlan",
  "readToolClaimArgs",
  ...[...SOURCE.matchAll(/\nfunction (readBrowser\w+)\b/g)].map((m) => m[1]!),
]
  .map(functionBody)
  .join("\n");

describe("browser value flags", () => {
  it("covers every flag the browser plan reads a value for", () => {
    // `readRepeatedValues` is in the scan too: it consumes exactly like
    // `readValue`, so `--upload` carries a value and must be in the table or
    // `browser --upload path upload` dispatches on "path".
    const read = flagsReadFor(
      /read(?:Value|NumberOption|IntOption|RepeatedValues)\(\s*\w+\s*,\s*(\[[^\]]*\]|"[^"]*")/g,
      PLAN_SOURCE,
    );
    expect(read.size).toBeGreaterThan(80);
    expect([...read].filter((flag) => !BROWSER_VALUE_FLAGS.includes(flag))).toEqual([]);
  });

  it("passes the browser table to every carrier-aware reader in the plan", () => {
    // `firstStandalonePositional` & co. default to the CLI-global carrier set,
    // so a browser-plan call that forgets `BROWSER_VALUE_CARRIER_FLAGS`
    // silently narrows the grammar back and `browser --tab-id t1 close`
    // dispatches on "t1" again — with no other test failing.
    const calls = [
      ...PLAN_SOURCE.matchAll(
        /\b(firstStandalonePositional|standalonePositionals|firstTerminatorIndex|takeArgsAfterTerminator)\(([^()]*)\)/g,
      ),
    ];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(
      calls
        .filter(([, , callArgs]) => !callArgs!.includes("BROWSER_VALUE_CARRIER_FLAGS"))
        .map(([call]) => call),
    ).toEqual([]);
  });

  // The browser table is passed to the positional readers by the browser
  // builder alone, but a name in it is still read CLI-wide by whatever command
  // owns it, and the global set is still read by every other command. Both
  // scans run over the WHOLE file: scanning only the browser plan is how
  // `--text` — a global boolean output switch — became a browser carrier and
  // broke `ade session show --text s1`.
  const ALL_BOOLEAN_FLAGS = flagsReadFor(
    /readFlag\(\s*\w+\s*,\s*(\[[^\]]*\]|"[^"]*")/g,
    SOURCE,
  );

  it("claims no flag that is read as a boolean anywhere in the CLI", () => {
    // A boolean in a carrier set would swallow the positional after it.
    // `chat generate-names --title --lane`, `--cli|--terminal`, `--create|-b`
    // and `--automation|--include-automation` read a name that some other
    // command carries a value for as a boolean. Each of those commands takes
    // no positional after the flag, so the collisions are inert — but they are
    // the ONLY ones allowed. A new name here means some command just started
    // swallowing the token after a boolean flag.
    expect(BROWSER_VALUE_FLAGS.filter((flag) => ALL_BOOLEAN_FLAGS.has(flag)).sort()).toEqual([
      "--lane",
      "--title",
    ]);
    expect([...VALUE_CARRIER_FLAGS].filter((flag) => ALL_BOOLEAN_FLAGS.has(flag)).sort()).toEqual([
      "--automation",
      "--lane",
      "--terminal",
      "--title",
      "-b",
    ]);
  });

  it("keeps the global output switches out of the browser table", () => {
    // `parseCliArgs` strips these before the command ever sees them, so a
    // browser command that named one as its value flag could never be trusted.
    const globalSwitches = [...SOURCE.matchAll(/token === ("--[a-z-]+")/g)]
      .map((match) => JSON.parse(match[1]!) as string)
      .filter((flag) => !VALUE_CARRIER_FLAGS.has(flag));
    expect(globalSwitches).toContain("--text");
    expect(BROWSER_VALUE_FLAGS.filter((flag) => globalSwitches.includes(flag))).toEqual([]);
  });

  it("does not widen any other command's grammar", () => {
    // The regression the table caused: `--text` carried a value CLI-wide.
    expect(actionArgs(buildCliPlan(["session", "show", "--text", "s1"]))).toMatchObject({
      sessionId: "s1",
    });
    expect(actionArgs(buildCliPlan(["chat", "send", "--text", "s1", "hello"]))).toMatchObject({
      sessionId: "s1",
    });
  });
});

// label prefix | every subcommand word that must reach it, in any argv shape.
const SUBCOMMANDS = [
  "browser actions|actions",
  "browser origin access|authorize approve-origin request-access",
  "browser status|status tabs list",
  "browser dev servers|dev-servers dev-server devservers servers localhost",
  "browser session|session sessions",
  "browser handoff|handoff hand-off sign-in",
  "browser claim|claim",
  "browser panel|panel show open-panel reveal",
  "browser open|open navigate go",
  "browser new tab|new-tab tab new",
  "browser switch|switch activate",
  "browser close|close close-tab",
  "browser click|click",
  "browser fill|fill",
  "browser clear|clear clear-field clear-input clear-value clear-selection",
  "browser zoom|zoom",
  "browser hover|hover",
  "browser back|back",
  "browser forward|forward",
  "browser stop|stop",
  "browser inspect|inspect inspect-start start-inspect inspect-stop stop-inspect",
  "browser select|select-current selection selected select select-point point",
  "browser observe|observe snapshot",
  "browser type|type type-text",
  "browser key|key press dispatch-key",
  "browser scroll|scroll wheel",
  "browser wait|wait wait-for",
  "browser emulate|emulate device emulation",
  "browser find|find find-in-page search-page find-stop stop-find",
  "browser devtools|devtools dev-tools inspector",
  "browser network|network net requests",
  "browser har|har export-har",
  "browser drag|drag drag-and-drop",
  "browser select option|select-option choose option",
  "browser upload|upload upload-file attach-file",
  "browser record|record recording",
  "browser trace|trace action-trace timeline",
  "browser proof|proof promote",
  "browser reload|reload refresh",
  "browser screenshot|screenshot capture",
].flatMap((row) => {
  const [label, subs] = row.split("|") as [string, string];
  return subs.split(" ").map((sub) => ({ sub, label }));
});

// bare, terminator, fenced literal, value flag before and after the word, and a
// value flag carrying a literal `--`.
const SHAPES = (sub: string): string[][] => [
  [sub],
  [sub, "--"],
  [sub, "--", "--literal"],
  [sub, "--tab", "t1"],
  ["--tab", "t1", sub],
  ["--tab-id", "t1", sub],
  [sub, "--tab", "--"],
  [sub, "--", "a", "b"],
  // A repeatable value flag before the word: `browser --upload path upload`
  // must dispatch on "upload", not on "path".
  ["--upload", "path", sub],
];

/** The `args` the plan's first step would send to the daemon. */
function actionArgs(plan: ReturnType<typeof buildCliPlan>): Record<string, unknown> {
  if (plan.kind !== "execute") return {};
  const params = plan.steps[0]?.params;
  if (typeof params !== "object" || params == null) return {};
  const call = (params as { arguments?: { args?: Record<string, unknown> } }).arguments;
  return call?.args ?? {};
}

describe("browser positional grammar", () => {
  it.each(SUBCOMMANDS)("dispatches $sub in every argv shape", ({ sub, label }) => {
    for (const shape of SHAPES(sub)) {
      const argv = ["browser", ...shape];
      let plan: ReturnType<typeof buildCliPlan>;
      try {
        plan = buildCliPlan(argv);
      } catch (error) {
        // A missing value is fine; naming a positional as the unknown command
        // or as a flag's value is the dispatch bug this guards.
        const message = (error as Error).message;
        expect(message, argv.join(" ")).not.toMatch(/t1/);
        expect(message, argv.join(" ")).not.toMatch(
          new RegExp(`Unknown browser \\w+ command: ${sub}$`),
        );
        continue;
      }
      expect(plan.kind === "execute" ? plan.label : plan.kind, argv.join(" ")).toContain(label);
      const args = actionArgs(plan);
      // The tab id may be ignored (`dev-servers` has no tab) but it may never
      // land in another field, and the subcommand word is never an argument.
      const carried = Object.entries(args).filter(([, value]) => value === "t1" || value === sub);
      expect(carried.map(([name]) => name), argv.join(" ")).toEqual(
        shape.includes("t1") && args.tabId === "t1" ? ["tabId"] : [],
      );
    }
  });

  it("keeps a fenced literal out of the flag it follows", () => {
    const labelOf = (argv: string[]): string => {
      const plan = buildCliPlan(argv);
      return plan.kind === "execute" ? plan.label : plan.kind;
    };
    expect(labelOf(["browser", "--tab-id", "t1", "close"])).toBe("browser close");
    expect(labelOf(["browser", "session", "--tab-id", "t1", "end", "s1"])).toBe(
      "browser session end",
    );
    expect(actionArgs(buildCliPlan(["browser", "session", "--tab-id", "t1", "end", "s1"])))
      .toMatchObject({ sessionId: "s1", tabId: "t1" });
    expect(labelOf(["browser", "--", "open", "https://x.test"])).toBe("browser open");
    expect(actionArgs(buildCliPlan(["browser", "fill", "--selector", "--", "--value", "y"])))
      .toMatchObject({ selector: "--", text: "y" });
    expect(actionArgs(buildCliPlan(["browser", "emulate", "--", "--iphone"])))
      .toMatchObject({ preset: "--iphone" });
  });

  it("keeps a leftover flag name out of the free-text handoff reason", () => {
    // `--text` survives `parseCliArgs` when a word follows it, so the reason
    // fallback must not join it — it is quoted back at the human in the phone
    // alert body and the progress notice.
    expect(actionArgs(buildCliPlan(["browser", "handoff", "--text", "sign in"])))
      .toMatchObject({ reason: "sign in" });
  });

  it("lets --help win over a value flag that would otherwise eat it", () => {
    // `readValue` accepts a flag-shaped value, so the help scan — not the
    // reader — is what stops `--help` from becoming a URL. `--flag=--help` and
    // a `--help` past the terminator are the two ways to pass the literal.
    expect(buildCliPlan(["browser", "open", "--url", "--help"]).kind).toBe("help");
    expect(buildCliPlan(["lanes", "list", "--text", "--help"]).kind).toBe("help");
  });
});
