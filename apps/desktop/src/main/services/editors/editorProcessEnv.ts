import {
  augmentProcessPathWithShellAndKnownCliDirs,
  setPathEnvValue,
} from "../ai/cliExecutableResolver";
import { userProcessEnv } from "../shared/hostRuntimeEnv";

/**
 * The env an editor is detected and opened with. An editor is a user program,
 * so the host's own keys (`ELECTRON_RUN_AS_NODE` would start VS Code or Cursor
 * as plain Node) and the multiplexer session it was started from stay behind.
 */
export function editorProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = userProcessEnv(env);
  setPathEnvValue(next, augmentProcessPathWithShellAndKnownCliDirs({ env }));
  return next;
}
