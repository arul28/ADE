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

/**
 * Per-session pointers a terminal emulator puts in its own shells. A host
 * started from iTerm, Windows Terminal, kitty or WezTerm carries them, and an
 * ADE terminal would then claim to be that window: iTerm's shell integration
 * keys on `LC_TERMINAL`, and CLIs that detect their terminal read these when
 * `TERM_PROGRAM` says nothing. Only session pointers; config stays.
 */
const OUTER_TERMINAL_SESSION_ENV_KEYS = [
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "ITERM_SESSION_ID",
  "TERM_SESSION_ID",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
] as const;

/** What an ADE terminal tells the programs in it it is. */
export const ADE_TERM_PROGRAM = "ADE";

/**
 * Name ADE as the terminal of a PTY it renders: `TERM_PROGRAM=ADE` and
 * `TERM_PROGRAM_VERSION=<ADE version>`, replacing whatever terminal the host
 * was started from. Unknown names are the norm for this variable (tmux sets
 * its own inside a pane, and wins there), and the agent CLIs treat a name
 * they do not know as a plain xterm-compatible terminal.
 *
 * `keepTermProgram` keeps both variables as they are, for a caller or lane
 * environment that set `TERM_PROGRAM` on purpose. Mutates and returns `env`;
 * apply after `stripHostRuntimeEnv`.
 */
export function withAdeTerminalIdentityEnv<T extends NodeJS.ProcessEnv | Record<string, string>>(
  env: T,
  args: { version?: string | null; keepTermProgram?: boolean },
  hostEnv: NodeJS.ProcessEnv = process.env,
): T {
  for (const key of OUTER_TERMINAL_SESSION_ENV_KEYS) {
    const hostValue = hostEnv[key];
    if (hostValue !== undefined && env[key] === hostValue) {
      delete (env as Record<string, unknown>)[key];
    }
  }
  const target = env as Record<string, string | undefined>;
  if (args.keepTermProgram) {
    // The caller named another program; the host terminal's version is not its.
    if (
      target.TERM_PROGRAM !== hostEnv.TERM_PROGRAM
      && hostEnv.TERM_PROGRAM_VERSION !== undefined
      && target.TERM_PROGRAM_VERSION === hostEnv.TERM_PROGRAM_VERSION
    ) {
      delete target.TERM_PROGRAM_VERSION;
    }
    return env;
  }
  target.TERM_PROGRAM = ADE_TERM_PROGRAM;
  const version = args.version?.trim();
  if (version) target.TERM_PROGRAM_VERSION = version;
  else delete target.TERM_PROGRAM_VERSION;
  return env;
}

/** A copy of `base` without the host-only keys this process carries. */
export function userProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return stripHostRuntimeEnv({ ...base });
}
