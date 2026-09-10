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
 * Every top-level callable BOUND BY A VARIABLE in cli.ts. The call graph
 * follows `function <name>` declarations only, so a reader written as
 * `const readFoo = (args) => …` or as a method on a top-level namespace
 * object never enters PLAN_FUNCTIONS: the flags it reads need no
 * `BROWSER_VALUE_FLAGS` entry and every coverage scan in this file stays green
 * while the grammar drifts. The scan is fail-closed — it lists those shapes
 * rather than supporting them, so the first reader written in one fails here
 * and has to be converted or the graph widened.
 *
 * Only initializer positions that BIND a callable are followed. A callback is
 * not a named callable: the arrow in `const NAMES = FLAGS.map((f) => f.text)`
 * is unreachable from the plan, so a subtree walk would refuse it for nothing.
 *
 * Top-level CLASS methods are the third un-indexable shape, and they are not
 * refused by shape: cli.ts already declares JSON-RPC transports whose methods
 * are legitimate and would need a hand-kept allowlist here — the same subset
 * this file keeps replacing. `argvReadingClassMethods` below holds them to
 * the property that actually matters instead.
 */
function namedCallableShapes(file: ts.SourceFile): string[] {
  const found: string[] = [];

  function fromValue(value: ts.Expression, name: string): void {
    const node = unwrap(value);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      found.push(name);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) fromObject(node, name);
  }

  function fromObject(object: ts.ObjectLiteralExpression, owner: string): void {
    for (const property of object.properties) {
      const key = property.name ? property.name.getText(file) : "<computed>";
      if (ts.isMethodDeclaration(property)) {
        found.push(`${owner}.${key}`);
        continue;
      }
      if (ts.isPropertyAssignment(property)) fromValue(property.initializer, `${owner}.${key}`);
    }
  }

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (declaration.initializer)
        fromValue(declaration.initializer, declaration.name.getText(file));
  }

  return found.sort();
}

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
 * Top-level class methods in cli.ts that reach argv. A class method is the one
 * un-indexable shape the scan cannot refuse outright — the JSON-RPC transports
 * here are classes and their methods are legitimate — so it is held to the
 * property the call graph exists to protect: a method that reads argv is a
 * reader the plan scan cannot see, and its flags would need no table entry.
 */
function argvReadingClassMethods(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const touchesArgv = (body: ts.Node): boolean =>
    calleesIn([body]).some(
      (name) => ARGV_PRIMITIVES.includes(name) || ARGV_READERS.has(name),
    );
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const owner = statement.name ? statement.name.text : "<anonymous class>";
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      if (touchesArgv(member.body)) found.push(`${owner}.${member.name.getText(file)}`);
    }
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

  it("refuses a top-level callable the call graph cannot index", () => {
    // The call graph reaches a helper only through its `function <name>`
    // declaration. `const readFoo = (args) => readValue(args, ["--foo"])` in
    // cli.ts is invisible to it, so `--foo` needs no `BROWSER_VALUE_FLAGS`
    // entry and every scan in this file stays green. Fail closed: refuse the
    // shape here rather than teach the graph a shape nothing uses yet.
    expect(
      namedCallableShapes(FILE),
      "a top-level callable in cli.ts is not a `function` declaration: the call graph cannot index it, so the flags it reads need no BROWSER_VALUE_FLAGS entry and every coverage scan in this file stays green",
    ).toEqual([]);
    // "None in cli.ts" only means something if the scan can find the shapes
    // it refuses. The last line is the precision claim: a callback argument
    // binds no name the plan could call, so it must not trip the guard.
    const synthetic = parseSource(
      "synthetic.ts",
      [
        'const readAlpha = (args: string[]) => readValue(args, ["--alpha"]);',
        "const READERS = {",
        '  beta(args: string[]) { return readValue(args, ["--beta"]); },',
        '  gamma: (args: string[]) => readValue(args, ["--gamma"]),',
        "};",
        'const NAMES = ["--zeta"].map((flag) => flag.slice(2));',
      ].join("\n"),
    );
    expect(namedCallableShapes(synthetic)).toEqual([
      "READERS.beta",
      "READERS.gamma",
      "readAlpha",
    ]);
    // A class method cannot be refused by shape — cli.ts declares JSON-RPC
    // transports — so it is refused for reading argv instead.
    expect(
      argvReadingClassMethods(FILE),
      "a top-level class method in cli.ts reads argv: the call graph cannot index it, so the flags it reads need no BROWSER_VALUE_FLAGS entry",
    ).toEqual([]);
    const transports = parseSource(
      "transports.ts",
      [
        'class Delta { epsilon(args: string[]) { return readValue(args, ["--epsilon"]); } }',
        "class Theta { iota(line: string) { return line.trim(); } }",
      ].join("\n"),
    );
    expect(argvReadingClassMethods(transports)).toEqual(["Delta.epsilon"]);
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
