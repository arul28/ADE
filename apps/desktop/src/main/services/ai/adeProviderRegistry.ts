import { createProviderRegistry, customProvider, type LanguageModel } from "ai";
import type { ModelDescriptor } from "../../../shared/modelRegistry";

type CustomLanguageModels = NonNullable<Parameters<typeof customProvider>[0]["languageModels"]>;

export function resolveViaAdeProviderRegistry(
  descriptor: ModelDescriptor,
  model: LanguageModel,
): LanguageModel {
  const aliases = new Set<string>([
    descriptor.id,
    descriptor.shortId,
    descriptor.sdkModelId,
    ...(descriptor.aliases ?? []),
  ]);

  const languageModels = Object.fromEntries(
    [...aliases]
      .map((alias) => alias.trim())
      .filter(Boolean)
      .map((alias) => [alias, model as CustomLanguageModels[string]]),
  ) as CustomLanguageModels;

  const registry = createProviderRegistry({
    ade: customProvider({
      languageModels,
    }),
  });

  return registry.languageModel(`ade:${descriptor.id}`) as LanguageModel;
}
