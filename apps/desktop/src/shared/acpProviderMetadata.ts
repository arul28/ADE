/**
 * Identity facts shared by every ADE surface that presents an ACP provider.
 * Provider-specific setup prose stays in the Settings descriptor, while ids,
 * labels, login commands, install sources, and config-home names have one owner.
 */

export const ACP_PROVIDER_IDS = ["qwen", "kimi", "grok", "copilot", "devin"] as const;
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

/**
 * Where a provider's CLI comes from, unversioned.
 *
 * ADE runs whatever CLI the user has installed, so an install command fetches
 * the latest release rather than pinning a version. `npm` carries the bare
 * package name because the CLI registry wraps it for its own shell; `script`
 * is the vendor's own installer, already a shell command.
 */
export type AcpProviderInstallSource =
  | { readonly kind: "npm"; readonly packageName: string }
  | { readonly kind: "script"; readonly command: string };

/** The plain command a desktop surface shows for a provider's install source. */
export function acpInstallDisplayCommand(source: AcpProviderInstallSource): string {
  return source.kind === "npm" ? `npm install -g ${source.packageName}` : source.command;
}

export type AcpProviderMetadata = {
  readonly label: string;
  readonly statusLabel: string;
  readonly loginCommand: string;
  readonly loginHint: string;
  readonly configHomeEnv: string | null;
  readonly install: AcpProviderInstallSource;
};

export const ACP_PROVIDER_METADATA: Readonly<Record<AcpProviderId, AcpProviderMetadata>> = {
  qwen: {
    label: "Qwen Code",
    statusLabel: "Qwen",
    loginCommand: "qwen --auth-type=openai",
    loginHint: "configure Qwen Code (`qwen --auth-type=openai` or `qwen --auth-type=openai-responses`, or OPENAI_API_KEY / OPENAI_BASE_URL)",
    configHomeEnv: "QWEN_HOME",
    install: { kind: "npm", packageName: "@qwen-code/qwen-code" },
  },
  kimi: {
    label: "Kimi",
    statusLabel: "Kimi",
    loginCommand: "kimi login",
    loginHint: "kimi login (--region global or mainland-cn)",
    configHomeEnv: "KIMI_CODE_HOME",
    install: { kind: "script", command: "curl -LsSf https://code.kimi.com/kimi-code/install.sh | bash" },
  },
  grok: {
    label: "Grok",
    statusLabel: "Grok",
    loginCommand: "grok login",
    loginHint: "grok login or set XAI_API_KEY",
    configHomeEnv: "GROK_HOME",
    install: { kind: "npm", packageName: "@xai-official/grok" },
  },
  copilot: {
    label: "GitHub Copilot",
    statusLabel: "GitHub Copilot",
    loginCommand: "copilot login",
    loginHint: "copilot login",
    configHomeEnv: "COPILOT_HOME",
    install: { kind: "npm", packageName: "@github/copilot" },
  },
  devin: {
    label: "Devin",
    statusLabel: "Devin",
    loginCommand: "devin auth login",
    loginHint: "devin auth login or set WINDSURF_API_KEY",
    configHomeEnv: null,
    install: { kind: "script", command: "curl -fsSL https://cli.devin.ai/install.sh | bash" },
  },
};
