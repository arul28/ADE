/**
 * Every thinking level Pi's SDK accepts, lowest first.
 *
 * The one list. `shared/cliLaunch.ts` exports it and maps ADE efforts onto it
 * (`piThinkingLevel`); the Pi worker protocol re-exports it. It lives in its
 * own dependency-free module so the Pi worker bundle does not pull in the
 * model registry through `cliLaunch.ts`.
 */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
