/**
 * OpenCode's own services, as ADE names and connects them.
 *
 * OpenCode 2.0 calls its model service "OpenCode Console"; users know it as
 * Zen, and the Console is only the account behind it. OpenCode Go has no
 * sign-in of its own: it comes with the opencode.ai account sign-in on the
 * `opencode` provider (`opencode auth login opencode`).
 */

export const OPENCODE_HOUSE_PROVIDER_IDS = ["opencode", "opencode-go"] as const;

export type OpenCodeHouseProviderId = (typeof OPENCODE_HOUSE_PROVIDER_IDS)[number];

const OPENCODE_HOUSE_PROVIDER_NAMES: Record<OpenCodeHouseProviderId, string> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};

/** The provider whose sign-in a provider uses, when it has none of its own. */
const OPENCODE_SIGN_IN_VIA: Partial<Record<string, OpenCodeHouseProviderId>> = {
  "opencode-go": "opencode",
};

export function isOpenCodeHouseProvider(providerId: string): providerId is OpenCodeHouseProviderId {
  return (OPENCODE_HOUSE_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** ADE's name for an OpenCode provider: a house service's own name, else OpenCode's. */
export function openCodeProviderDisplayName(providerId: string, openCodeName: string): string {
  return isOpenCodeHouseProvider(providerId) ? OPENCODE_HOUSE_PROVIDER_NAMES[providerId] : openCodeName;
}

/** ADE's name for a house service, or null for any other provider. */
export function openCodeHouseProviderName(providerId: string): string | null {
  return isOpenCodeHouseProvider(providerId) ? OPENCODE_HOUSE_PROVIDER_NAMES[providerId] : null;
}

/** The provider to sign in through, or null when a provider signs in itself. */
export function openCodeSignInViaProvider(providerId: string): OpenCodeHouseProviderId | null {
  return OPENCODE_SIGN_IN_VIA[providerId] ?? null;
}
