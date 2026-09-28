/**
 * `@ade-dev/sdk/electron/global` — the type of `window.ade`.
 *
 * Types only. Import it once, for its side effect on the type checker, in any
 * file of a renderer that reads the bridge:
 *
 *   import "@ade-dev/sdk/electron/global";
 *   const client = createAdeIpcClient(window.ade);
 *
 * or list it in `tsconfig.json` `compilerOptions.types`. It declares the
 * default key only: a preload that passed `exposeAdeBridge(..., { key })`
 * with another name should declare `interface Window { <name>: AdeBridge }`
 * itself.
 *
 * The emitted JavaScript is empty, so importing it at run time costs nothing
 * and is safe under a strict CSP.
 */

import type { AdeBridge } from "./protocol.js";

declare global {
  interface Window {
    /** The bridge `exposeAdeBridge` put on `window` (default key `"ade"`). */
    ade: AdeBridge;
  }
}

export type { AdeBridge };
