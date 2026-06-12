import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as DroidSdkModuleTypes from "@factory/droid-sdk";

export type DroidSdkModule = typeof DroidSdkModuleTypes;

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

let sdkModule: DroidSdkModule | null = null;
let sdkModulePromise: Promise<DroidSdkModule> | null = null;

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function isDroidSdkResolutionError(error: unknown): boolean {
  const message = errorText(error);
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "ERR_MODULE_NOT_FOUND"
    || code === "MODULE_NOT_FOUND"
    || /Cannot find package ['"]@factory\/droid-sdk['"]/i.test(message)
    || /Cannot find module ['"]@factory\/droid-sdk['"]/i.test(message);
}

function loadDroidSdkWithRequire(originalError: unknown): DroidSdkModule {
  try {
    return requireFromRuntime("@factory/droid-sdk") as DroidSdkModule;
  } catch (fallbackError) {
    const error = new Error(
      `Failed to load @factory/droid-sdk via dynamic import or packaged runtime resolution. import=${errorText(originalError)} require=${errorText(fallbackError)}`,
    );
    (error as { cause?: unknown }).cause = originalError;
    throw error;
  }
}

export async function loadDroidSdk(): Promise<DroidSdkModule> {
  if (sdkModule) return sdkModule;
  if (!sdkModulePromise) {
    sdkModulePromise = import("@factory/droid-sdk")
      .catch((error) => {
        if (!isDroidSdkResolutionError(error)) throw error;
        return loadDroidSdkWithRequire(error);
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

export function resetDroidSdkLoaderForTests(): void {
  sdkModule = null;
  sdkModulePromise = null;
}
