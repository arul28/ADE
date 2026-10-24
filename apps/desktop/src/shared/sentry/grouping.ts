/**
 * How a failed runtime action becomes a Sentry issue.
 *
 * Every brain action goes through one channel, and a failure that reaches the
 * desktop has no stack of its own (it is rebuilt from the brain's reply), so
 * Sentry cannot group by code. Grouping by action made one fault into one
 * issue per action that hit it: a project the brain did not know became nine
 * issues, one for each screen that asked. These group by what failed instead
 * (the error's code or type, and its message with the ids, paths and numbers
 * taken out), and keep the action as the `runtime.action` tag.
 */
import { parseCodedErrorMessage } from "../codedError";

const MAX_GROUPING_TEXT = 200;

/**
 * Rewrites, in order. Ids and paths go before plain numbers, so a uuid or a
 * Windows path is replaced whole rather than digit by digit.
 */
const GROUPING_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // uuid-shaped ids.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  // Windows paths (C:\… or C:/…) and UNC paths (\\server\share\…).
  [/\b[A-Za-z]:[\\/][^\s'"`),;]*/g, "<path>"],
  [/\\\\[^\s'"`),;]+/g, "<path>"],
  // POSIX and home paths: a slash that starts a word, so `ade/actions/call` stays.
  [/(^|[\s('"`=:])~?\/[^\s'"`),;]*/g, "$1<path>"],
  // Quoted names: a branch, a secret, a key.
  [/'[^'\n]{1,200}'/g, "'<...>'"],
  [/"[^"\n]{1,200}"/g, "\"<...>\""],
  // Any word with a digit in it, six characters or longer: tab-…, bs-…, project_…, hex.
  [/\b(?=[\w-]*\d)[\w-]{6,}\b/g, "<id>"],
  [/\d+/g, "<n>"],
];

/** The message with what varies between occurrences of one fault taken out. */
function normalizeErrorMessageForGrouping(message: string): string {
  let text = message;
  for (const [pattern, replacement] of GROUPING_REWRITES) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_GROUPING_TEXT);
}

const PROGRAMMING_ERROR_NAMES: ReadonlySet<string> = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError"]);
const PROGRAMMING_ERROR_MESSAGE = /Cannot read properties of|is not a function|is not defined|is not iterable/;

/**
 * The fingerprint for a failed runtime action: the error's code (or its type)
 * and its normalized message. The action name stays a tag, except for a
 * programming error: "Cannot read properties of undefined" in two actions is
 * two bugs, so those keep the action in the fingerprint.
 */
export function runtimeActionFingerprint(error: unknown, action: string): string[] {
  const code = parseCodedErrorMessage(error).code;
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  const fingerprint = ["runtime-action", code ?? name, normalizeErrorMessageForGrouping(message)];
  const programmingError = PROGRAMMING_ERROR_NAMES.has(name) || PROGRAMMING_ERROR_MESSAGE.test(message);
  return programmingError ? [...fingerprint, action] : fingerprint;
}
