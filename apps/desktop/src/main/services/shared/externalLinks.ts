/**
 * Re-export only. `openExternalUrl` has no Electron dependency of its own — it
 * shells out to the OS opener and reaches for `electron.shell` lazily, exactly
 * so the CLI can bundle it — so it lives in `apps/ade-cli/src/lib` with the
 * rest of the dual-runtime helpers. This file keeps the desktop's existing
 * import path working.
 */
export { normalizeExternalUrl, openExternalUrl } from "../../../../../ade-cli/src/lib/externalLinks";
