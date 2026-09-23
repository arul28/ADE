import { isAdeRuntimeNamedPipePath } from "../../../desktop/src/shared/adeRuntimeIpc";

/**
 * Global flags `parseCliArgs` reads with the next token as their value. Kept
 * here so the delegation check, which runs before the CLI bundle loads, skips
 * the same tokens the CLI does.
 */
export const CLI_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--project-root",
  "--workspace-root",
  "--role",
  "--timeout-ms",
]);

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
