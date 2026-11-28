/**
 * `@daex-dev/sdk/electron/global` — the type of `window.ade`.
 *
 * Types only. Import it once, for its side effect on the type checker, in any
 * file of a renderer that reads the bridge:
 *
 *   import "@daex-dev/sdk/electron/global";
 *   const client = createDaexIpcClient(window.ade);
 *
 * or list it in `tsconfig.json` `compilerOptions.types`. It declares the
 * default key only: a preload that passed `exposeDaexBridge(..., { key })`
 * with another name should declare `interface Window { <name>: DaexBridge }`
 * itself.
 *
 * The emitted JavaScript is empty, so importing it at run time costs nothing
 * and is safe under a strict CSP.
 */

import type { DaexBridge } from "./protocol.js";

declare global {
  interface Window {
    /**
     * The bridge `exposeDaexBridge` put on `window` (default key `"ade"`).
     * Optional since SDK 0.4: a preload that failed to load leaves it
     * undefined, and a host can check that without a cast.
     * `createDaexIpcClient(window.ade)` still type-checks, and throws
     * `invalid_option` when it is missing.
     */
    ade?: DaexBridge;
  }
}

export type { DaexBridge };

// Pre-DAEX names: deprecated aliases of the DAEX* exports above, kept so code
// written against the `@ade-dev` packages keeps compiling.
export type { AdeBridge } from "./protocol.js";
