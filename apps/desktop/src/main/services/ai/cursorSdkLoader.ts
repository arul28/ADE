import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as CursorSdkModuleTypes from "@cursor/sdk";
import {
  CURSOR_WINDOWS_ARM_BLOCKER,
  isCursorProviderSupported,
} from "../../../shared/providerPlatformSupport";

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

/**
 * Error code stamped on the win32-arm64 platform-gate failure so callers can
 * tell it apart from a genuine runtime error and treat it like an unusable SDK
 * module rather than a transient fault.
 */
export const CURSOR_SDK_UNSUPPORTED_PLATFORM_CODE = "ADE_CURSOR_SDK_UNSUPPORTED_PLATFORM";

export function isCursorSdkResolutionError(error: unknown): boolean {
  const message = errorText(error);
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  // A platform with no @cursor/sdk build is the same situation as a missing
  // module for every caller: the SDK cannot be used, so do not fall back to
  // network discovery and advertise models that no chat could ever run.
  if (code === CURSOR_SDK_UNSUPPORTED_PLATFORM_CODE) return true;
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

/**
 * Backstop for the platform gate. Settings restored from an x64 machine, a
 * persisted default model, or a deep link can still name Cursor on a host where
 * the provider was filtered out of every picker. Those paths reach the SDK
 * directly, so fail here with the same explanation the UI would have given
 * rather than an opaque ERR_MODULE_NOT_FOUND from deep inside the import.
 */
export function assertCursorSdkSupportedOnThisPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): void {
  if (isCursorProviderSupported(platform, arch)) return;
  const error = new Error(CURSOR_WINDOWS_ARM_BLOCKER);
  (error as { code?: string }).code = CURSOR_SDK_UNSUPPORTED_PLATFORM_CODE;
  throw error;
}

export async function loadCursorSdk(): Promise<CursorSdkModule> {
  assertCursorSdkSupportedOnThisPlatform();
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
