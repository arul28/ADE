#!/usr/bin/env node
/**
 * Generates the SDK API reference from the package's TypeScript declarations.
 *
 * The guides under `sdk/` are hand-written. The API surface is not: it is read
 * from `packages/sdk/src/index.ts` with the TypeScript checker, so a renamed
 * argument or a new option appears in the docs the next time this runs.
 *
 * Output:
 *   sdk/api.mdx    — the client, functions, errors, and constants
 *   sdk/types.mdx  — every exported type and interface
 *
 * Run: node scripts/generate-sdk-reference.mjs
 * `--check` exits non-zero when the committed pages are stale (for CI).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "apps/desktop/package.json"));
const ts = require("typescript");

const HEADER_NOTE = `> Generated from \`packages/sdk/src\` by \`scripts/generate-sdk-reference.mjs\`. Do not edit this page by hand — change the source or the generator. For the narrative version, start with [Reference](/sdk/reference).`;

function escapeProseSegment(segment) {
  return segment
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/**
 * MDX treats `<`, `{`, and `}` in prose as JSX or expressions. Code spans and
 * fenced blocks are safe, so escape only the prose between them — escaping
 * inside a code span would show the entity literally.
 */
function escapeMdxText(text) {
  const resolved = text
    .replace(/\{@link\s+([^}]+)\}/g, "$1")
    .replace(/\{@code\s+([^}]+)\}/g, "`$1`");

  let inFence = false;
  return resolved
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/g)
        .map((segment, index) => (index % 2 === 1 ? segment : escapeProseSegment(segment)))
        .join("");
    })
    .join("\n");
}

function jsDocFor(node) {
  const blocks = ts.getJSDocCommentsAndTags(node);
  if (!blocks.length) return "";
  return blocks
    .map((block) => {
      let text = block.getText();
      text = text.replace(/^\/\*\*?/, "").replace(/\*\/$/, "");
      text = text
        .split("\n")
        .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
        .join("\n")
        .trim();
      return text;
    })
    .filter(Boolean)
    .map(escapeMdxText)
    .join("\n\n");
}

function sourceFor(node) {
  return node.getSourceFile();
}

function printNode(node) {
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFor(node)).trim();
}

function printFunction(node) {
  const clone = ts.factory.updateFunctionDeclaration(
    node,
    node.modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    node.parameters,
    node.type,
    undefined
  );
  return printNode(clone).replace(/\s*;\s*$/, "");
}

function printClass(node) {
  const members = node.members.map((member) => {
    if (ts.isMethodDeclaration(member)) {
      return ts.factory.updateMethodDeclaration(
        member,
        member.modifiers,
        member.asteriskToken,
        member.name,
        member.questionToken,
        member.typeParameters,
        member.parameters,
        member.type,
        undefined
      );
    }
    if (ts.isConstructorDeclaration(member)) {
      return ts.factory.updateConstructorDeclaration(
        member,
        member.modifiers,
        member.parameters,
        undefined
      );
    }
    return member;
  });
  const clone = ts.factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members
  );
  return printNode(clone);
}

function printVariable(node, checker) {
  const name = node.name.getText();
  let type = checker.typeToString(
    checker.getTypeAtLocation(node),
    node,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedElsewhere
  );
  if (type.length > 400) {
    type = node.type ? node.type.getText() : "unknown";
  }
  return `export const ${name}: ${type};`;
}

function declarationText(symbol, checker) {
  const node = symbol.declarations?.[0];
  if (!node) return null;
  if (ts.isFunctionDeclaration(node)) return printFunction(node);
  if (ts.isClassDeclaration(node)) return printClass(node);
  if (ts.isVariableDeclaration(node)) return printVariable(node, checker);
  return node.getText();
}

function build() {
  const configPath = path.join(ROOT, "packages/sdk/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(path.join(ROOT, "packages/sdk/src/index.ts"));
  if (!entry) throw new Error("packages/sdk/src/index.ts not found");
  const moduleSymbol = checker.getSymbolAtLocation(entry);
  if (!moduleSymbol) throw new Error("index.ts has no module symbol");

  const buckets = { functions: [], classes: [], constants: [], types: [] };

  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    let target = symbol;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        target = checker.getAliasedSymbol(symbol);
      } catch {
        // Leave the alias as-is; the declaration fallback still works.
      }
    }
    const node = target.declarations?.[0];
    if (!node) continue;
    const name = symbol.getName();
    const text = declarationText(target, checker);
    if (!text) continue;
    const doc = jsDocFor(node);
    const entryPage = { name, text, doc };

    if (ts.isFunctionDeclaration(node)) buckets.functions.push(entryPage);
    else if (ts.isClassDeclaration(node)) buckets.classes.push(entryPage);
    else if (ts.isVariableDeclaration(node)) buckets.constants.push(entryPage);
    else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) buckets.types.push(entryPage);
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  for (const key of Object.keys(buckets)) buckets[key].sort(byName);

  return buckets;
}

function renderEntry(entry, level = "###") {
  const parts = [`${level} \`${entry.name}\``];
  if (entry.doc) parts.push(entry.doc);
  parts.push(["````ts", entry.text, "````"].join("\n"));
  return parts.join("\n\n");
}

function renderApi(buckets) {
  const lines = [
    "---",
    'title: "API reference"',
    'description: "Every function, error, and constant exported by @ade-dev/sdk — generated from the published TypeScript declarations."',
    'icon: "code"',
    "---",
    "",
    HEADER_NOTE,
    ""
  ];
  if (buckets.functions.length) {
    lines.push("## Functions", "");
    for (const entry of buckets.functions) lines.push(renderEntry(entry), "");
  }
  if (buckets.classes.length) {
    lines.push("## Classes", "");
    for (const entry of buckets.classes) lines.push(renderEntry(entry), "");
  }
  if (buckets.constants.length) {
    lines.push("## Constants", "");
    for (const entry of buckets.constants) lines.push(renderEntry(entry), "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function renderTypes(buckets) {
  const lines = [
    "---",
    'title: "Types"',
    'description: "Every type and interface exported by @ade-dev/sdk — generated from the published TypeScript declarations."',
    'icon: "shapes"',
    "---",
    "",
    HEADER_NOTE,
    "",
    "## Types and interfaces",
    ""
  ];
  for (const entry of buckets.types) lines.push(renderEntry(entry), "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function main() {
  const check = process.argv.includes("--check");
  const buckets = build();
  const outputs = {
    "sdk/api.mdx": renderApi(buckets),
    "sdk/types.mdx": renderTypes(buckets)
  };

  let stale = false;
  for (const [relative, content] of Object.entries(outputs)) {
    const absolute = path.join(ROOT, relative);
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : null;
    if (check) {
      if (current !== content) {
        console.error(`${relative} is stale; run node scripts/generate-sdk-reference.mjs`);
        stale = true;
      }
    } else if (current !== content) {
      fs.writeFileSync(absolute, content);
      console.log(`wrote ${relative} (${content.split("\n").length} lines)`);
    } else {
      console.log(`${relative} is up to date`);
    }
  }
  if (check && stale) process.exit(1);
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main();
