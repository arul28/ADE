/**
 * Variables that configure the ADE host process itself (the brain or the
 * desktop), not the programs it starts for a user or an agent.
 *
 * The brain runs as `ELECTRON_RUN_AS_NODE=1`. Left in a terminal or an agent
 * shell, that flag makes every Electron app started there run as plain Node:
 * `npm start` in an Electron repo prints nothing and opens no window, and App
 * Control cannot launch it. The runtime lifecycle keys would tie a runtime the
 * user starts by hand to the desktop that started this brain.
 *
 * `ADE_DEFAULT_ROLE` is here because the host may itself run inside an agent
 * shell. Tracked agent CLIs set their role explicitly after this strip.
 *
 * `NODE_COMPILE_CACHE` is the brain's own compile cache (its service definition
 * sets it). A Node program a user or an agent starts would otherwise write into
 * that cache, and Node never prunes it.
 *
 * `stripHostRuntimeEnv` also drops the multiplexer session keys below.
 */
export const HOST_RUNTIME_ENV_KEYS = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ADE_DEFAULT_ROLE",
  "ADE_RUNTIME_PARENT_PID",
  "ADE_RUNTIME_IDLE_EXIT_MS",
  "NODE_COMPILE_CACHE",
] as const;

/**
 * The terminal multiplexer session the host was started from (tmux, GNU
 * screen, Zellij). A brain started from a tmux pane carries that pane's
 * `TMUX` and `TMUX_PANE`; a shell or agent ADE starts would then believe it
 * runs inside that pane, so `tmux split-window` or a clipboard helper that
 * checks `$TMUX` acts on the user's unrelated session instead.
 *
 * Only session pointers are listed. Config such as `ZELLIJ_CONFIG_DIR` or
 * `TMUX_TMPDIR` stays.
 */
const MULTIPLEXER_SESSION_ENV_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
] as const;

/**
 * Remove, in place, each host-only key whose value is the host's own value.
 * A caller that set a different value on purpose keeps it. Use this on every
 * env built for a user shell, a user command, or an agent process, after all
 * layers are merged. Returns `env` for chaining.
 */
export function stripHostRuntimeEnv<T extends NodeJS.ProcessEnv | Record<string, string>>(
  env: T,
  hostEnv: NodeJS.ProcessEnv = process.env,
): T {
  const stripIfHostValue = (key: string) => {
    const hostValue = hostEnv[key];
    if (hostValue !== undefined && env[key] === hostValue) {
      delete (env as Record<string, unknown>)[key];
    }
  };
  for (const key of HOST_RUNTIME_ENV_KEYS) stripIfHostValue(key);
  for (const key of MULTIPLEXER_SESSION_ENV_KEYS) stripIfHostValue(key);
  // GNU screen's window number has a generic name; it is screen's only while
  // the host is itself inside a screen session.
  if (hostEnv.STY !== undefined) stripIfHostValue("WINDOW");
  return env;
}

/** A copy of `base` without the host-only keys this process carries. */
export function userProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return stripHostRuntimeEnv({ ...base });
}
