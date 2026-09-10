import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { BROWSER_VALUE_FLAGS, VALUE_CARRIER_FLAGS, buildCliPlan } from "./cli";

const SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts"),
  "utf8",
);

/**
 * The scans below used to run on a hand-rolled lexer: a previous-character
 * whitelist decided regex-vs-division, a brace counter found function bodies,
 * and a mask blanked whole template literals — holes included, so a reader
 * inside `${…}` vanished from every check. cli.ts is TypeScript, and the
 * compiler that already builds it is a devDependency, so the grammar is read
 * from a real parse instead: one `ts.createSourceFile`, then AST walks. Regex
 * survives only where the assertion is genuinely about text.
 */
function parseSource(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const FILE = parseSource("cli.ts", SOURCE);

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function collect<T extends ts.Node>(
  roots: readonly ts.Node[],
  match: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  for (const root of roots) walk(root, (node) => { if (match(node)) found.push(node); });
  return found;
}

/* ── binding resolution ──────────────────────────────────────────────────── */

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements)
    if (ts.isBindingElement(element)) bindingNames(element.name, out);
}

/** True for the nodes that introduce a lexical scope. */
function isScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isFunctionLike(node)
  );
}

const DECLARED_NAMES = new WeakMap<ts.Node, Set<string>>();

/** The names a scope node binds directly — parameters, locals, imports. */
function declaredNames(scope: ts.Node): Set<string> {
  const cached = DECLARED_NAMES.get(scope);
  if (cached) return cached;
  const names = new Set<string>();
  const addList = (list: ts.VariableDeclarationList): void => {
    for (const declaration of list.declarations) bindingNames(declaration.name, names);
  };
  const addStatements = (statements: ts.NodeArray<ts.Statement>): void => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) addList(statement.declarationList);
      else if (ts.isFunctionDeclaration(statement) && statement.name) names.add(statement.name.text);
      else if (ts.isClassDeclaration(statement) && statement.name) names.add(statement.name.text);
      else if (ts.isEnumDeclaration(statement)) names.add(statement.name.text);
      else if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name) names.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
        else if (bindings && ts.isNamedImports(bindings))
          for (const element of bindings.elements) names.add(element.name.text);
      }
    }
  };
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope))
    addStatements(scope.statements);
  else if (ts.isCaseBlock(scope))
    for (const clause of scope.clauses) addStatements(clause.statements);
  else if (ts.isCatchClause(scope)) {
    if (scope.variableDeclaration) bindingNames(scope.variableDeclaration.name, names);
  } else if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const initializer = scope.initializer;
    if (initializer && ts.isVariableDeclarationList(initializer)) addList(initializer);
  }
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) bindingNames(parameter.name, names);
    const own = (scope as ts.FunctionDeclaration).name;
    if (own && ts.isIdentifier(own)) names.add(own.text);
  }
  DECLARED_NAMES.set(scope, names);
  return names;
}

/** Every top-level declaration in cli.ts, by the name it binds. */
const TOP_LEVEL_BINDINGS = (() => {
  const bindings = new Map<string, ts.Node[]>();
  const add = (name: string, node: ts.Node): void => {
    const list = bindings.get(name);
    if (list) list.push(node);
    else bindings.set(name, [node]);
  };
  for (const statement of FILE.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const names = new Set<string>();
        bindingNames(declaration.name, names);
        for (const name of names) add(name, declaration);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name)
      add(statement.name.text, statement);
    else if (ts.isClassDeclaration(statement) && statement.name) add(statement.name.text, statement);
  }
  return bindings;
})();

/**
 * The scope node that binds `name` for a use at `node`, or `undefined` when
 * nothing in the chain binds it. Innermost wins: a parameter or a local list
 * shadows the top-level constant of the same name, and the shadowed use must
 * not be attributed to that constant.
 */
function bindingScopeOf(node: ts.Node, name: string): ts.Node | undefined {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent)
    if (isScope(scope) && declaredNames(scope).has(name)) return scope;
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return unwrap(node.expression);
  if (ts.isSatisfiesExpression(node)) return unwrap(node.expression);
  return node;
}

/**
 * The flag names an expression denotes, or `null` when the scan cannot prove
 * them. A string literal (`"--foo"`) and an array of them resolve directly; an
 * identifier resolves ONLY when its innermost binding is cli.ts's own
 * top-level `const NAME = [ … ]` of flag literals and spreads of such. A
 * parameter, a function-local list, a name declared twice at top level, a
 * computed list and a call all fail closed — a browser flag introduced that
 * way would otherwise need no `BROWSER_VALUE_FLAGS` entry with every scan
 * below still green.
 */
function resolveFlagList(expression: ts.Expression, seen = new Set<string>()): string[] | null {
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) return /^--?\S+$/.test(node.text) ? [node.text] : null;
  if (ts.isSpreadElement(node)) return resolveFlagList(node.expression, seen);
  if (ts.isArrayLiteralExpression(node)) {
    const flags: string[] = [];
    for (const element of node.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const resolved = resolveFlagList(element, seen);
      if (!resolved) return null;
      flags.push(...resolved);
    }
    return flags;
  }
  if (!ts.isIdentifier(node)) return null;
  const name = node.text;
  if (seen.has(name)) return null;
  const scope = bindingScopeOf(node, name);
  // Bound anywhere other than cli.ts's own top level: shadowed, so unreadable.
  if (scope && scope !== FILE) return null;
  const declarations = TOP_LEVEL_BINDINGS.get(name);
  if (!declarations || declarations.length !== 1) return null;
  const declaration = declarations[0]!;
  if (!ts.isVariableDeclaration(declaration)) return null;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  if (!declaration.initializer) return null;
  const initializer = unwrap(declaration.initializer);
  if (!ts.isArrayLiteralExpression(initializer)) return null;
  return resolveFlagList(initializer, new Set([...seen, name]));
}

/* ── the call graph ──────────────────────────────────────────────────────── */

/** The name a call expression invokes, for bare and member calls alike. */
function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** Bare-identifier calls only: `obj.parseAssignment()` is not our function. */
function directCalleeName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

const TOP_LEVEL_FUNCTION_NODES = new Map<string, ts.FunctionDeclaration>();
for (const statement of FILE.statements)
  if (ts.isFunctionDeclaration(statement) && statement.name)
    TOP_LEVEL_FUNCTION_NODES.set(statement.name.text, statement);

const TOP_LEVEL_FUNCTIONS = new Set(TOP_LEVEL_FUNCTION_NODES.keys());

/**
 * The body block of a top-level `function <name>`. The parser draws the
 * boundary, so a default parameter (`base: JsonObject = {}`), a return-type
 * annotation (`): { key: string } {`) and a `"{"` inside a string literal are
 * no longer three ways to mistake an empty body for a parsed one. A function
 * with no body at all throws rather than reading as "calls nothing".
 */
function bodyNode(name: string): ts.Block {
  const declaration = TOP_LEVEL_FUNCTION_NODES.get(name);
  if (!declaration) throw new Error(`no function ${name} in cli.ts`);
  if (!declaration.body) throw new Error(`function ${name} in cli.ts has no body`);
  return declaration.body;
}

function functionBody(name: string): string {
  return bodyNode(name).getText(FILE);
}

const bodyOf = functionBody;

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

/** Every top-level function the given subtrees call. */
function calleesIn(roots: readonly ts.Node[]): string[] {
  const names = new Set<string>();
  for (const call of collect(roots, ts.isCallExpression)) {
    const name = directCalleeName(call);
    if (name != null && TOP_LEVEL_FUNCTIONS.has(name)) names.add(name);
  }
  return [...names];
}

/**
 * Every top-level helper that consumes argv, found by BODY rather than by
 * name. A `read[A-Z]` name pattern was the same hand-kept subset one more
 * time: `collectGenericObjectArgs` reads `--arg-json` & co. and is called
 * straight out of the browser plan, but matched no pattern, so its flags never
 * had to be in the browser table.
 */
const ARGV_READERS = (() => {
  const callees = new Map<string, string[]>();
  for (const name of TOP_LEVEL_FUNCTIONS) callees.set(name, calleesIn([bodyNode(name)]));
  const readers = new Set<string>(ARGV_PRIMITIVES);
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of TOP_LEVEL_FUNCTIONS) {
      if (readers.has(name)) continue;
      if (!callees.get(name)!.some((callee) => readers.has(callee))) continue;
      readers.add(name);
      changed = true;
    }
  }
  for (const primitive of ARGV_PRIMITIVES) readers.delete(primitive);
  return readers;
})();

/**
 * Every callable in cli.ts that the call graph cannot index AND that reaches
 * argv.
 *
 * The graph follows top-level `function <name>` declarations only, so a reader
 * written any other way never enters PLAN_FUNCTIONS: the flags it reads need
 * no `BROWSER_VALUE_FLAGS` entry and every coverage scan in this file stays
 * green while the grammar drifts. `const readFoo = (args) => …` is only the
 * first of those ways — an object-literal method or getter, a class method,
 * property arrow or accessor, a class expression bound to a const, and an
 * arrow handed to a wrapper such as `memoize(…)` are all equally unreachable.
 *
 * So the rule is one property, not a list of shapes. `ts.isFunctionLike` finds
 * every callable that is not itself a top-level function declaration, and the
 * scan refuses the ones whose body reaches argv. Refusing by shape instead
 * would do both jobs badly: it would miss the shapes nobody enumerated (a
 * wrapper call is not an arrow), and it would refuse a harmless top-level
 * `const compare = (a, b) => …` that reads no flag at all.
 *
 * A callable nested inside a top-level `function` IS indexed — the graph reads
 * that function's whole body — so those statements are skipped outright.
 *
 * The reader names come from cli.ts's own graph, not from `file`. `file`
 * supplies the callables; a synthetic snippet must therefore spell cli.ts's
 * own primitive or reader names to be seen.
 */
function unindexableArgvReaders(file: ts.SourceFile): string[] {
  const touchesArgv = (body: ts.Node): boolean =>
    collect([body], ts.isCallExpression).some((call) => {
      const name = calleeName(call);
      return name != null && (ARGV_PRIMITIVES.includes(name) || ARGV_READERS.has(name));
    });
  /** `Owner.member` where the ancestors are named, else `<anonymous>`. */
  const label = (node: ts.Node): string => {
    const parts: string[] = [];
    for (let scope: ts.Node | undefined = node; scope && !ts.isSourceFile(scope); scope = scope.parent) {
      const name = (scope as ts.NamedDeclaration).name;
      if (name) parts.unshift(name.getText(file));
      else if (ts.isConstructorDeclaration(scope)) parts.unshift("constructor");
    }
    return parts.join(".") || "<anonymous>";
  };
  const found: string[] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)) continue;
    walk(statement, (node) => {
      if (node === statement || !ts.isFunctionLike(node)) return;
      const body = (node as ts.FunctionLikeDeclaration).body;
      if (body && touchesArgv(body)) found.push(label(node));
    });
  }
  return found.sort();
}

/** Argv-reading helpers the given subtrees call, minus the primitives. */
function readerCallsIn(roots: readonly ts.Node[]): string[] {
  return calleesIn(roots)
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
  ...[...TOP_LEVEL_FUNCTIONS].filter((name) => /^readBrowser\w+$/.test(name)),
];

const PLAN_FUNCTIONS = (() => {
  const names = [...PLAN_ENTRY_POINTS];
  for (const name of readerCallsIn(PLAN_ENTRY_POINTS.map(bodyNode)))
    if (!names.includes(name)) names.push(name);
  return names;
})();

const PLAN_NODES = PLAN_FUNCTIONS.map(bodyNode);

/* ── the value-reader scan ───────────────────────────────────────────────── */

/**
 * The readers that consume a flag's value. Their second argument names the
 * flags, so every one of them in the browser plan must name flags the scan can
 * read and the browser table declares.
 */
const VALUE_READER_NAMES = [
  "readValue",
  "readNumberOption",
  "readIntOption",
  "readRepeatedValues",
  "readCommandTextValue",
];

/** Matches a reader call's opening text in RAW source — the AST sentinel's foil. */
const VALUE_READER_OPEN =
  /\bread(?:Value|NumberOption|IntOption|RepeatedValues|CommandTextValue)\s*\(/g;

function isValueReaderCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && VALUE_READER_NAMES.includes(calleeName(node) ?? "");
}

type ReaderCall = { call: string; flags: string[] | null };

function readerCallsFrom(roots: readonly ts.Node[], file: ts.SourceFile): ReaderCall[] {
  return collect(roots, isValueReaderCall).map((call) => ({
    call: call.getText(file),
    flags: call.arguments.length < 2 ? null : resolveFlagList(call.arguments[1]!),
  }));
}

/** Every value-reader call in the browser plan, paired with its flag names. */
function planValueReaderCalls(): ReaderCall[] {
  return readerCallsFrom(PLAN_NODES, FILE);
}

/**
 * Every value-reader call in a snippet. Parsed, not pattern-matched: a call
 * nested at any depth is found, and a call inside a `${…}` hole is found too —
 * the old masker blanked whole template literals, holes included, so a reader
 * written there was invisible to every check below.
 */
function valueReaderCalls(source: string): ReaderCall[] {
  const file = parseSource("snippet.ts", source);
  return readerCallsFrom([file], file);
}

/* ── AST-vs-raw sentinel ─────────────────────────────────────────────────── */

/** Literal spans the parser reports — quasis included, holes deliberately not. */
const LITERAL_RANGES = collect([FILE], (node): node is ts.Node =>
  ts.isStringLiteralLike(node) ||
  ts.isRegularExpressionLiteral(node) ||
  node.kind === ts.SyntaxKind.TemplateHead ||
  node.kind === ts.SyntaxKind.TemplateMiddle ||
  node.kind === ts.SyntaxKind.TemplateTail,
).map((node) => [node.getStart(FILE), node.getEnd()] as const);

/** True when `position` sits in a literal body or in comment/whitespace trivia. */
function insideLiteralOrComment(position: number): boolean {
  if (LITERAL_RANGES.some(([start, end]) => position >= start && position < end)) return true;
  let node: ts.Node = FILE;
  for (;;) {
    const child = node.forEachChild((candidate) =>
      candidate.pos <= position && position < candidate.end ? candidate : undefined,
    );
    if (!child) break;
    node = child;
  }
  return position < node.getStart(FILE);
}

/** Where the parser says each reader call's callee begins. */
const AST_READER_STARTS = new Set(
  collect([FILE], isValueReaderCall).map((call) =>
    ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.getStart(FILE)
      : call.expression.getStart(FILE),
  ),
);

/**
 * Where the parser says a reader is DECLARED. `function readValue(` reads like
 * a call to any regex, so the sentinel must account for those five names too
 * rather than let them stand in for a genuinely missed call.
 */
const AST_READER_DECLARATIONS = new Set(
  collect([FILE], ts.isIdentifier)
    .filter((identifier) => {
      if (!VALUE_READER_NAMES.includes(identifier.text)) return false;
      const parent = identifier.parent as { name?: ts.Node } | undefined;
      return (
        parent != null &&
        parent.name === identifier &&
        (ts.isFunctionDeclaration(identifier.parent) ||
          ts.isMethodDeclaration(identifier.parent) ||
          ts.isMethodSignature(identifier.parent) ||
          ts.isPropertyAssignment(identifier.parent) ||
          ts.isPropertySignature(identifier.parent) ||
          ts.isVariableDeclaration(identifier.parent))
      );
    })
    .map((identifier) => identifier.getStart(FILE)),
);

const RAW_READER_STARTS = [...SOURCE.matchAll(VALUE_READER_OPEN)].map((match) => match.index);

/** Every carrier-aware positional read the browser plan makes today. */
const CARRIER_AWARE_CALL_SITES = 5;

/** Every `hasHelpFlag` call in the top-level dispatcher. */
const BUILD_CLI_PLAN_HELP_CALL_SITES = 2;

/**
 * Every top-level helper whose body reaches an argv primitive. Was 96 while the
 * scan matched `\nfunction name` by regex and so saw no `async function` at
 * all: `runCli`, `runServe`, `main` and three more read argv and were invisible
 * to the whole graph. A drop means the parse stopped seeing bodies it used to
 * see; a rise means a new argv reader exists.
 */
const ARGV_READER_COUNT = 102;

/** The carrier-aware positional readers the browser table must reach. */
const CARRIER_AWARE_READERS = [
  "firstStandalonePositional",
  "standalonePositionals",
  "firstTerminatorIndex",
  "takeArgsAfterTerminator",
  "hasHelpFlag",
];

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

  it("refuses a callable that reaches argv but the call graph cannot index", () => {
    // The call graph reaches a helper only through its `function <name>`
    // declaration. `const readFoo = (args) => readValue(args, ["--foo"])` in
    // cli.ts is invisible to it, so `--foo` needs no `BROWSER_VALUE_FLAGS`
    // entry and every scan in this file stays green.
    expect(
      unindexableArgvReaders(FILE),
      "a callable in cli.ts reads argv but is not a top-level `function` declaration, so the call graph cannot index it and the flags it reads need no BROWSER_VALUE_FLAGS entry — write it as `function <name>(...)` at the top level instead",
    ).toEqual([]);
    // "None in cli.ts" only means something if the scan can find them. Every
    // shape below is a real way to bind a callable that the graph misses, and
    // `wrapped` is the one a shape-matching scan loses: a wrapper call is not
    // an arrow. The last two lines are the precision claim — a callback and a
    // helper that reads no flag must NOT be refused.
    const synthetic = parseSource(
      "synthetic.ts",
      [
        'const readAlpha = (args: string[]) => readValue(args, ["--alpha"]);',
        "const READERS = {",
        '  beta(args: string[]) { return readValue(args, ["--beta"]); },',
        '  gamma: (args: string[]) => readValue(args, ["--gamma"]),',
        '  get delta() { return readValue(process.argv, ["--delta"]); },',
        "};",
        'const wrapped = memoize((args: string[]) => readValue(args, ["--wrapped"]));',
        'const Klass = class { eps(args: string[]) { return readValue(args, ["--eps"]); } };',
        "class Decl {",
        '  zeta = (args: string[]) => readValue(args, ["--zeta"]);',
        '  get eta() { return readValue(process.argv, ["--eta"]); }',
        '  theta(args: string[]) { return readValue(args, ["--theta"]); }',
        "}",
        'const NAMES = ["--zz"].map((flag) => flag.slice(2));',
        "const compare = (a: string, b: string) => a.localeCompare(b);",
      ].join("\n"),
    );
    expect(unindexableArgvReaders(synthetic)).toEqual([
      "Decl.eta",
      "Decl.theta",
      "Decl.zeta",
      "Klass.eps",
      "READERS.beta",
      "READERS.delta",
      "READERS.gamma",
      "readAlpha",
      "wrapped",
    ]);
  });

  it("keeps the argv-splicing primitives out of the browser plan", () => {
    // `readCommandTextValue` and `firstPositional` splice argv directly. They
    // are primitives now, so if the plan ever calls one the coverage scan
    // above demands its flags be in `BROWSER_VALUE_FLAGS` — and
    // `firstPositional`, which reads a positional with no carrier table at
    // all, must not appear in a browser grammar that has one.
    expect(
      calleesIn(PLAN_NODES).filter((name) =>
        ["readCommandTextValue", "firstPositional"].includes(name),
      ),
    ).toEqual([]);
  });

  it("passes the browser carrier table to the dispatcher's help scan", () => {
    // `hasHelpFlag` is a sixth carrier-aware argv scanner, and it is called
    // from `buildCliPlan` — which no scan over the plan region can see. Without
    // this a future browser-family `hasHelpFlag(args)` reverts the fix
    // silently, exactly the default-parameter drift the browser table hit.
    const dispatch = functionBody("buildCliPlan");
    expect(dispatch).toMatch(
      /primaryHelpKey === "browser"\s*\?\s*BROWSER_VALUE_CARRIER_FLAGS/,
    );
    // Found by parse, so a call site nested inside another call or inside a
    // template hole counts like any other.
    const calls = collect([bodyNode("buildCliPlan")], ts.isCallExpression).filter(
      (call) => calleeName(call) === "hasHelpFlag",
    );
    expect(
      calls.length,
      "buildCliPlan gained or lost a hasHelpFlag call site: a new one must pass helpCarriers or `browser --tab-id t1 --help` narrows back to the global carrier set",
    ).toBe(BUILD_CLI_PLAN_HELP_CALL_SITES);
    expect(
      calls
        .filter((call) => !call.arguments.some((arg) => arg.getText(FILE).includes("helpCarriers")))
        .map((call) => call.getText(FILE)),
    ).toEqual([]);
  });

  it("pulls the argv readers the plan calls into the scanned region", () => {
    expect(PLAN_FUNCTIONS).toContain("readProofOwnerBase");
    // One level is the whole graph: nothing the pulled-in readers call reads
    // argv in turn. If that stops being true this fails instead of quietly
    // scanning less than the plan consumes.
    expect(readerCallsIn(PLAN_NODES).filter((name) => !PLAN_FUNCTIONS.includes(name))).toEqual([]);
  });

  it("sees every reader call the raw source spells out", () => {
    // An independent sentinel, not a self-referential pin: one side is the
    // parse, the other is a dumb `readValue(`-style regex over the UNTOUCHED
    // source. The two may differ only where the parser itself says the text is
    // a string body, a template quasi, a regex literal or a comment. A parse
    // that stops seeing a region cannot make both sides drop together, because
    // the regex side never learns about regions at all.
    expect(RAW_READER_STARTS.length).toBeGreaterThan(500);
    expect(
      RAW_READER_STARTS.filter(
        (start) =>
          !AST_READER_STARTS.has(start) &&
          !AST_READER_DECLARATIONS.has(start) &&
          !insideLiteralOrComment(start),
      ).map((start) => SOURCE.slice(start, start + 60)),
      "the parse stopped seeing reader calls the raw source still spells out in code: a call it cannot see needs no BROWSER_VALUE_FLAGS entry and every scan below stays green",
    ).toEqual([]);
    expect(AST_READER_DECLARATIONS.size).toBe(VALUE_READER_NAMES.length);
    const raw = new Set(RAW_READER_STARTS);
    expect(
      [...AST_READER_STARTS].filter((start) => !raw.has(start)),
      "the parse reports a reader call the raw scan cannot find: the two sides have drifted",
    ).toEqual([]);
    const deep = valueReaderCalls('readValue(args, ["--zz"], normalize(String(x)))');
    expect(deep.map(({ flags }) => flags)).toEqual([["--zz"]]);
    // A reader inside a template hole is executable code, and the old masker
    // blanked it along with the quasis around it.
    const hole = valueReaderCalls('const label = `${readValue(args, ["--zz"])}`;');
    expect(hole.map(({ flags }) => flags)).toEqual([["--zz"]]);
    // A reader inside a comment is not a call.
    expect(valueReaderCalls('// readValue(args, ["--zz"])\n')).toEqual([]);
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
    // Resolution is scope-aware: a parameter or a local of the same name is a
    // DIFFERENT list, and attributing the call to the top-level constant would
    // suppress a missing-entry failure.
    expect(
      valueReaderCalls(
        "function f(args, BROWSER_VALUE_FLAGS) { return readValue(args, BROWSER_VALUE_FLAGS); }",
      )[0]!.flags,
    ).toBeNull();
    // A function-local list is not the top-level constant either, however
    // readable it looks: only cli.ts's own top-level `const NAME = [ … ]`
    // resolves, so a plan that builds its flag names locally fails loudly here
    // instead of needing no table entry.
    expect(
      valueReaderCalls(
        'function f(args) { const names = ["--zz"]; return readValue(args, names); }',
      )[0]!.flags,
    ).toBeNull();
    expect(
      planValueReaderCalls()
        .filter(({ flags }) => flags == null)
        .map(({ call }) => call),
    ).toEqual([]);
  });

  it("covers every flag the browser plan reads a value for", () => {
    // `readRepeatedValues` is in the scan too: it consumes exactly like
    // `readValue`, so `--upload` carries a value and must be in the table or
    // `browser --upload path upload` dispatches on "path".
    const read = new Set(planValueReaderCalls().flatMap(({ flags }) => flags ?? []));
    expect(read.size).toBeGreaterThan(80);
    expect([...read].filter((flag) => !BROWSER_VALUE_FLAGS.includes(flag))).toEqual([]);
  });

  it("passes the browser table to every carrier-aware reader in the plan", () => {
    // `firstStandalonePositional` & co. default to the CLI-global carrier set,
    // so a browser-plan call that forgets `BROWSER_VALUE_CARRIER_FLAGS`
    // silently narrows the grammar back and `browser --tab-id t1 close`
    // dispatches on "t1" again — with no other test failing.
    // Found by parse, so a call nested inside another call — a future
    // `firstStandalonePositional(readBrowserArgs(args))` — is scanned rather
    // than skipped, and the count below is the real one.
    const calls = collect([...PLAN_NODES], ts.isCallExpression).filter((call) =>
      CARRIER_AWARE_READERS.includes(calleeName(call) ?? ""),
    );
    expect(
      calls.length,
      "the browser plan gained or lost a carrier-aware positional read: a dropped call site makes the table check below vacuous, a new one must pass BROWSER_VALUE_CARRIER_FLAGS",
    ).toBe(CARRIER_AWARE_CALL_SITES);
    expect(
      calls
        .filter(
          (call) =>
            !call.arguments.some((arg) => arg.getText(FILE).includes("BROWSER_VALUE_CARRIER_FLAGS")),
        )
        .map((call) => call.getText(FILE)),
    ).toEqual([]);
  });

  // The browser table is passed to the positional readers by the browser
  // builder alone, but a name in it is still read CLI-wide by whatever command
  // owns it, and the global set is still read by every other command. Both
  // scans run over the WHOLE file: scanning only the browser plan is how
  // `--text` — a global boolean output switch — became a browser carrier and
  // broke `ade session show --text s1`.
  const ALL_BOOLEAN_FLAGS = new Set(
    collect([FILE], ts.isCallExpression)
      .filter((call) => calleeName(call) === "readFlag" && call.arguments.length >= 2)
      .flatMap((call) =>
        collect([call.arguments[1]!], ts.isStringLiteralLike)
          .map((literal) => literal.text)
          .filter((text) => /^--?\S+$/.test(text)),
      ),
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
    const globalSwitches = collect([FILE], ts.isBinaryExpression)
      .filter(
        (node) =>
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isIdentifier(node.left) &&
          node.left.text === "token" &&
          ts.isStringLiteralLike(node.right),
      )
      .map((node) => (node.right as ts.StringLiteralLike).text)
      .filter((flag) => /^--[a-z-]+$/.test(flag) && !VALUE_CARRIER_FLAGS.has(flag));
    expect(globalSwitches).toContain("--text");
    expect(BROWSER_VALUE_FLAGS.filter((flag) => globalSwitches.includes(flag))).toEqual([]);
  });
});
