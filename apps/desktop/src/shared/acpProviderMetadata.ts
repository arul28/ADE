/**
 * Identity facts shared by every ADE surface that presents an ACP provider.
 * Provider-specific setup prose stays in the Settings descriptor, while ids,
 * labels, login commands, and config-home names have one owner. ADE runs its own
 * pinned copy of every agent (see docs/features/onboarding-and-settings/agent-tools-cache.md), so there
 * is no install source here.
 */

export const ACP_PROVIDER_IDS = ["qwen", "kimi", "grok", "devin", "antigravity"] as const;
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

export type AcpProviderMetadata = {
  readonly label: string;
  readonly statusLabel: string;
  /**
   * Terminal command that signs the agent in, or `null` for an agent whose
   * only sign-in is the ACP `authenticate` request (Antigravity). ADE runs
   * that one itself from Settings; there is no terminal to open.
   */
  readonly loginCommand: string | null;
  readonly loginHint: string;
  readonly configHomeEnv: string | null;
};

export const ACP_PROVIDER_METADATA: Readonly<Record<AcpProviderId, AcpProviderMetadata>> = {
  qwen: {
    label: "Qwen Code",
    statusLabel: "Qwen",
    loginCommand: "qwen --auth-type=openai",
    loginHint: "configure Qwen Code (`qwen --auth-type=openai` or `qwen --auth-type=openai-responses`, or OPENAI_API_KEY / OPENAI_BASE_URL)",
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
  devin: {
    label: "Devin",
    statusLabel: "Devin",
    loginCommand: "devin auth login",
    loginHint: "devin auth login or set WINDSURF_API_KEY",
    configHomeEnv: null,
  },
  antigravity: {
    label: "Antigravity",
    statusLabel: "Antigravity",
    loginCommand: null,
    loginHint: "sign in from Settings > Providers > Antigravity (Google account, Gemini Enterprise, Gemini API key, or Agent Platform)",
    // GEMINI_HOME names the parent of the agent's own `antigravity-acp/`
    // directory; ADE leaves it at the default so the login is shared.
    configHomeEnv: "GEMINI_HOME",
  },
};
