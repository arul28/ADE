import fs from "node:fs";
import path from "node:path";

function findFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) {
    throw new Error(`Unable to find function signature: ${signature}`);
  }
  const openParen = source.indexOf("(", start);
  if (openParen < 0) {
    throw new Error(`Unable to find parameter list for: ${signature}`);
  }
  let parenDepth = 1;
  let cursor = openParen + 1;
  while (cursor < source.length && parenDepth > 0) {
    const char = source[cursor];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    cursor += 1;
  }
  if (parenDepth !== 0) {
    throw new Error(`Unbalanced parentheses while reading: ${signature}`);
  }
  const openBrace = source.indexOf("{", cursor);
  if (openBrace < 0) {
    throw new Error(`Unable to find function body for: ${signature}`);
  }
  let depth = 1;
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced braces while reading: ${signature}`);
  }
  return source.slice(openBrace + 1, i - 1);
}

function readStringToken(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && char === "$" && source[i + 1] === "{") {
      throw new Error("Template interpolation is not supported in bootstrap SQL extraction.");
    }
    if (char === quote) {
      return { token: source.slice(start, i + 1), end: i + 1 };
    }
    i += 1;
  }
  throw new Error("Unterminated string literal while extracting bootstrap SQL.");
}

function extractRunStatements(body, { firstOnly = false } = {}) {
  const statements = [];
  let index = 0;
  while (index < body.length) {
    const matchIndex = body.indexOf("db.run(", index);
    if (matchIndex < 0) break;
    let cursor = matchIndex + "db.run(".length;
    while (/\s/.test(body[cursor] ?? "")) cursor += 1;
    const quote = body[cursor];
    if (quote !== "`" && quote !== "\"" && quote !== "'") {
      throw new Error(`Unsupported db.run argument near: ${body.slice(matchIndex, matchIndex + 80)}`);
    }
    const { token, end } = readStringToken(body, cursor);
    const sql = Function(`return ${token}`)();
    statements.push(String(sql));
    index = end;
    if (firstOnly) break;
  }
  return statements;
}

function normalizeStatement(sql) {
  const trimmed = sql.trim();
  if (!trimmed.length) return null;
  if (!trimmed.endsWith(";")) return `${trimmed};`;
  return trimmed;
}

export function buildKvDbBootstrapSql(options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
  const kvDbPath = path.join(repoRoot, "apps", "desktop", "src", "main", "services", "state", "kvDb.ts");
  const source = fs.readFileSync(kvDbPath, "utf8");
  const ftsBody = findFunctionBody(source, "function ensureUnifiedMemoriesSearchTable");
  const migrateBody = findFunctionBody(source, "function migrate");
  const statements = [
    ...extractRunStatements(ftsBody, { firstOnly: true }),
    ...extractRunStatements(migrateBody),
  ]
    .map(normalizeStatement)
    .filter(Boolean);

  return `${statements.join("\n\n")}\n`;
}
