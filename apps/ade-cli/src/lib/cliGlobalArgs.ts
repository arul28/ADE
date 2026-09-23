import { isAdeRuntimeNamedPipePath } from "../../../desktop/src/shared/adeRuntimeIpc";

/**
 * Global flags `parseCliArgs` reads with the next token as their value. Kept
 * here so the delegation check, which runs before the CLI bundle loads, skips
 * the same tokens the CLI does. The CLI keys its handlers by this type, so a
 * flag added here without a handler does not compile.
 */
export const CLI_GLOBAL_VALUE_FLAG_NAMES = [
  "--project-root",
  "--workspace-root",
  "--role",
  "--timeout-ms",
] as const;

export type CliGlobalValueFlag = (typeof CLI_GLOBAL_VALUE_FLAG_NAMES)[number];

export const CLI_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(CLI_GLOBAL_VALUE_FLAG_NAMES);

export function isCliGlobalValueFlag(token: string | null | undefined): token is CliGlobalValueFlag {
  return typeof token === "string" && CLI_GLOBAL_VALUE_FLAGS.has(token);
}

/** Whether the token after a bare `--socket` is its path, not the command. */
export function looksLikeSocketPathOverride(value: string): boolean {
  if (!value || value.startsWith("-")) return false;
  return (
    value.startsWith("tcp://") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    isAdeRuntimeNamedPipePath(value) ||
    // Windows absolute paths (C:\... / C:/...) never start with "/", so without
    // this they would be dropped and left behind as a stray positional.
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.endsWith(".sock")
  );
}
