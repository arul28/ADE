/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` on every
 * single `ade` invocation, because `node:sqlite` is the primary database engine.
 * Users see it three or four times during an install and read it, reasonably, as
 * something being broken.
 *
 * `--no-warnings` is not reachable here: the shipped CLI is a single-executable
 * Node build, so there is no shebang or NODE_OPTIONS the user controls. The
 * filter has to happen in-process.
 *
 * We wrap `process.emitWarning` rather than removing the `warning` listeners.
 * Removing listeners means re-implementing Node's own output format for every
 * warning we *do* want to show; wrapping the emitter leaves that formatting
 * untouched and simply drops the one warning class we know is noise.
 */

/** Escape hatch: set to 1 to see every warning Node emits, unfiltered. */
const SHOW_WARNINGS_ENV = "ADE_SHOW_NODE_WARNINGS";

let installed = false;
/** The unwrapped emitter, kept so a reset can put the process back as it was. */
let originalEmitWarning: typeof process.emitWarning | null = null;

function warningType(
  warning: string | Error,
  rest: readonly unknown[],
): string | null {
  // process.emitWarning(warning, type?, code?, ctor?)
  const [second] = rest;
  if (typeof second === "string") return second;
  // process.emitWarning(warning, { type, code, detail })
  if (second && typeof second === "object" && "type" in second) {
    const { type } = second as { type?: unknown };
    if (typeof type === "string") return type;
  }
  // process.emitWarning(new Error(...)) — the name carries the type.
  if (typeof warning !== "string" && typeof warning?.name === "string") {
    return warning.name;
  }
  return null;
}

function warningMessage(warning: string | Error): string {
  return typeof warning === "string" ? warning : (warning?.message ?? "");
}

/**
 * Only the SQLite experimental notice. Every other warning — deprecations, our
 * own `process.emitWarning` calls, unhandled rejection notices — still prints,
 * because those are ones a user or a bug report genuinely needs.
 */
export function isSuppressedNodeWarning(
  warning: string | Error,
  rest: readonly unknown[] = [],
): boolean {
  if (warningType(warning, rest) !== "ExperimentalWarning") return false;
  return /\bsqlite\b/i.test(warningMessage(warning));
}

/**
 * Idempotent. Safe to call from any entry point; the CLI calls it first so the
 * wrap is in place before `node:sqlite` is loaded anywhere in the process.
 */
export function installNodeWarningFilter(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (installed) return;
  if (env[SHOW_WARNINGS_ENV] === "1") return;
  installed = true;

  originalEmitWarning = process.emitWarning;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((
    warning: string | Error,
    ...rest: unknown[]
  ): void => {
    if (isSuppressedNodeWarning(warning, rest)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** Test-only: lets a suite install the filter against a fresh module state. */
export function resetNodeWarningFilterForTests(): void {
  installed = false;
  // Clearing the flag alone is not a reset: the wrapper stays on `process` and
  // the next install wraps it again, so the chain grows by one frame per reset
  // and every warning is filtered as many times as the suite has reset.
  if (originalEmitWarning) process.emitWarning = originalEmitWarning;
  originalEmitWarning = null;
}

// Self-installing on import, deliberately. `node:sqlite` emits its warning the
// moment it is first required, and ES module imports are hoisted above every
// top-level statement -- so a call placed in cli.ts's body would run *after*
// the imports that pull in the database layer, and the warning would already
// have printed. Importing this module first is the only ordering that works.
installNodeWarningFilter();
