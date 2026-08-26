import {
  augmentProcessPathWithShellAndKnownCliDirs,
  setPathEnvValue,
} from "../ai/cliExecutableResolver";

export function editorProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  setPathEnvValue(next, augmentProcessPathWithShellAndKnownCliDirs({ env }));
  return next;
}
