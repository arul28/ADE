/**
 * Pi's built-in tools that only read: `read`, plus the search tools `grep`,
 * `find` and `ls`. The one list for Pi's plan mode, a read-only chat worker
 * (`PiSdkWorkerInit.readOnly`) and a side chat. Its own module so the Pi worker
 * bundle can import it without the rest of `cliLaunch`.
 */
export const PI_SEARCH_TOOLS = ["grep", "find", "ls"] as const;

export const PI_READ_ONLY_TOOLS = ["read", ...PI_SEARCH_TOOLS] as const;
