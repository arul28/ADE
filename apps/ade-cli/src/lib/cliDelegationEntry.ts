/**
 * Side-effect module: imported second in cli.ts (right after nodeWarnings) so
 * the delegation decision, and the child spawn when it applies, happen before
 * the rest of the CLI bundle is evaluated. ES imports are hoisted, so a call in
 * cli.ts's own body would run only after every other import had loaded.
 */
import { startCliDelegationIfNeeded } from "./cliDelegation";

export const pendingCliDelegation = startCliDelegationIfNeeded();
