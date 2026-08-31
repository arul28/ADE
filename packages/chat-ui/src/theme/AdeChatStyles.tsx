/**
 * Renders the package stylesheet once per document.
 *
 * `<AdeChat>` mounts this automatically. Hosts assembling the components
 * themselves render it once near the root, or call `injectAdeChatStyles()`.
 */

import { useEffect } from "react";

import { injectAdeChatStyles } from "./styles";

export function AdeChatStyles() {
  // Effect rather than render output: two mounted chats must not emit two
  // copies of the sheet, and injection is idempotent by element id.
  useEffect(() => {
    injectAdeChatStyles();
  }, []);
  return null;
}
