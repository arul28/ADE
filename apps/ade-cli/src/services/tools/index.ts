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
 * Consumers:
 *   - `cacheLookup.ts` is the single entry point the three desktop executable
 *     resolvers call before their bundled-node_modules probe.
 *   - `ade tools status|ensure|gc` (commands/tools.ts).
 *   - `ade serve` fires a background ensure at startup (cli.ts).
 *   - The desktop app kicks a coalesced ensure on packaged launch
 *     (services/tools/agentToolsCacheService.ts).
 *
 * See docs/features/onboarding-and-settings/agent-tools-cache.md.
 */
export { ToolError, isToolError, type ToolErrorKind, type ToolErrorContext } from "./errors";
export { cachedToolEntryPath, lookupCachedTool } from "./cacheLookup";
export {
  type BackgroundToolsFetchDeps,
  startBackgroundAgentToolsFetch,
} from "./backgroundFetch";
export {
  TOOL_TARGETS,
  TOOL_INSTALL_SENTINEL,
  type ToolTarget,
  detectToolTarget,
  isToolTarget,
  normalizeToolArch,
  resolveMachineToolsRoot,
  toolPackageDir,
  toolVersionDir,
  toolSentinelPath,
} from "./paths";
export {
  TOOLS_MANIFEST_SCHEMA_VERSION,
  type ToolEntry,
  type ToolPin,
  type ToolTargetPin,
  type ToolsManifest,
  entryPathForPlatform,
  findToolPin,
  findToolTargetPin,
  loadToolsManifest,
  parseToolsManifest,
} from "./manifest";
export {
  type ToolDownloader,
  type ToolDownloadOptions,
  type ToolDownloadResult,
  downloadToolTarball,
  fileIntegrity,
} from "./download";
export { type ToolExtractor, extractNpmTarball } from "./extract";
export {
  type FreeSpaceReader,
  estimateToolRequiredBytes,
  readFreeBytes,
} from "./diskSpace";
export { acquireToolLock, type ToolLockAcquisition, type ToolLockOptions } from "./lock";
export {
  type EnsureToolsOptions,
  type GcToolsOptions,
  type GcToolsResult,
  type ToolProgress,
  type ToolProgressPhase,
  type ToolResolution,
  type ToolsContext,
  ensureTools,
  gcTools,
  listPinnedTools,
  resolveTool,
  tryResolveTool,
} from "./install";
