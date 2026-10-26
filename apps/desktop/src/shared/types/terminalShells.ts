/**
 * The shells a machine can open for a new terminal, and the one it opens by
 * default. Both come from the machine the terminal runs on, never from the
 * computer showing Settings.
 */

/** One shell the machine found installed. */
export type TerminalShellOption = {
  /**
   * Stable id. On macOS and Linux it is the shell's path as listed in
   * `/etc/shells` or `$SHELL`; on Windows it is the kind: `pwsh`,
   * `powershell`, `cmd` or `git-bash`.
   */
  id: string;
  /** What the picker shows: "zsh", "PowerShell 7", "Git Bash". */
  label: string;
  /** The executable a new terminal starts. */
  path: string;
};

export type TerminalShellSettings = {
  /** The saved choice. Null means Automatic, which is the behaviour ADE always had. */
  defaultShellId: string | null;
  /**
   * The saved shell is no longer installed, so new terminals use Automatic
   * until it is back or another choice is saved.
   */
  savedShellMissing: boolean;
  /** The shell Automatic tries first on this machine (a path or a command name). */
  automaticShell: string | null;
  shells: TerminalShellOption[];
};

export type SetDefaultTerminalShellArgs = {
  /** An id from `TerminalShellSettings.shells`, or null for Automatic. */
  shellId: string | null;
};
