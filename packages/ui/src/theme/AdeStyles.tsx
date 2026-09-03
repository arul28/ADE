/**
 * Renders the kit stylesheet once per document.
 *
 * A plugin page mounts this near its root, or calls `injectAdeStyles()` at
 * startup. The desktop app renders neither: it has Tailwind.
 */

import { useEffect } from "react";

import { injectAdeStyles } from "./styles";

export function AdeStyles() {
  // Effect rather than render output: two mounted surfaces must not emit two
  // copies of the sheet, and injection is idempotent by element id.
  useEffect(() => {
    injectAdeStyles();
  }, []);
  return null;
}
