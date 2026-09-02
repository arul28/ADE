/**
 * Identity facts shared by every ADE surface that presents an ACP provider.
 * Provider-specific setup prose stays in the Settings descriptor, while ids,
 * labels, login commands, and config-home names have one owner.
 */

export const ACP_PROVIDER_IDS = ["qwen", "kimi", "grok", "copilot"] as const;
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

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
    configHomeEnv: null,
  },
  copilot: {
    label: "GitHub Copilot",
    statusLabel: "GitHub Copilot",
    loginCommand: "copilot login",
    loginHint: "copilot login",
    configHomeEnv: "COPILOT_HOME",
  },
};
