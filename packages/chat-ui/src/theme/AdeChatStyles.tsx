/**
 * Renders the package stylesheet once per document.
 *
 * `<DaexChat>` mounts this automatically. Hosts assembling the components
 * themselves render it once near the root, or call `injectDaexChatStyles()`.
 */

import { useEffect } from "react";

import { injectDaexChatStyles } from "./styles";

export type DaexChatStylesProps = {
  /** CSP nonce for the injected `<style>`. See `InjectDaexChatStylesOptions`. */
  nonce?: string;
};

export function DaexChatStyles({ nonce }: DaexChatStylesProps = {}) {
  // Effect rather than render output: two mounted chats must not emit two
  // copies of the sheet, and injection is idempotent by element id.
  useEffect(() => {
    injectDaexChatStyles(undefined, nonce ? { nonce } : {});
  }, [nonce]);
  return null;
}

// Pre-Daex names, kept as deprecated aliases so code written against the
// `@ade-dev` packages keeps compiling. Remove them in a future major version.
/** @deprecated Use {@link DaexChatStyles}. */
export const AdeChatStyles = DaexChatStyles;
/** @deprecated Use {@link DaexChatStylesProps}. */
export type AdeChatStylesProps = DaexChatStylesProps;
