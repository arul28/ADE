import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as ClaudeSdkModuleTypes from "@anthropic-ai/claude-agent-sdk";

/**
 * The Claude Agent SDK, loaded on first use.
 *
 * A static import loaded it in every brain at start, with or without a Claude
 * chat: about 5 MB of heap, 1.3 MB of external memory and about 25 MB of RSS
 * (Node bench), and about 50 ms to load. A Claude chat loads it before its
 * first query, and a draft prewarm (the first character typed in a new draft)
 * loads it before `startup()`, so the first send after typing is not slower.
 */
export type ClaudeSdkModule = typeof ClaudeSdkModuleTypes;

const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

let sdkModule: ClaudeSdkModule | null = null;
let sdkModulePromise: Promise<ClaudeSdkModule> | null = null;

function isClaudeSdkResolutionError(error: unknown): boolean {
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * The packaged CLI finds its external packages through NODE_PATH, which an
 * ESM `import()` does not read; `require` does, and it is how the bundle
 * loaded the SDK before.
 */
function requireClaudeSdk(): ClaudeSdkModule {
  return requireFromRuntime(CLAUDE_SDK_PACKAGE) as ClaudeSdkModule;
}

export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (sdkModule) return sdkModule;
  if (!sdkModulePromise) {
    sdkModulePromise = import("@anthropic-ai/claude-agent-sdk")
      .then((loaded): ClaudeSdkModule => loaded)
      .catch((error: unknown) => {
        if (!isClaudeSdkResolutionError(error)) throw error;
        return requireClaudeSdk();
      })
      .then((loaded) => {
        sdkModule = loaded;
        return loaded;
      })
      .catch((error: unknown) => {
        sdkModulePromise = null;
        throw error;
      });
  }
  return await sdkModulePromise;
}

/** The SDK when it is already loaded, else null. Lets a hot path skip an await. */
export function claudeSdkIfLoaded(): ClaudeSdkModule | null {
  return sdkModule;
}

/**
 * The SDK for synchronous code. Every Claude query path awaits
 * {@link loadClaudeSdk} first, so this normally returns the loaded module;
 * when it was not loaded yet, it loads it now.
 */
export function loadedClaudeSdk(): ClaudeSdkModule {
  sdkModule ??= requireClaudeSdk();
  return sdkModule;
}
