/**
 * Identity facts shared by every ADE surface that presents an ACP provider.
 * Provider-specific setup prose stays in the Settings descriptor, while ids,
 * labels, login commands, and config-home names have one owner.
 */

export const ACP_PROVIDER_IDS = ["qwen", "kimi", "grok", "copilot"] as const;
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

/**
 * Copilot ACP compatibility baseline validated against the live CLI.
 *
 * ACP is still a public preview in Copilot CLI, so this is a tested baseline
 * rather than a promise that every future vendor release is wire-compatible.
 */
export const COPILOT_ACP_COMPATIBILITY_BASELINE = "1.0.86" as const;
export const COPILOT_NPM_PACKAGE_SPEC = `@github/copilot@${COPILOT_ACP_COMPATIBILITY_BASELINE}` as const;

export type AcpProviderMetadata = {
  readonly label: string;
  readonly statusLabel: string;
  readonly loginCommand: string;
  readonly loginHint: string;
  readonly configHomeEnv: string | null;
};

export const ACP_PROVIDER_METADATA: Readonly<Record<AcpProviderId, AcpProviderMetadata>> = {
  qwen: {
    label: "Qwen Code",
    statusLabel: "Qwen",
    loginCommand: "qwen --auth-type=openai",
    loginHint: "configure Qwen Code (`qwen --auth-type=openai` or OPENAI_API_KEY / OPENAI_BASE_URL)",
    configHomeEnv: "QWEN_HOME",
  },
  kimi: {
    label: "Kimi",
    statusLabel: "Kimi",
    loginCommand: "kimi login",
    loginHint: "kimi login (--region global or mainland-cn)",
    configHomeEnv: "KIMI_CODE_HOME",
  },
  grok: {
    label: "Grok",
    statusLabel: "Grok",
    loginCommand: "grok login",
    loginHint: "grok login or set XAI_API_KEY",
    configHomeEnv: "GROK_HOME",
  },
  copilot: {
    label: "GitHub Copilot",
    statusLabel: "GitHub Copilot",
    loginCommand: "copilot login",
    loginHint: "copilot login",
    configHomeEnv: "COPILOT_HOME",
  },
};
