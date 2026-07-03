import type {
  AgentChatModelCatalog,
  AgentChatModelCatalogRefreshProvider,
  AgentChatModelInfo,
} from "../../../desktop/src/shared/types/chat";
import type { AiSettingsStatus } from "../../../desktop/src/shared/types/config";
import type { AdeCodeInterfaceMode, AdeCodeModelState, AdeCodeProvider, ModelPickerRightPaneContent } from "./types";
import type { BuildLayoutInput } from "./components/ModelPicker/modelPickerLayout";
import { refreshProviderForModelPicker } from "./providerMetadata";

export function modelPickerRefreshProvider(provider: AdeCodeProvider): AgentChatModelCatalogRefreshProvider | null {
  return refreshProviderForModelPicker(provider);
}

export function buildModelPickerLayoutInput(args: {
  picker: ModelPickerRightPaneContent;
  models: AgentChatModelInfo[];
  catalog: AgentChatModelCatalog | null | undefined;
  favorites: string[];
  recents: string[];
  modelState: Pick<AdeCodeModelState, "modelId" | "reasoningEffort" | "interfaceMode">;
  aiStatus: AiSettingsStatus | null;
  interfaceMode?: AdeCodeInterfaceMode;
}): BuildLayoutInput {
  return {
    models: args.models,
    catalog: args.catalog,
    favorites: args.favorites,
    recents: args.recents,
    activeModelId: args.modelState.modelId,
    activeReasoningEffort: args.modelState.reasoningEffort,
    aiStatus: args.aiStatus,
    interfaceMode: args.interfaceMode ?? args.modelState.interfaceMode,
    settingsRows: args.picker.settingsRows ?? [],
    footerFocus: args.picker.footerFocus ?? null,
    laneLabel: args.picker.laneLabel ?? null,
    query: args.picker.query,
    selection: args.picker.selection,
    providerTabKey: args.picker.providerTabKey ?? null,
    focusedIndex: args.picker.focusedIndex,
    searchMode: args.picker.searchMode,
  };
}
