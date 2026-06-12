import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as CursorSdkModuleTypes from "@cursor/sdk";

export type CursorSdkModule = typeof CursorSdkModuleTypes;

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

let sdkModule: CursorSdkModule | null = null;
let sdkModulePromise: Promise<CursorSdkModule> | null = null;

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function isCursorSdkResolutionError(error: unknown): boolean {
  const message = errorText(error);
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "ERR_MODULE_NOT_FOUND"
    || code === "MODULE_NOT_FOUND"
    || /Cannot find package ['"]@cursor\/sdk['"]/i.test(message)
    || /Cannot find module ['"]@cursor\/sdk['"]/i.test(message);
}

function loadCursorSdkWithRequire(originalError: unknown): CursorSdkModule {
  try {
    return requireFromRuntime("@cursor/sdk") as CursorSdkModule;
  } catch (fallbackError) {
    const error = new Error(
      `Failed to load @cursor/sdk via dynamic import or packaged runtime resolution. import=${errorText(originalError)} require=${errorText(fallbackError)}`,
    );
    (error as { cause?: unknown }).cause = originalError;
    throw error;
  }
}

export async function loadCursorSdk(): Promise<CursorSdkModule> {
  if (sdkModule) return sdkModule;
  if (!sdkModulePromise) {
    sdkModulePromise = import("@cursor/sdk")
      .catch((error) => {
        if (!isCursorSdkResolutionError(error)) throw error;
        return loadCursorSdkWithRequire(error);
      })
      .then((loaded) => {
        sdkModule = loaded;
        return loaded;
      })
      .catch((error) => {
        sdkModulePromise = null;
        throw error;
      });
  }
  return sdkModulePromise;
}

export function resetCursorSdkLoaderForTests(): void {
  sdkModule = null;
  sdkModulePromise = null;
}
