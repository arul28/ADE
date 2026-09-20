import {
  formatPiProviderLabel,
  usesCodexNamedEffortLabels,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../shared/modelRegistry";

/**
 * What a model IS, in the words a person would use.
 *
 * Every fact here is stated on at least two surfaces — the picker row's detail
 * line and the CTO's model card — so it lives in one pure module rather than
 * being formatted twice. Nothing in here renders.
 */
export const PROVIDER_LABELS: Partial<Record<ProviderFamily, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  opencode: "OpenCode",
  google: "Google",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "Grok",
  groq: "Groq",
  together: "Together",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  cursor: "Cursor",
  factory: "Droid",
  pi: "Pi",
  qwen: "Qwen",
  moonshot: "Kimi",
  "github-copilot": "GitHub Copilot",
};

export function providerLabel(family: ProviderFamily | string): string {
  return PROVIDER_LABELS[family as ProviderFamily] ?? family;
}

/**
 * Pi routing, by both of the marks it leaves.
 *
 * `providerRoute` alone was not enough: dynamic Pi descriptors carry a `pi/`
 * id without always carrying the route, so a rail that grouped by this and a
 * detail line that grouped by the route disagreed about the same model.
 */
export function isPiRoutedModel(model: ModelDescriptor): boolean {
  return model.providerRoute === "pi-sdk" || model.id.trim().toLowerCase().startsWith("pi/");
}

const LOCAL_FAMILIES = new Set(["ollama", "lmstudio"]);

export function isLocalModel(model: ModelDescriptor): boolean {
  return LOCAL_FAMILIES.has(model.family) || model.authTypes.includes("local");
}

/** Where the work actually happens, said plainly. */
export function runsOnLabel(model: ModelDescriptor): string {
  return isLocalModel(model) || model.isCliWrapped ? "This computer" : "The provider's servers";
}

export function subProviderLabel(model: ModelDescriptor): string | null {
  const sub = (model as ModelDescriptor & { subProvider?: string }).subProvider;
  if (typeof sub === "string" && sub.trim().length) return sub.trim();
  if (isPiRoutedModel(model) && model.piProviderId) {
    const label = formatPiProviderLabel(model.piProviderId);
    const profile = model.piProfileId?.trim();
    return profile && profile !== "default" ? `${label} · ${profile}` : label;
  }
  if (model.providerRoute === "opencode" && model.openCodeProviderId) {
    // Rows shown inside the OpenCode rail; "via OpenCode" was redundant.
    const id = model.openCodeProviderId;
    return id.charAt(0).toUpperCase() + id.slice(1);
  }
  return null;
}

/**
 * The identity behind `subProviderLabel`: same three branches, answering
 * "which group is this?" instead of "what is it called?".
 *
 * They live together because they must agree — a label without a matching key
 * puts two spellings of one provider in two groups.
 */
export function subProviderKey(model: ModelDescriptor): string {
  const key = (model as ModelDescriptor & { subProviderKey?: string }).subProviderKey;
  if (typeof key === "string" && key.trim().length) return key.trim();
  if (isPiRoutedModel(model) && model.piProviderId) {
    return `${model.piProfileId?.trim() || "default"}:${model.piProviderId}`;
  }
  if (model.providerRoute === "opencode" && model.openCodeProviderId) return model.openCodeProviderId;
  return subProviderLabel(model) || "__default__";
}

/**
 * A token count the way a person says it: "1M", "200K".
 *
 * Separate from the line below it because the card wants "1M tokens" and the
 * row wants "1M context", and neither should re-derive the number.
 */
export function formatTokenCount(tokens: number | undefined): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const text = Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace(/\.0$/, "");
    return `${text}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatContextWindow(tokens: number | undefined): string | null {
  const count = formatTokenCount(tokens);
  return count ? `${count} context` : null;
}

const REASONING_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
};

/** The effort tier as a word. "Off" is a real answer, not a missing one. */
export function reasoningEffortLabel(effort: string | null, model?: ModelDescriptor): string {
  if (!effort) return "Off";
  if (effort === "low" && usesCodexNamedEffortLabels(model?.providerModelId)) return "Light";
  return REASONING_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * The one line of detail under every model name in a picker row.
 *
 * Always present, always one line. The sub-provider used to be its own
 * optional line, which gave rows in the same list two different heights.
 */
export function modelDetailLine(model: ModelDescriptor): string {
  const parts: string[] = [];
  const family = providerLabel(model.family);
  const sub = subProviderLabel(model);
  parts.push(sub && sub.toLowerCase() !== family.toLowerCase() ? `${family} · ${sub}` : family);
  const context = formatContextWindow(model.contextWindow);
  if (context) parts.push(context);
  if (model.reasoningTiers && model.reasoningTiers.length > 0) parts.push("reasoning");
  return parts.join(" · ");
}
