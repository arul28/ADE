import type * as CopilotSdkTypes from "@github/copilot-sdk";

let cached: Promise<typeof CopilotSdkTypes> | null = null;

/** Load the SDK only in its worker so Vite/renderer and the main entry stay lean. */
export function loadCopilotSdk(): Promise<typeof CopilotSdkTypes> {
  cached ??= import("@github/copilot-sdk").catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

