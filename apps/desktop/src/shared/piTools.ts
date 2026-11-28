/**
 * Pi's built-in tools that only read: `read`, plus the search tools `grep`,
 * `find` and `ls`. The one list for Pi's plan mode, a read-only chat worker
 * (`PiSdkWorkerInit.readOnly`) and a side chat. Its own module so the Pi worker
 * bundle can import it without the rest of `cliLaunch`.
 */
/**
 * Pi's read-only search built-ins. They never ask: like `read`, they cannot
 * change the workspace. They run ripgrep and fd (see the Pi chat docs for how
 * ADE keeps Pi from downloading those).
 */
export const PI_SEARCH_TOOLS = ["grep", "find", "ls"] as const;

export const PI_READ_ONLY_TOOLS = ["read", ...PI_SEARCH_TOOLS] as const;

/**
 * Pi's shells. A read-only session may still be granted them: the worker
 * then runs only commands that read (`shellCommandIsReadOnly`, the same check
 * as Claude's plan mode) and refuses the rest without asking, so a plan can
 * use `git log` or read its Linear issue with `ade linear issue`.
 */
export const PI_SHELL_TOOLS = ["bash", "powershell"] as const;
