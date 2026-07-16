export type ParsedProjectSecretEnvEntry = {
  name: string;
  value: string;
};

const ENV_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const MAX_ENV_FILE_BYTES = 1_048_576;
const MAX_ENV_ENTRIES = 500;

function decodeDoubleQuotedValue(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\" || index === value.length - 1) {
      decoded += char;
      continue;
    }
    const next = value[index + 1];
    index += 1;
    if (next === "n") decoded += "\n";
    else if (next === "r") decoded += "\r";
    else if (next === "t") decoded += "\t";
    else if (next === "\"") decoded += "\"";
    else if (next === "\\") decoded += "\\";
    else decoded += `\\${next}`;
  }
  return decoded;
}

function findClosingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    if (quote !== "\"") return index;
    let precedingBackslashes = 0;
    for (let previous = index - 1; previous >= 0 && value[previous] === "\\"; previous -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) return index;
  }
  return -1;
}

function parseValue(rawValue: string, lineNumber: number): string {
  const value = rawValue.trim();
  if (!value) return "";
  const quote = value[0];
  if (quote === "'" || quote === "\"" || quote === "`") {
    const closingIndex = findClosingQuote(value, quote);
    if (closingIndex < 0) {
      throw new Error(`Invalid .env file: unterminated quoted value on line ${lineNumber}.`);
    }
    const trailing = value.slice(closingIndex + 1).trim();
    if (trailing && !trailing.startsWith("#")) {
      throw new Error(`Invalid .env file: unexpected text after the value on line ${lineNumber}.`);
    }
    const inner = value.slice(1, closingIndex);
    return quote === "\"" ? decodeDoubleQuotedValue(inner) : inner;
  }
  const commentIndex = value.indexOf("#");
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}

export function parseProjectSecretEnv(content: string): ParsedProjectSecretEnvEntry[] {
  if (Buffer.byteLength(content, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error("The selected .env file is larger than 1 MB.");
  }
  const entries = new Map<string, string>();
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed || trimmed.startsWith("#")) continue;
    const statement = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const equalsIndex = statement.indexOf("=");
    if (equalsIndex < 0) {
      throw new Error(`Invalid .env file: expected NAME=VALUE on line ${lineNumber}.`);
    }
    const name = statement.slice(0, equalsIndex).trim();
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid .env file: '${name || "(empty)"}' is not a valid environment variable name on line ${lineNumber}.`);
    }
    let rawValue = statement.slice(equalsIndex + 1);
    const openingQuote = rawValue.trimStart()[0];
    if (openingQuote === "'" || openingQuote === "\"" || openingQuote === "`") {
      while (findClosingQuote(rawValue.trim(), openingQuote) < 0 && index + 1 < lines.length) {
        index += 1;
        rawValue += `\n${lines[index] ?? ""}`;
      }
    }
    const value = parseValue(rawValue, lineNumber);
    if (!value.length) {
      throw new Error(`Invalid .env file: '${name}' has an empty value on line ${lineNumber}.`);
    }
    entries.set(name, value);
    if (entries.size > MAX_ENV_ENTRIES) {
      throw new Error(`The selected .env file contains more than ${MAX_ENV_ENTRIES} variables.`);
    }
  }
  if (entries.size === 0) {
    throw new Error("The selected .env file does not contain any variables.");
  }
  return [...entries].map(([name, value]) => ({ name, value }));
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) return value;
  if (!value.includes("'") && !value.includes("\n") && !value.includes("\r")) {
    return `'${value}'`;
  }
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

export function formatProjectSecretEnv(entries: ParsedProjectSecretEnvEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map(({ name, value }) => `${name}=${quoteEnvValue(value)}`).join("\n")}\n`;
}

export const PROJECT_SECRET_ENV_MAX_BYTES = MAX_ENV_FILE_BYTES;
export const PROJECT_SECRET_ENV_MAX_ENTRIES = MAX_ENV_ENTRIES;
