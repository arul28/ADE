import type { HarnessPresetBody } from "./harnessPresets";

/**
 * The credential-store provider for each harness body.
 *
 * This is shared by launch resolution and the settings key surface so a new
 * harness cannot silently file credentials under one provider and launch them
 * from another.
 */
export const HARNESS_CREDENTIAL_STORE_PROVIDER = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
  droid: "droid",
  pi: "pi",
  opencode: "opencode",
  qwen: "qwen",
  kimi: "moonshotai",
  grok: "xai",
  copilot: "copilot",
} as const satisfies Record<HarnessPresetBody, string>;

export function credentialStoreProviderForHarness(harness: string): string {
  return HARNESS_CREDENTIAL_STORE_PROVIDER[harness as HarnessPresetBody] ?? harness;
}

/**
 * Is this string one of the ten harness bodies?
 *
 * Lives beside the table it consults so the "which harnesses exist" answer has
 * one source. Callers that used to assert `value as HarnessPresetBody` before
 * checking were asserting the very thing they were about to test.
 */
export function isHarnessPresetBody(value: string): value is HarnessPresetBody {
  return Object.prototype.hasOwnProperty.call(HARNESS_CREDENTIAL_STORE_PROVIDER, value);
}
