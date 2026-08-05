/**
 * Pinned agent-tools distribution.
 *
 * ADE used to vendor the agent CLI platform packages (codex, the Claude agent
 * SDK's native binary, opencode) inside both the desktop app and the brain
 * runtime tarball — roughly 650 MB unpacked per target. This module fetches
 * them on demand instead: a generated manifest pins the exact npm version and
 * sha512 for every supported target, and the fetcher downloads them straight
 * from the registry into a machine-level, version-addressed cache that the
 * desktop app, the brain, and every channel share.
 *
 * Consumption:
 *
 *   const codex = resolveTool("codex");          // throws kind:"not-installed"
 *   const codex = tryResolveTool("codex");       // or null
 *   await ensureTools(["codex"], { onProgress }) // fetch what is missing
 *   await gcTools();                             // drop superseded versions
 *
 * This barrel is deliberately narrow: it exports only what is consumed from
 * *outside* this directory. It is not the resolver entry point — the three
 * desktop executable resolvers deep-import `./cacheLookup` directly (as does
 * `ade serve` for `./backgroundFetch`), and modules inside this directory
 * import each other by deep path. Adding a re-export here is a decision to
 * widen the module's public surface, not a convenience.
 *
 * Consumers:
 *   - `cacheLookup.ts` (deep import) is the single entry point the three
 *     desktop executable resolvers call before their bundled-node_modules probe.
 *   - `ade tools status|ensure|gc` (commands/tools.ts).
 *   - `ade serve` fires a background ensure at startup via a deep import of
 *     `backgroundFetch.ts` (cli.ts).
 *   - The desktop app kicks a coalesced ensure on packaged launch
 *     (services/tools/agentToolsCacheService.ts).
 *
 * See docs/features/onboarding-and-settings/agent-tools-cache.md.
 */
export { ToolError, isToolError } from "./errors";
export { TOOL_INSTALL_SENTINEL, resolveMachineToolsRoot } from "./paths";
export { findToolTargetPin, loadToolsManifest } from "./manifest";
export {
  type ToolProgress,
  type ToolResolution,
  ensureTools,
  gcTools,
  listPinnedTools,
  tryResolveTool,
} from "./install";
