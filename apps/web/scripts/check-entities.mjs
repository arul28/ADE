import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(appRoot, "src");
const allowedNames = new Set(["amp", "lt", "gt", "quot"]);
const noAllowedNames = new Set();
const entityPattern = /&([a-zA-Z][a-zA-Z0-9]+);/g;
const skippedDirectories = new Set(["dist", "node_modules"]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) ? [] : sourceFiles(path);
    }

    return [".tsx", ".jsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

function isInsideUrl(source, position) {
  const tokenStart = Math.max(
    source.lastIndexOf(" ", position),
    source.lastIndexOf("\n", position),
    source.lastIndexOf("\t", position),
    source.lastIndexOf('"', position),
    source.lastIndexOf("'", position),
    source.lastIndexOf("`", position),
    source.lastIndexOf("<", position),
    source.lastIndexOf(">", position),
  ) + 1;
  const tokenEndMatch = source.slice(position).search(/[\s"'<>]/);
  const tokenEnd = tokenEndMatch === -1 ? source.length : position + tokenEndMatch;
  const token = source.slice(tokenStart, tokenEnd);
  return /^(?:[a-z][a-z\d+.-]*:\/\/|www\.)/i.test(token);
}

const violations = [];

for (const file of sourceFiles(sourceRoot)) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX,
  );

  function checkRange(start, end, allowed = allowedNames, urlContext = false) {
    const text = source.slice(start, end);
    for (const match of text.matchAll(entityPattern)) {
      const name = match[1];
      const position = start + match.index;
      if (allowed.has(name) || urlContext || isInsideUrl(source, position)) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
      violations.push(`${relative(appRoot, file)}:${line}: &${name};`);
    }
  }

  function checkRenderedStrings(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkRange(node.getStart(sourceFile), node.getEnd(), noAllowedNames);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const urlContext = /^(?:[a-z][a-z\d+.-]*:\/\/|www\.)/i.test(node.head.text);
      checkRange(node.head.getStart(sourceFile), node.head.getEnd(), noAllowedNames, urlContext);
      for (const span of node.templateSpans) {
        checkRenderedStrings(span.expression);
        checkRange(
          span.literal.getStart(sourceFile),
          span.literal.getEnd(),
          noAllowedNames,
          urlContext,
        );
      }
      return;
    }

    if (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node)
    ) {
      checkRenderedStrings(node.expression);
      return;
    }

    if (ts.isConditionalExpression(node)) {
      checkRenderedStrings(node.whenTrue);
      checkRenderedStrings(node.whenFalse);
      return;
    }

    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.PlusToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        checkRenderedStrings(node.left);
      }
      if (
        operator === ts.SyntaxKind.PlusToken
        || operator === ts.SyntaxKind.AmpersandAmpersandToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        checkRenderedStrings(node.right);
      }
      return;
    }

    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isSpreadElement(element)) checkRenderedStrings(element);
      }
    }
  }

  function visit(node) {
    if (ts.isJsxAttribute(node) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) {
        checkRange(
          node.initializer.getStart(sourceFile),
          node.initializer.getEnd(),
        );
      } else if (
        ts.isJsxExpression(node.initializer)
        && node.initializer.expression
      ) {
        checkRenderedStrings(node.initializer.expression);
      }
    } else if (ts.isJsxText(node)) {
      checkRange(node.getStart(sourceFile), node.getEnd());
    } else if (
      ts.isJsxExpression(node)
      && node.expression
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      checkRenderedStrings(node.expression);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (violations.length > 0) {
  console.error("Named HTML entities in JSX text must use literal Unicode characters:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Entity check passed.");
}
