/**
 * Canonical provider colors for every desktop surface.
 *
 * Keep role-specific colors together here: usage bars need a light/dark pair,
 * picker badges need one token, and model descriptors have a few provider
 * variants. Consumers should select a value from this table rather than grow a
 * second hex map that can drift from the iOS mirror.
 */
export type ProviderColorPair = { light: string; dark: string };

export const PROVIDER_COLOR_TABLE = {
  usage: {
    claude: { light: "#C15F3C", dark: "#D97757" },
    anthropic: { light: "#C15F3C", dark: "#D97757" },
    codex: { light: "#0F9E8E", dark: "#2DD4BF" },
    openai: { light: "#0F9E8E", dark: "#2DD4BF" },
    cursor: { light: "#52627A", dark: "#93A6C4" },
    "cursor-agent": { light: "#52627A", dark: "#93A6C4" },
    copilot: { light: "#2DA44E", dark: "#3FB950" },
    gemini: { light: "#2C6FE0", dark: "#5B93F5" },
    google: { light: "#2C6FE0", dark: "#5B93F5" },
    droid: { light: "#B45309", dark: "#E0A82E" },
    opencode: { light: "#7C5CE0", dark: "#A78BFA" },
    deepseek: { light: "#3A54D6", dark: "#6C86FF" },
    mistral: { light: "#E05A00", dark: "#FF7A1A" },
    ollama: { light: "#6B7280", dark: "#A1A1AA" },
    lmstudio: { light: "#6D28D9", dark: "#9F7BEA" },
    openrouter: { light: "#0284C7", dark: "#38BDF8" },
    openclaw: { light: "#B45309", dark: "#E0A82E" },
    xai: { light: "#3F3F46", dark: "#B4B4BD" },
    grok: { light: "#3F3F46", dark: "#B4B4BD" },
  },
  usageFallback: [
    { light: "#2563EB", dark: "#60A5FA" },
    { light: "#0F766E", dark: "#2DD4BF" },
    { light: "#B45309", dark: "#E0A82E" },
    { light: "#7C5CE0", dark: "#A78BFA" },
    { light: "#BE185D", dark: "#F472B6" },
    { light: "#4D7C0F", dark: "#A3E635" },
  ],
  badge: {
    opencode: "#2563EB",
    anthropic: "#D97706",
    openai: "#10A37F",
    "openai-codex": "#22B88A",
    cursor: "#A78BFA",
    factory: "#6B7280",
    pi: "#F97316",
    google: "#F59E0B",
    "github-copilot": "#8B5CF6",
    deepseek: "#3B82F6",
    mistral: "#F97316",
    xai: "#DC2626",
    openrouter: "#6B7280",
    ollama: "#71717A",
    lmstudio: "#64748B",
    groq: "#06B6D4",
    together: "#22C55E",
    meta: "#3B82F6",
    qwen: "#6D4AFF",
    moonshot: "#1F1F1F",
  },
  group: {
    claude: "#D97757",
    codex: "#2DD4BF",
    cursor: "#93A6C4",
    droid: "#E0A82E",
    pi: "#F97316",
    qwen: "#6D4AFF",
    kimi: "#1F1F1F",
    grok: "#B4B4BD",
    copilot: "#3FB950",
    opencode: "#A78BFA",
    ollama: "#A1A1AA",
    lmstudio: "#9F7BEA",
  },
  chat: {
    claude: "#D97706",
    anthropic: "#D97706",
    codex: "#E7E5E4",
    openai: "#E7E5E4",
    cursor: "#13120C",
    droid: "#D46C2E",
    factory: "#D46C2E",
    opencode: "#739CEE",
    pi: "#181C25",
    google: "#F59E0B",
    gemini: "#F59E0B",
    mistral: "#F97316",
    deepseek: "#3B82F6",
    xai: "#DC2626",
    grok: "#DC2626",
    groq: "#06B6D4",
  },
  localModel: {
    ollama: "#71717A",
    lmstudio: "#64748B",
  },
  openCodeProvider: {
    anthropic: "#D97706",
    openai: "#10A37F",
    google: "#F59E0B",
    mistral: "#F97316",
    deepseek: "#3B82F6",
    xai: "#DC2626",
    openrouter: "#6B7280",
    ollama: "#71717A",
    lmstudio: "#64748B",
    groq: "#06B6D4",
    together: "#22C55E",
  },
  acp: {
    qwen: "#6D4AFF",
    kimi: "#1F1F1F",
    grok: "#DC2626",
    copilot: "#8B5CF6",
  },
  dynamic: {
    pi: "#181C25",
    openCodeFallback: "#2563EB",
    cursor: {
      auto: "#A78BFA",
      anthropic: "#D97706",
      composer: "#8B5CF6",
      google: "#4285F4",
      grok: "#1DA1F2",
      openai: "#10A37F",
      fallback: "#71717A",
    },
    droid: {
      anthropic: "#D97706",
      google: "#4285F4",
      openai: "#10A37F",
      fallback: "#71717A",
    },
  },
  ios: {
    claude: "#D97757",
    codex: "#2DD4BF",
    pi: "#F97316",
    cursor: "#93A6C4",
    opencode: "#A78BFA",
    google: "#5B93F5",
    mistral: "#FF7A1A",
    deepseek: "#6C86FF",
    xai: "#B4B4BD",
    groq: "#06B6D4",
    cto: "#C4B5FD",
    qwen: "#6D4AFF",
    kimi: "#1F1F1F",
    copilot: "#3FB950",
  },
  defaults: {
    badge: "#A78BFA",
    emptyOpenCodeBadge: "#6B7280",
  },
} as const;

export const PROVIDER_USAGE_COLORS: Record<string, ProviderColorPair> = PROVIDER_COLOR_TABLE.usage;
export const PROVIDER_USAGE_FALLBACK_PALETTE = PROVIDER_COLOR_TABLE.usageFallback;
export const PROVIDER_BADGE_COLORS = PROVIDER_COLOR_TABLE.badge;
export const PROVIDER_GROUP_COLORS = PROVIDER_COLOR_TABLE.group;
export const PROVIDER_CHAT_ACCENTS = PROVIDER_COLOR_TABLE.chat;
export const LOCAL_PROVIDER_MODEL_COLORS = PROVIDER_COLOR_TABLE.localModel;
export const OPENCODE_PROVIDER_MODEL_COLORS: Record<string, string> = PROVIDER_COLOR_TABLE.openCodeProvider;
export const ACP_PROVIDER_MODEL_COLORS = PROVIDER_COLOR_TABLE.acp;
export const DYNAMIC_MODEL_COLORS = PROVIDER_COLOR_TABLE.dynamic;
export const PROVIDER_IOS_COLORS = PROVIDER_COLOR_TABLE.ios;
export const PROVIDER_BADGE_FALLBACK_COLOR = PROVIDER_COLOR_TABLE.defaults.badge;
export const EMPTY_OPENCODE_BADGE_FALLBACK_COLOR = PROVIDER_COLOR_TABLE.defaults.emptyOpenCodeBadge;
