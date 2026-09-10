import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSER_VALUE_FLAGS, VALUE_CARRIER_FLAGS, buildCliPlan } from "./cli";

const SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"),
  "utf8",
);

/**
 * The end of a regex literal starting at `index`, or 0 when that `/` is
 * division. Needed because `\`'${value.replace(/'/g, …)}'\`` puts an
 * apostrophe inside a regex inside a template hole: read as a string opener it
 * swallowed 4000 lines of cli.ts, and every reader call in them vanished from
 * the scan. A `/` starts a regex only where a value cannot precede it.
 */
function regexLiteralEnd(source: string, index: number): number {
  const before = source.slice(0, index).replace(/\s+$/, "");
  const prev = before.at(-1) ?? "";
  if (prev !== "" && !"(,=:[!&|?{};+-*%^~<>".includes(prev) && !/\breturn$/.test(before)) return 0;
  let inClass = false;
  for (let i = index + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") i += 1;
    else if (char === "\n") return 0;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = i + 1;
      while (/[a-z]/.test(source[end] ?? "")) end += 1;
      return end;
    }
  }
  return 0;
}

/**
 * Source spans a brace scan must not count: comments, quoted strings and
 * template literals (including their `${…}` holes). Without this a `{` inside
 * a string unbalanced the scan, and the old `indexOf("\n}")` fallback hid it —
 * could-not-parse read as parsed-clean.
 */
function skipNonCode(source: string, index: number): number {
  const char = source[index];
  const next = source[index + 1];
  if (char === "/" && next === "/") {
    const end = source.indexOf("\n", index);
    return end < 0 ? source.length : end;
  }
  if (char === "/" && next === "*") {
    const end = source.indexOf("*/", index + 2);
    if (end < 0) throw new Error("unterminated block comment in cli.ts");
    return end + 2;
  }
  if (char === "/" && regexLiteralEnd(source, index) > 0) return regexLiteralEnd(source, index);
  if (char === '"' || char === "'") {
    for (let i = index + 1; i < source.length; i += 1) {
      if (source[i] === "\\") i += 1;
      else if (source[i] === char) return i + 1;
      else if (source[i] === "\n") break;
    }
    throw new Error("unterminated string in cli.ts");
  }
  if (char === "`") {
    for (let i = index + 1; i < source.length; i += 1) {
      if (source[i] === "\\") i += 1;
      else if (source[i] === "`") return i + 1;
      else if (source[i] === "$" && source[i + 1] === "{") {
        let depth = 1;
        let cursor = i + 2;
        while (cursor < source.length && depth > 0) {
          const skipped = skipNonCode(source, cursor);
          if (skipped > 0) {
            cursor = skipped;
            continue;
          }
          if (source[cursor] === "{") depth += 1;
          else if (source[cursor] === "}") depth -= 1;
          cursor += 1;
        }
        i = cursor - 1;
      }
    }
    throw new Error("unterminated template literal in cli.ts");
  }
  return 0;
}

/**
 * The body of a top-level `function <name>(…) { … }`, braces balanced.
 *
 * Two things are NOT the body brace and both used to be taken as one, each
 * yielding an EMPTY body that every scan below then read as "calls nothing":
 * a default parameter (`base: JsonObject = {}`) and a return-type annotation
 * (`): { key: string; value: string } {`, which is how `parseAssignment` and
 * seven more went unscanned). So: skip the parameter list by paren depth, then
 * take the first `{` at depth 0 whose matching `}` sits in column 0 and is not
 * itself followed by another `{` — a return-type object closes as `} {`, a
 * generic `<{…}>` closes mid-line, and a top-level function body closes in
 * column 0 and ends there. A body that cannot be bounded that way THROWS; it
 * must never read as an empty-but-parsed body.
 */
function functionBody(name: string): string {
  const match = new RegExp(`\\nfunction ${name}\\b`).exec(SOURCE);
  if (!match) throw new Error(`no function ${name} in cli.ts`);
  let cursor = SOURCE.indexOf("(", match.index);
  for (let parens = 0; cursor < SOURCE.length; cursor += 1) {
    if (SOURCE[cursor] === "(") parens += 1;
    else if (SOURCE[cursor] === ")" && (parens -= 1) === 0) break;
  }
  for (let start = cursor + 1; start < SOURCE.length; start += 1) {
    const skipped = skipNonCode(SOURCE, start);
    if (skipped > 0) {
      start = skipped - 1;
      continue;
    }
    if (SOURCE[start] !== "{") continue;
    let depth = 0;
    let end = -1;
    for (let i = start; i < SOURCE.length; i += 1) {
      const inner = skipNonCode(SOURCE, i);
      if (inner > 0) {
        i = inner - 1;
        continue;
      }
      if (SOURCE[i] === "{") depth += 1;
      else if (SOURCE[i] === "}" && (depth -= 1) === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error(`unbalanced ${name} in cli.ts`);
    const after = /\S/.exec(SOURCE.slice(end + 1))?.[0];
    if (SOURCE[end - 1] === "\n" && after !== "{") return SOURCE.slice(start, end);
    start = end;
  }
  throw new Error(`no body brace for ${name} in cli.ts`);
}

function flagsReadFor(pattern: RegExp, source: string): Set<string> {
  const flags = new Set<string>();
  for (const call of source.matchAll(pattern))
    for (const flag of call[1]!.matchAll(/"(--?[^"]+)"/g)) flags.add(flag[1]!);
  return flags;
}

/**
 * `source` with comments — and, when `strings` is true, the bodies of quoted
 * strings and template literals — blanked out. Offsets are preserved, so an
 * index into the mask indexes the same character of the original: depth
 * counting runs over the mask and slices come from the source, and neither a
 * paren inside a string nor one inside a comment can shift a bracket depth.
 */
function maskSource(source: string, options: { strings: boolean }): string {
  const out = source.split("");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const isComment = char === "/" && (source[i + 1] === "/" || source[i + 1] === "*");
    const end = skipNonCode(source, i);
    if (end <= 0) continue;
    // A literal is always consumed — a `//` inside one is not a comment — but
    // only blanked when asked, since flag names live in string literals.
    if (isComment || options.strings)
      for (let j = i; j < end && j < source.length; j += 1) if (out[j] !== "\n") out[j] = " ";
    i = end - 1;
  }
  return out.join("");
}

/** cli.ts with comments gone (string literals kept) and fully masked. */
const CODE_SOURCE = maskSource(SOURCE, { strings: false });
const MASKED_SOURCE = maskSource(SOURCE, { strings: true });

/** The index of the bracket closing the one at `open`, or null if unbalanced. */
function matchingBracket(masked: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const char = masked[i]!;
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char) && (depth -= 1) === 0) return i;
  }
  return null;
}

/**
 * Where a value-reading call starts. The argument text is then taken by
 * balanced parens rather than by a regex: the old pattern allowed exactly one
 * level of nesting, so `readValue(args, ["--zz"], normalize(String(x)))`
 * matched NOTHING — the call vanished from the scan, its flag never had to
 * appear in `BROWSER_VALUE_FLAGS`, and every check below stayed green. The
 * count pin in the first test keeps that failure loud if it ever regresses.
 */
const VALUE_READER_OPEN =
  /\bread(?:Value|NumberOption|IntOption|RepeatedValues|CommandTextValue)\s*\(/g;

/** Split a call's argument text on the commas that sit at bracket depth 0. */
function topLevelArgs(text: string): string[] {
  const masked = maskSource(text, { strings: true });
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i]!;
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start));
  return args.map((arg) => arg.trim());
}

/**
 * The flag names a reader's flag argument denotes, or `null` when the scan
 * cannot see them. A literal (`"--foo"` / `["--foo", "--bar"]`) resolves
 * directly; a bare identifier or a spread resolves through a TOP-LEVEL
 * `const NAME = [...]` of string literals in cli.ts — top-level and
 * comment-stripped, because a scan-everything match resolved a commented-out
 * or function-local declaration of the same name and took the first hit. Two
 * top-level declarations of one name, and anything else — a computed list, a
 * parameter, a call — are unreadable, and a browser flag added that way would
 * need no entry in `BROWSER_VALUE_FLAGS` with every scan below still green, so
 * it must fail loudly instead.
 */
function resolveFlagList(arg: string): string[] | null {
  const text = arg.trim();
  if (/^"(--?[^"]+)"$/.test(text)) return [text.slice(1, -1)];
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const name = text.replace(/\$/g, "\\$");
    const decls = [
      ...CODE_SOURCE.matchAll(new RegExp(`(?:^|\\n)(?:export )?const ${name}\\b[^=\\n]*=\\s*\\[`, "g")),
    ];
    if (decls.length !== 1) return null;
    const open = decls[0]!.index + decls[0]![0].length - 1;
    const close = matchingBracket(MASKED_SOURCE, open);
    // Sliced from the comment-stripped source: a `// …` line between two
    // elements is not an element.
    return close == null ? null : resolveFlagList(CODE_SOURCE.slice(open, close + 1));
  }
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const flags: string[] = [];
  for (const element of topLevelArgs(text.slice(1, -1))) {
    if (element === "") continue;
    const resolved = resolveFlagList(element.startsWith("...") ? element.slice(3) : element);
    if (!resolved) return null;
    flags.push(...resolved);
  }
  return flags;
}

/** Every value-reader call in `source`, paired with its resolved flag names. */
function valueReaderCalls(source: string): { call: string; flags: string[] | null }[] {
  const masked = maskSource(source, { strings: true });
  const calls: { call: string; flags: string[] | null }[] = [];
  for (const match of masked.matchAll(VALUE_READER_OPEN)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(masked, open);
    if (close == null)
      throw new Error(`unbalanced reader call: ${source.slice(match.index, match.index + 60)}`);
    const args = topLevelArgs(source.slice(open + 1, close));
    calls.push({
      call: source.slice(match.index, close + 1),
      flags: args.length < 2 ? null : resolveFlagList(args[1]!),
    });
  }
  return calls;
}

const TOP_LEVEL_FUNCTIONS = new Set(
  [...SOURCE.matchAll(/\nfunction (\w+)\b/g)].map((m) => m[1]!),
);

/**
 * The primitives that actually consume argv. They are where the scan reads its
 * flag names, so they are the leaves of the call graph, never expanded.
 */
const ARGV_PRIMITIVES = [
  "readValue",
  "readFlag",
  "readNumberOption",
  "readIntOption",
  "readRepeatedValues",
  // These two splice argv themselves instead of delegating to one of the five
  // above, so a transitive closure over those alone classified neither as a
  // reader — a future `readCommandTextValue(args, ["--foo"])` in the browser
  // plan would have needed no entry in the browser table and nothing would
  // have failed.
  "readCommandTextValue",
  "firstPositional",
];

const BODY_BY_NAME = new Map<string, string>();
function bodyOf(name: string): string {
  const cached = BODY_BY_NAME.get(name);
  if (cached != null) return cached;
  const body = functionBody(name);
  BODY_BY_NAME.set(name, body);
  return body;
}

/** Every top-level function a body calls. */
function calleesIn(source: string): string[] {
  return [...new Set([...source.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]!))].filter((name) =>
    TOP_LEVEL_FUNCTIONS.has(name),
  );
}

/**
 * Every top-level helper that consumes argv, found by BODY rather than by
 * name. A `read[A-Z]` name pattern was the same hand-kept subset one more
 * time: `collectGenericObjectArgs` reads `--arg-json` & co. and is called
 * straight out of the browser plan, but matched no pattern, so its flags never
 * had to be in the browser table.
 */
const ARGV_READERS = (() => {
  const readers = new Set<string>(ARGV_PRIMITIVES);
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of TOP_LEVEL_FUNCTIONS) {
      if (readers.has(name)) continue;
      if (!calleesIn(bodyOf(name)).some((callee) => readers.has(callee))) continue;
      readers.add(name);
      changed = true;
    }
  }
  for (const primitive of ARGV_PRIMITIVES) readers.delete(primitive);
  return readers;
})();

/** Argv-reading helpers a body calls, minus the primitives themselves. */
function readerCallsIn(source: string): string[] {
  return calleesIn(source)
    .filter((name) => ARGV_READERS.has(name))
    .sort();
}

// A hand-listed set of function names is the same hand-kept subset the table
// itself failed as: `readProofOwnerBase` reads `--owner-kind|--owner|--owner-id`
// and is called from `browser record stop` and `browser proof`, but matched no
// name pattern, so `browser --owner-id o1 proof` dispatched on "o1" with the
// coverage test green. The region now follows the call graph instead.
const PLAN_ENTRY_POINTS = [
  "buildBrowserPlan",
  "buildBrowserPlanWithLiteralTail",
  "buildBrowserHandoffPlan",
  "readToolClaimArgs",
  ...[...SOURCE.matchAll(/\nfunction (readBrowser\w+)\b/g)].map((m) => m[1]!),
];

const PLAN_FUNCTIONS = (() => {
  const names = [...PLAN_ENTRY_POINTS];
  for (const name of readerCallsIn(PLAN_ENTRY_POINTS.map(functionBody).join("\n")))
    if (!names.includes(name)) names.push(name);
  return names;
})();

const PLAN_SOURCE = PLAN_FUNCTIONS.map(functionBody).join("\n");

/** Every carrier-aware positional read the browser plan makes today. */
const CARRIER_AWARE_CALL_SITES = 5;

/** Every `hasHelpFlag` call in the top-level dispatcher. */
const BUILD_CLI_PLAN_HELP_CALL_SITES = 2;

/**
 * Every top-level helper whose body reaches an argv primitive. Was 97 while
 * `shellEscapeToken`'s `/'/` regex read as a string opener and its "body"
 * ran 58 lines past its closing brace into argv-reading neighbours; that pure escaper reads no argv.
 */
const ARGV_READER_COUNT = 96;

describe("browser value flags", () => {
  it("reads a real body for every top-level function in cli.ts", () => {
    // The scans below are only as good as the bodies they read, and an
    // unparsed body reads exactly like a body that calls nothing. These eight
    // are the ones a return-type annotation (`): { key: string } {`) truncated
    // to nothing; `parseDraftInput` is the one a `"{"` string literal
    // unbalanced.
    const previouslyEmpty = [
      "parseAssignment",
      "proofCallerRoot",
      "resolveLinearWriteCommand",
      "parseActionRunTarget",
      "maybeRunBuiltCliFallback",
      "runLocalCommand",
      "withRpcAuthTokenGate",
      "applySyncWebPairingFlags",
      "parseDraftInput",
      "collectGenericObjectArgs",
    ];
    expect(previouslyEmpty.filter((name) => !TOP_LEVEL_FUNCTIONS.has(name))).toEqual([]);
    expect(
      previouslyEmpty.filter((name) => bodyOf(name).split("\n").length < 3),
    ).toEqual([]);
    expect(
      [...TOP_LEVEL_FUNCTIONS].filter((name) => bodyOf(name).trim().length <= 1),
    ).toEqual([]);
    // A drop here means bodies stopped parsing and the coverage scans below
    // went quietly blind; a rise means a new argv reader exists.
    expect(
      ARGV_READERS.size,
      "bodies stopped parsing (drop) or a new argv reader exists (rise): the flag-coverage scans below only see what these bodies contain",
    ).toBe(ARGV_READER_COUNT);
  });

  it("keeps the argv-splicing primitives out of the browser plan", () => {
    // `readCommandTextValue` and `firstPositional` splice argv directly. They
    // are primitives now, so if the plan ever calls one the coverage scan
    // above demands its flags be in `BROWSER_VALUE_FLAGS` — and
    // `firstPositional`, which reads a positional with no carrier table at
    // all, must not appear in a browser grammar that has one.
    expect(
      calleesIn(PLAN_SOURCE).filter((name) =>
        ["readCommandTextValue", "firstPositional"].includes(name),
      ),
    ).toEqual([]);
  });

  it("passes the browser carrier table to the dispatcher's help scan", () => {
    // `hasHelpFlag` is a sixth carrier-aware argv scanner, and it is called
    // from `buildCliPlan` — which no scan over `PLAN_SOURCE` can see. Without
    // this a future browser-family `hasHelpFlag(args)` reverts the fix
    // silently, exactly the default-parameter drift the browser table hit.
    const dispatch = functionBody("buildCliPlan");
    expect(dispatch).toMatch(
      /primaryHelpKey === "browser"\s*\?\s*BROWSER_VALUE_CARRIER_FLAGS/,
    );
    const calls = [...dispatch.matchAll(/\bhasHelpFlag\(((?:[^()]|\([^()]*\))*)\)/g)];
    expect(
      calls.length,
      "buildCliPlan gained or lost a hasHelpFlag call site: a new one must pass helpCarriers or `browser --tab-id t1 --help` narrows back to the global carrier set",
    ).toBe(BUILD_CLI_PLAN_HELP_CALL_SITES);
    expect(
      calls.filter(([, callArgs]) => !callArgs!.includes("helpCarriers")).map(([call]) => call),
    ).toEqual([]);
  });

  it("pulls the argv readers the plan calls into the scanned region", () => {
    expect(PLAN_FUNCTIONS).toContain("readProofOwnerBase");
    // One level is the whole graph: nothing the pulled-in readers call reads
    // argv in turn. If that stops being true this fails instead of quietly
    // scanning less than the plan consumes.
    expect(readerCallsIn(PLAN_SOURCE).filter((name) => !PLAN_FUNCTIONS.includes(name))).toEqual(
      [],
    );
  });

  it("matches every reader call in cli.ts at any nesting depth", () => {
    // The argument text is taken by balanced parens, not by a regex with a
    // fixed nesting budget: the previous pattern allowed one level, so
    // `readValue(args, ["--zz"], normalize(String(x)))` matched nothing and its
    // flag silently escaped every check below. The pin is derived, not a magic
    // number — a call the tokenizer stops seeing fails here loudly.
    const occurrences = [...MASKED_SOURCE.matchAll(VALUE_READER_OPEN)].length;
    expect(occurrences).toBeGreaterThan(500);
    expect(
      valueReaderCalls(SOURCE).length,
      "the reader-call tokenizer dropped calls that `readValue(`-style occurrences still find in cli.ts: a call it cannot see needs no BROWSER_VALUE_FLAGS entry and every scan below stays green",
    ).toBe(occurrences);
    const deep = valueReaderCalls('readValue(args, ["--zz"], normalize(String(x)))');
    expect(deep.map(({ flags }) => flags)).toEqual([["--zz"]]);
  });

  it("reads every value-flag argument the browser plan passes", () => {
    // A flag list the scan cannot read is a flag list that needs no table
    // entry: `const names = ["--zzz"]; readValue(args, names)` in the plan
    // leaves the coverage scan below with an empty diff and every pin intact.
    // `resolveFlagList` follows a same-file `const NAME = [...]` of string
    // literals; anything it still cannot see must not exist in this region.
    // "Nothing unreadable" is only meaningful if the scan can read and refuse:
    // a top-level const resolves; an unknown name, a spread of one, and a
    // function-local const of the same name in another scope do not.
    expect(valueReaderCalls("readValue(args, BROWSER_VALUE_FLAGS)")[0]!.flags).toContain(
      "--tab-id",
    );
    expect(valueReaderCalls("readValue(args, idFlags)")[0]!.flags).toBeNull();
    expect(valueReaderCalls("readValue(args, zzNames)")[0]!.flags).toBeNull();
    expect(valueReaderCalls("readValue(args, [...zzMore])")[0]!.flags).toBeNull();
    expect(
      valueReaderCalls(PLAN_SOURCE)
        .filter(({ flags }) => flags == null)
        .map(({ call }) => call),
    ).toEqual([]);
  });

  it("covers every flag the browser plan reads a value for", () => {
    // `readRepeatedValues` is in the scan too: it consumes exactly like
    // `readValue`, so `--upload` carries a value and must be in the table or
    // `browser --upload path upload` dispatches on "path".
    const read = new Set(valueReaderCalls(PLAN_SOURCE).flatMap(({ flags }) => flags ?? []));
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
        // One level of nesting is matched, so a future
        // `firstStandalonePositional(readBrowserArgs(args))` is still scanned
        // rather than skipped — the floor below is the real count, not a
        // number a skipped call site could still clear.
        /\b(firstStandalonePositional|standalonePositionals|firstTerminatorIndex|takeArgsAfterTerminator|hasHelpFlag)\(((?:[^()]|\([^()]*\))*)\)/g,
      ),
    ];
    expect(
      calls.length,
      "the browser plan gained or lost a carrier-aware positional read: a dropped call site makes the table check below vacuous, a new one must pass BROWSER_VALUE_CARRIER_FLAGS",
    ).toBe(CARRIER_AWARE_CALL_SITES);
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
  // `collectGenericObjectArgs` carries a value too, and it is called from the
  // browser plan: without it in the table the JSON was the subcommand.
  ["--arg-json", "{}", sub],
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

  it("keeps a carrier's literal `--` from fencing --help out of the scan", () => {
    // `--upload` carries a value, so the `--` after it is that value, not a
    // terminator. Scanning with the global table stopped there and `--help`
    // was never seen — the upload ran instead of printing help.
    expect(
      buildCliPlan(["browser", "upload", "--selector", "input", "--upload", "--", "--help"]).kind,
    ).toBe("help");
    // A real terminator still fences the literal string through.
    expect(actionArgs(buildCliPlan(["browser", "open", "--", "--help"])))
      .toMatchObject({ url: "--help" });
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

  it("refuses a flag-shaped leftover instead of guessing at the handoff reason", () => {
    // Both repairs were worse than the refusal: joining the token quoted
    // "--text sign in" back at the human in the alert body, and dropping it
    // ate the next word when the name was a carrier (`--path sign in` → "in").
    for (const argv of [
      ["browser", "handoff", "--text", "sign in"],
      ["browser", "handoff", "---x", "sign", "in"],
      ["browser", "handoff", "--path", "sign", "in"],
      ["browser", "handoff", "--foo", "bar", "sign", "in"],
      ["browser", "handoff", "--url=x.test", "sign", "in"],
    ]) {
      expect(() => buildCliPlan(argv)).toThrow(/--reason/);
    }
  });

  it("keeps the two spellings that never needed guessing", () => {
    expect(actionArgs(buildCliPlan(["browser", "handoff", "--reason", "sign in"])))
      .toMatchObject({ reason: "sign in" });
    expect(actionArgs(buildCliPlan(["browser", "handoff", "sign", "in", "to", "staging"])))
      .toMatchObject({ reason: "sign in to staging" });
    // A literal tail is the person's own words, not argv: dashes survive it.
    expect(actionArgs(buildCliPlan(["browser", "handoff", "--", "-2fa", "prompt"])))
      .toMatchObject({ reason: "-2fa prompt" });
    expect(actionArgs(buildCliPlan(["browser", "handoff", "--", "fix", "the", "-2fa", "prompt"])))
      .toMatchObject({ reason: "fix the -2fa prompt" });
  });

  it("dispatches past a proof owner flag", () => {
    // `readProofOwnerBase` reads these, so they must carry their value here
    // too or the subcommand is read out of the flag's value.
    const labelOf = (argv: string[]): string => {
      const plan = buildCliPlan(argv);
      return plan.kind === "execute" ? plan.label : plan.kind;
    };
    expect(labelOf(["browser", "--owner-id", "o1", "proof"])).toBe("browser proof");
    expect(labelOf(["browser", "--owner-kind", "lane", "proof"])).toBe("browser proof");
    expect(labelOf(["browser", "--owner", "lane", "record", "stop"])).toBe("browser record stop");
  });

  it("lets --help win over a value flag that would otherwise eat it", () => {
    // `readValue` accepts a flag-shaped value, so the help scan — not the
    // reader — is what stops `--help` from becoming a URL. `--flag=--help` and
    // a `--help` past the terminator are the two ways to pass the literal.
    expect(buildCliPlan(["browser", "open", "--url", "--help"]).kind).toBe("help");
    expect(buildCliPlan(["lanes", "list", "--text", "--help"]).kind).toBe("help");
  });
});
