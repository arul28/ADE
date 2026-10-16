import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { CopilotSdkPooled } from "./copilotSdkPool";

type CopilotModel = {
  id?: unknown;
  name?: unknown;
  policy?: { state?: unknown };
  capabilities?: { supports?: { vision?: unknown; reasoningEffort?: unknown }; limits?: { max_context_window_tokens?: unknown; max_output_tokens?: unknown; max_prompt_tokens?: unknown } };
  supportedReasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
  billing?: { multiplier?: unknown };
  supportedContextTiers?: unknown;
};

export function copilotSdkModelDescriptors(models: readonly unknown[]): ModelDescriptor[] {
  const rows: ModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const value of models) {
    if (!value || typeof value !== "object") continue;
    const model = value as CopilotModel;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id) || model.policy?.state === "disabled") continue;
    seen.add(id);
    const context = model.capabilities?.limits?.max_context_window_tokens;
    const output = model.capabilities?.limits?.max_output_tokens;
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === "string")
      : [];
    rows.push({
      id: `github-copilot/${id}`,
      shortId: id,
      displayName: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id,
      family: "github-copilot",
      authTypes: ["cli-subscription"],
      contextWindow: typeof context === "number" && context > 0 ? context : 128_000,
      maxOutputTokens: typeof output === "number" && output > 0 ? output : 32_000,
      capabilities: { tools: true, vision: model.capabilities?.supports?.vision === true, reasoning: efforts.length > 0, streaming: true },
      ...(efforts.length ? { reasoningTiers: efforts } : {}),
      ...(typeof model.defaultReasoningEffort === "string" ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      ...(Array.isArray(model.supportedContextTiers) ? { supportedContextTiers: model.supportedContextTiers.filter((tier): tier is string => typeof tier === "string") } : {}),
      ...(typeof model.billing?.multiplier === "number" ? { billingMultiplier: model.billing.multiplier } : {}),
      color: "#8250df",
      providerRoute: "copilot-sdk",
      providerModelId: id,
      cliCommand: "copilot",
      isCliWrapped: false,
    } as ModelDescriptor);
  }
  if (rows.length === 0) {
    rows.push({
      id: "github-copilot/auto",
      shortId: "auto",
      displayName: "Auto",
      family: "github-copilot",
      authTypes: ["cli-subscription"],
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
      color: "#8250df",
      providerRoute: "copilot-sdk",
      providerModelId: "auto",
      cliCommand: "copilot",
      isCliWrapped: false,
    } as ModelDescriptor);
  }
  return rows;
}

export async function discoverCopilotSdkModelDescriptors(sdk: CopilotSdkPooled): Promise<ModelDescriptor[]> {
  return copilotSdkModelDescriptors(await sdk.request<unknown[]>("models"));
}

