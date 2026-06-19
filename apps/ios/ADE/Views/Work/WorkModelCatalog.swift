import Foundation
import SwiftUI

/// A single model entry that can be displayed in the mobile model picker.
/// Mirrors a subset of the desktop `ModelDescriptor` — the mobile picker
/// doesn't need pricing/tier/reasoning metadata yet, just enough to render a
/// branded row (logo + display name + tier hint) and send a `modelId` to
/// `SyncService.updateChatSession`.
struct WorkModelOption: Identifiable, Hashable {
  /// Stable sync-contract id the host accepts (e.g. "claude-opus-4-8").
  let id: String
  let displayName: String
  let tier: Tier
  /// Short one-line pitch — "Fastest · cheapest" / "Best for deep reasoning".
  let tagline: String
  /// Provider family key that maps to a `providerAssetName` logo + tint
  /// (e.g. "claude" for the CLAUDE brand avatar). For OpenCode-routed
  /// models this is still the upstream family so the logo stays brand-true.
  let provider: String
  /// Reasoning efforts supplied by the paired desktop host. Empty means the
  /// host did not advertise a selectable reasoning control for this model.
  let reasoningEfforts: [AgentChatModelReasoningEffort]
  let serviceTiers: [String]
  let cursorAvailability: CursorModelAvailability?
  let isAvailable: Bool

  init(
    id: String,
    displayName: String,
    tier: Tier,
    tagline: String,
    provider: String,
    reasoningEfforts: [AgentChatModelReasoningEffort] = [],
    serviceTiers: [String] = [],
    cursorAvailability: CursorModelAvailability? = nil,
    isAvailable: Bool = true
  ) {
    self.id = id
    self.displayName = displayName
    self.tier = tier
    self.tagline = tagline
    self.provider = provider
    self.reasoningEfforts = reasoningEfforts
    self.serviceTiers = serviceTiers
    self.cursorAvailability = cursorAvailability
    self.isAvailable = isAvailable
  }
}

extension WorkModelOption {
  enum Tier: String { case fast, balanced, flagship, reasoning }

  func supportsServiceTier(_ tier: String) -> Bool {
    let needle = tier.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return false }
    return serviceTiers.contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == needle }
  }

  var supportsCodexFastMode: Bool { supportsServiceTier("fast") }
}

enum WorkCursorAvailabilityMode {
  case chat
  case cli
}

func workModelSupportsCursorAvailabilityMode(
  _ model: WorkModelOption,
  mode: WorkCursorAvailabilityMode
) -> Bool {
  guard let availability = model.cursorAvailability else { return true }
  switch mode {
  case .chat:
    return availability.sdk
  case .cli:
    return availability.cli
  }
}

func workAgentChatModelSupportsCursorAvailabilityMode(
  _ model: AgentChatModelInfo,
  mode: WorkCursorAvailabilityMode
) -> Bool {
  guard let availability = model.cursorAvailability else { return true }
  switch mode {
  case .chat:
    return availability.sdk
  case .cli:
    return availability.cli
  }
}

func workFilterChatModelsForCursorAvailability(
  _ models: [AgentChatModelInfo],
  mode: WorkCursorAvailabilityMode
) -> [AgentChatModelInfo] {
  models.filter { workAgentChatModelSupportsCursorAvailabilityMode($0, mode: mode) }
}

/// Maps a picked model to the tracked CLI runtime provider, mirroring desktop
/// `resolveCliProviderForModel` + `resolveProviderGroupForModel`.
func workResolveCliProvider(for modelId: String, provider: String) -> String {
  switch workModelCatalogGroupKey(for: modelId, currentProvider: provider) {
  case "claude": return "claude"
  case "codex": return "codex"
  case "cursor": return "cursor"
  case "droid": return "droid"
  default: return "opencode"
  }
}

func workModelAllowedForAvailabilityMode(
  modelId: String,
  provider: String,
  mode: WorkCursorAvailabilityMode
) -> Bool {
  let groups = workFilterCatalogForCursorAvailability(
    workModelCatalogGroups(currentModelId: modelId, currentProvider: provider),
    mode: mode
  )
  return groups.contains { group in
    group.providers.contains { providerEntry in
      providerEntry.models.contains { workModelIdsEquivalent($0.id, modelId) }
    }
  }
}

func workDefaultModelIdForAvailabilityMode(
  preferredProvider: String,
  mode: WorkCursorAvailabilityMode
) -> (modelId: String, provider: String)? {
  let family = providerFamilyKey(preferredProvider)
  let filtered = workFilterCatalogForCursorAvailability(workCuratedModelCatalogGroups(), mode: mode)
  if let match = filtered.first(where: { $0.key == family })?
    .providers
    .flatMap(\.models)
    .first {
    return (match.id, match.provider)
  }
  if let fallback = filtered.first?.providers.flatMap(\.models).first {
    return (fallback.id, fallback.provider)
  }
  return nil
}

func workFilterCatalogForCursorAvailability(
  _ groups: [WorkModelCatalogGroup],
  mode: WorkCursorAvailabilityMode
) -> [WorkModelCatalogGroup] {
  groups.compactMap { group -> WorkModelCatalogGroup? in
    let providers = group.providers.compactMap { provider -> WorkModelProvider? in
      let models = provider.models.filter { model in
        workModelSupportsCursorAvailabilityMode(model, mode: mode)
      }
      guard !models.isEmpty else { return nil }
      return WorkModelProvider(key: provider.key, displayName: provider.displayName, models: models)
    }
    guard !providers.isEmpty else { return nil }
    return WorkModelCatalogGroup(key: group.key, displayName: group.displayName, providers: providers)
  }
}

/// One provider inside a group. Claude/Codex/Cursor groups almost always
/// have a single provider; OpenCode has many (Anthropic, OpenAI, Google,
/// LM Studio, Ollama, …) matching the desktop ModelCatalogPanel layout.
struct WorkModelProvider: Identifiable, Hashable {
  var id: String { key }
  /// Stable key used for logo lookup + tab state (e.g. "anthropic", "openai").
  let key: String
  let displayName: String
  let models: [WorkModelOption]
}

/// Top-level catalog group: one of CLAUDE / CODEX / CURSOR / OPENCODE. This
/// drives the first-level tab strip in the mobile picker. Exactly mirrors
/// the desktop `ModelCatalogPanel` group layout.
struct WorkModelCatalogGroup: Identifiable, Hashable {
  var id: String { key }
  /// Runtime key: "claude" | "codex" | "cursor" | "opencode".
  let key: String
  let displayName: String
  let providers: [WorkModelProvider]

  var modelCount: Int { providers.reduce(0) { $0 + $1.models.count } }
}

// Back-compat type alias + accessor so older call sites (the New Chat screen
// model picker, unit tests, search helpers, etc.) still compile while the
// picker UI migrates to the 2-level hierarchy.
typealias WorkModelProviderGroup = WorkModelCatalogGroupLegacyView

/// Legacy flat shape — kept so call sites that still iterate `.models` don't
/// need to be rewritten. A single-provider collapse of a catalog group.
struct WorkModelCatalogGroupLegacyView: Identifiable, Hashable {
  var id: String { provider }
  let provider: String
  let displayName: String
  let models: [WorkModelOption]
}

private let workModelGroupOrder = ["claude", "codex", "cursor", "droid", "opencode", "ollama", "lmstudio"]

/// Flat view of the curated catalog: every model in a single provider tab so
/// legacy call sites keep functioning. Prefer `workModelCatalogGroups` for
/// the desktop-shaped hierarchical picker.
func workModelCatalog(currentModelId: String, currentProvider: String) -> [WorkModelProviderGroup] {
  workModelCatalogGroups(currentModelId: currentModelId, currentProvider: currentProvider).map { group in
    WorkModelProviderGroup(
      provider: group.key,
      displayName: group.displayName,
      models: group.providers.flatMap { $0.models }
    )
  }
}

func workDefaultCatalogModelId(provider: String) -> String? {
  let family = providerFamilyKey(provider)
  return workCuratedModelCatalogGroups()
    .first(where: { $0.key == family })?
    .providers
    .flatMap(\.models)
    .first?
    .id
}

/// Desktop-shaped hierarchical catalog: group → provider → models. Mirrors
/// `apps/desktop/src/shared/modelRegistry.ts` + `ModelCatalogPanel` so mobile
/// users see the same CLAUDE / CODEX / CURSOR / OPENCODE tab strip and, within
/// OPENCODE, the same Anthropic / OpenAI / Google / local provider badges.
/// This remains a curated fallback/metadata source; the live picker can also
/// build the same hierarchy from host-returned `chat.models` payloads.
private func workCuratedModelCatalogGroups() -> [WorkModelCatalogGroup] {
  var groups: [WorkModelCatalogGroup] = []

  groups.append(WorkModelCatalogGroup(
    key: "claude",
    displayName: "Claude",
    providers: [
      WorkModelProvider(
        key: "anthropic",
        displayName: "Anthropic",
        models: [
          WorkModelOption(id: "claude-fable-5", displayName: "Claude Fable 5", tier: .flagship, tagline: "Flagship · 1M context", provider: "claude", serviceTiers: ["fast"]),
          WorkModelOption(id: "claude-opus-4-8", displayName: "Claude Opus 4.8 1M", tier: .flagship, tagline: "Flagship · 1M context", provider: "claude", serviceTiers: ["fast"]),
          WorkModelOption(id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tier: .flagship, tagline: "Flagship · best for complex reasoning", provider: "claude", serviceTiers: ["fast"]),
          WorkModelOption(id: "claude-opus-4-7-1m", displayName: "Claude Opus 4.7 1M", tier: .flagship, tagline: "1M-token context window", provider: "claude", serviceTiers: ["fast"]),
          WorkModelOption(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", tier: .balanced, tagline: "Balanced · great default for coding", provider: "claude"),
          WorkModelOption(id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", tier: .fast, tagline: "Fastest · cheapest", provider: "claude"),
        ]
      )
    ]
  ))

  groups.append(WorkModelCatalogGroup(
    key: "codex",
    displayName: "Codex",
    providers: [
      WorkModelProvider(
        key: "openai",
        displayName: "OpenAI",
        models: [
          WorkModelOption(id: "gpt-5.5", displayName: "GPT-5.5", tier: .flagship, tagline: "Flagship · 1M context", provider: "codex", serviceTiers: ["fast"]),
          WorkModelOption(id: "gpt-5.4", displayName: "GPT-5.4", tier: .flagship, tagline: "Affordable · 1M context", provider: "codex", serviceTiers: ["fast"]),
          WorkModelOption(id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", tier: .fast, tagline: "Cheaper 1M-context variant", provider: "codex"),
          WorkModelOption(id: "gpt-5.3-codex", displayName: "GPT-5.3-Codex", tier: .balanced, tagline: "Tuned for code edits", provider: "codex"),
          WorkModelOption(id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", tier: .fast, tagline: "Text-only Codex fast path", provider: "codex"),
          WorkModelOption(id: "gpt-5.2", displayName: "GPT-5.2", tier: .balanced, tagline: "Prior-gen GPT-5", provider: "codex"),
        ]
      )
    ]
  ))

  groups.append(WorkModelCatalogGroup(
    key: "cursor",
    displayName: "Cursor",
    providers: [
      WorkModelProvider(
        key: "anthropic",
        displayName: "Anthropic",
        models: [
          WorkModelOption(id: "claude-fable-5-thinking-high", displayName: "Claude Fable 5 Thinking High", tier: .flagship, tagline: "Cursor-routed Fable", provider: "claude"),
          WorkModelOption(id: "claude-fable-5-thinking-xhigh", displayName: "Claude Fable 5 Thinking XHigh", tier: .flagship, tagline: "Cursor-routed Fable", provider: "claude"),
          WorkModelOption(id: "claude-4.6-sonnet-thinking", displayName: "Sonnet 4.6 · Thinking", tier: .reasoning, tagline: "Extended reasoning", provider: "claude"),
          WorkModelOption(id: "claude-4.6-sonnet", displayName: "Sonnet 4.6", tier: .balanced, tagline: "Fast coding default", provider: "claude"),
        ]
      ),
      WorkModelProvider(
        key: "openai",
        displayName: "OpenAI",
        models: [
          WorkModelOption(id: "gpt-5", displayName: "GPT-5", tier: .flagship, tagline: "Flagship reasoning", provider: "codex"),
          WorkModelOption(id: "gpt-5-codex", displayName: "GPT-5 Codex", tier: .balanced, tagline: "Cursor-routed Codex", provider: "codex"),
        ]
      ),
      WorkModelProvider(
        key: "cursor",
        displayName: "Cursor",
        models: [
          WorkModelOption(id: "auto", displayName: "Auto", tier: .balanced, tagline: "Cursor picks per turn", provider: "cursor"),
        ]
      )
    ]
  ))

  groups.append(WorkModelCatalogGroup(
    key: "droid",
    displayName: "Droid",
    providers: [
      WorkModelProvider(
        key: "anthropic",
        displayName: "Anthropic (Droid)",
        models: [
          WorkModelOption(id: "claude-opus-4-6", displayName: "Opus 4.6 (2x)", tier: .flagship, tagline: "Flagship reasoning · 2x usage", provider: "claude"),
          WorkModelOption(id: "claude-opus-4-6-fast", displayName: "Opus 4.6 Fast Mode (12x)", tier: .flagship, tagline: "Faster Opus · 12x usage", provider: "claude"),
          WorkModelOption(id: "claude-opus-4-5-20251101", displayName: "Opus 4.5 (2x)", tier: .flagship, tagline: "Prior-gen Opus", provider: "claude"),
          WorkModelOption(id: "claude-sonnet-4-6", displayName: "Sonnet 4.6 (1.2x)", tier: .balanced, tagline: "Balanced default", provider: "claude"),
          WorkModelOption(id: "claude-sonnet-4-5-20250929", displayName: "Sonnet 4.5 (1.2x)", tier: .balanced, tagline: "Prior-gen Sonnet", provider: "claude"),
          WorkModelOption(id: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5 (0.4x)", tier: .fast, tagline: "Fastest Anthropic", provider: "claude"),
        ]
      ),
      WorkModelProvider(
        key: "openai",
        displayName: "OpenAI (Droid)",
        models: [
          WorkModelOption(id: "gpt-5.4", displayName: "GPT-5.4", tier: .flagship, tagline: "OpenAI flagship", provider: "codex"),
          WorkModelOption(id: "gpt-5.4-fast", displayName: "GPT-5.4 Fast", tier: .flagship, tagline: "Faster GPT-5.4", provider: "codex"),
          WorkModelOption(id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", tier: .fast, tagline: "Cheaper general-purpose", provider: "codex"),
          WorkModelOption(id: "gpt-5.3-codex", displayName: "GPT-5.3-Codex (0.7x)", tier: .balanced, tagline: "Tuned for code edits", provider: "codex"),
          WorkModelOption(id: "gpt-5.2", displayName: "GPT-5.2 (0.7x)", tier: .balanced, tagline: "Prior-gen GPT-5", provider: "codex"),
          WorkModelOption(id: "gpt-5.1", displayName: "GPT-5.1 (0.5x)", tier: .balanced, tagline: "Older GPT-5", provider: "codex"),
        ]
      ),
      WorkModelProvider(
        key: "google",
        displayName: "Google (Droid)",
        models: [
          WorkModelOption(id: "gemini-3-pro-preview", displayName: "Gemini 3 Pro", tier: .flagship, tagline: "Google flagship", provider: "google"),
          WorkModelOption(id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro (0.8x)", tier: .flagship, tagline: "Updated Gemini 3", provider: "google"),
          WorkModelOption(id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash (0.2x)", tier: .fast, tagline: "Fast Gemini", provider: "google"),
        ]
      ),
      WorkModelProvider(
        key: "factory",
        displayName: "Droid Core",
        models: [
          WorkModelOption(id: "glm-5.1", displayName: "Droid Core (GLM-5.1)", tier: .balanced, tagline: "Latest Droid Core", provider: "factory"),
          WorkModelOption(id: "glm-5", displayName: "Droid Core (GLM-5) (0.4x)", tier: .balanced, tagline: "GLM-5 backbone", provider: "factory"),
          WorkModelOption(id: "glm-4.7", displayName: "Droid Core (GLM-4.7) (0.25x)", tier: .fast, tagline: "Lightweight GLM", provider: "factory"),
          WorkModelOption(id: "kimi-k2.5", displayName: "Droid Core (Kimi K2.5) (0.25x)", tier: .fast, tagline: "Kimi backbone", provider: "factory"),
          WorkModelOption(id: "minimax-m2.5", displayName: "Droid Core (MiniMax M2.5) (0.12x)", tier: .fast, tagline: "MiniMax backbone", provider: "factory"),
        ]
      )
    ]
  ))

  groups.append(WorkModelCatalogGroup(
    key: "opencode",
    displayName: "OpenCode",
    providers: [
      WorkModelProvider(
        key: "anthropic",
        displayName: "Anthropic",
        models: [
          WorkModelOption(id: "opencode/anthropic/claude-fable-5", displayName: "Claude Fable 5", tier: .flagship, tagline: "Flagship · 1M context", provider: "claude", serviceTiers: ["fast"]),
          WorkModelOption(id: "opencode/anthropic/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", tier: .balanced, tagline: "Balanced coder", provider: "claude"),
          WorkModelOption(id: "opencode/anthropic/claude-opus-4-8", displayName: "Claude Opus 4.8 1M", tier: .flagship, tagline: "Flagship reasoning · 1M context", provider: "claude", serviceTiers: ["fast"]),
          WorkModelOption(id: "opencode/anthropic/claude-opus-4-7", displayName: "Claude Opus 4.7", tier: .flagship, tagline: "Flagship reasoning", provider: "claude", serviceTiers: ["fast"]),
          WorkModelOption(id: "opencode/anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5", tier: .fast, tagline: "Fastest Anthropic", provider: "claude"),
        ]
      ),
      WorkModelProvider(
        key: "openai",
        displayName: "OpenAI",
        models: [
          WorkModelOption(id: "opencode/openai/gpt-5.4", displayName: "GPT-5.4", tier: .flagship, tagline: "OpenAI flagship", provider: "codex", serviceTiers: ["fast"]),
          WorkModelOption(id: "opencode/openai/gpt-5.3-codex", displayName: "GPT-5.3-Codex", tier: .balanced, tagline: "Codex via OpenCode", provider: "codex"),
          WorkModelOption(id: "opencode/openai/gpt-4.1-mini", displayName: "GPT-4.1 Mini", tier: .fast, tagline: "Affordable general-purpose", provider: "codex"),
        ]
      ),
      WorkModelProvider(
        key: "google",
        displayName: "Google",
        models: [
          WorkModelOption(id: "opencode/google/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", tier: .fast, tagline: "Fast general-purpose", provider: "google"),
          WorkModelOption(id: "opencode/google/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", tier: .balanced, tagline: "Balanced Gemini", provider: "google"),
        ]
      ),
      WorkModelProvider(
        key: "xai",
        displayName: "xAI",
        models: [
          WorkModelOption(id: "opencode/xai/grok-code", displayName: "Grok Code", tier: .balanced, tagline: "xAI coder", provider: "xai"),
        ]
      ),
      WorkModelProvider(
        key: "deepseek",
        displayName: "DeepSeek",
        models: [
          WorkModelOption(id: "opencode/deepseek/deepseek-chat", displayName: "DeepSeek Chat", tier: .balanced, tagline: "DeepSeek chat", provider: "deepseek"),
          WorkModelOption(id: "opencode/deepseek/deepseek-coder", displayName: "DeepSeek Coder", tier: .balanced, tagline: "DeepSeek coder", provider: "deepseek"),
        ]
      )
    ]
  ))

  return groups
}

/// Curated catalog with the current live model injected when needed.
func workModelCatalogGroups(currentModelId: String, currentProvider: String) -> [WorkModelCatalogGroup] {
  injectCurrentWorkModelIfNeeded(
    into: workCuratedModelCatalogGroups(),
    currentModelId: currentModelId,
    currentProvider: currentProvider
  )
}

/// Live host-driven catalog used by the mobile Work picker. The host decides
/// which models exist per runtime; the local metadata only fills in friendly
/// tiers/taglines and ordering.
func workModelCatalogGroups(
  availableModelsByProvider: [String: [AgentChatModelInfo]],
  currentModelId: String,
  currentProvider: String
) -> [WorkModelCatalogGroup] {
  let curatedGroups = workCuratedModelCatalogGroups()
  let curatedModelLookup = workCuratedModelLookup(from: curatedGroups)

  var groups: [WorkModelCatalogGroup] = []
  for groupKey in workModelGroupOrder {
    let availableModels = availableModelsByProvider[groupKey] ?? []
    guard !availableModels.isEmpty else { continue }

    var modelsByProvider: [String: [WorkModelOption]] = [:]
    for model in availableModels {
      let providerKey = workModelProviderKey(for: model, topLevelProvider: groupKey)
      let curated = workCuratedModelLookupMatch(for: model, in: curatedModelLookup)
      let option = workDynamicModelOption(
        from: model,
        topLevelProvider: groupKey,
        providerKey: providerKey,
        curated: curated
      )
      modelsByProvider[providerKey, default: []].append(option)
    }

    let providers = modelsByProvider.keys.sorted { lhs, rhs in
      let lhsOrder = workProviderSortOrder(groupKey: groupKey, providerKey: lhs, curatedGroups: curatedGroups)
      let rhsOrder = workProviderSortOrder(groupKey: groupKey, providerKey: rhs, curatedGroups: curatedGroups)
      if lhsOrder != rhsOrder { return lhsOrder < rhsOrder }
      return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
    }.compactMap { providerKey -> WorkModelProvider? in
      let sortedModels = workDeduplicatedModelOptions(modelsByProvider[providerKey, default: []]).sorted { lhs, rhs in
        let lhsOrder = workModelSortOrder(groupKey: groupKey, providerKey: providerKey, modelId: lhs.id, curatedGroups: curatedGroups)
        let rhsOrder = workModelSortOrder(groupKey: groupKey, providerKey: providerKey, modelId: rhs.id, curatedGroups: curatedGroups)
        if lhsOrder != rhsOrder { return lhsOrder < rhsOrder }
        return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
      }
      guard !sortedModels.isEmpty else { return nil }
      return WorkModelProvider(
        key: providerKey,
        displayName: workProviderDisplayName(groupKey: groupKey, providerKey: providerKey, curatedGroups: curatedGroups),
        models: sortedModels
      )
    }

    guard !providers.isEmpty else { continue }
    let displayName = curatedGroups.first(where: { $0.key == groupKey })?.displayName ?? providerLabel(groupKey)
    groups.append(WorkModelCatalogGroup(key: groupKey, displayName: displayName, providers: providers))
  }

  return injectCurrentWorkModelIfNeeded(
    into: groups,
    currentModelId: currentModelId,
    currentProvider: currentProvider
  )
}

func workModelCatalogGroups(
  hostCatalog: AgentChatModelCatalog,
  currentModelId: String,
  currentProvider: String
) -> [WorkModelCatalogGroup] {
  let groups = hostCatalog.groups.map { group in
    WorkModelCatalogGroup(
      key: group.key,
      displayName: group.displayName,
      providers: group.providers.map { provider in
        let models = provider.subsections
          .flatMap(\.models)
	          .map { model in
            workCatalogModelOption(
              from: model,
              topLevelProvider: group.key,
              providerKey: provider.key
            )
          }
        return WorkModelProvider(
          key: provider.key,
          displayName: provider.displayName,
          models: workDeduplicatedModelOptions(models)
        )
      }
	      .filter { !$0.models.isEmpty }
    )
  }
  .filter { !$0.providers.isEmpty }

  return injectCurrentWorkModelIfNeeded(
    into: groups,
    currentModelId: currentModelId,
    currentProvider: currentProvider
  )
}

private func workCatalogModelOption(
  from model: AgentChatModelCatalogModel,
  topLevelProvider: String,
  providerKey: String
) -> WorkModelOption {
  let displayName = model.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    ? model.id
    : model.displayName
  let trimmedDescription = model.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let tagline: String
  if !trimmedDescription.isEmpty, trimmedDescription.localizedCaseInsensitiveCompare(displayName) != .orderedSame {
    tagline = trimmedDescription
  } else {
    var parts: [String] = []
    if model.isDefault {
      parts.append("Default on the paired machine")
    }
    if model.supportsReasoning == true {
      parts.append("Reasoning")
    }
    if model.supportsTools == true {
      parts.append("Tools")
    }
	    tagline = model.isAvailable
	      ? (parts.isEmpty ? "Available on the paired machine" : parts.joined(separator: " · "))
	      : "Configure this provider on the paired machine"
  }

  return WorkModelOption(
    id: model.id,
    displayName: displayName,
    tier: workDynamicModelTier(for: model.id),
    tagline: tagline,
    provider: workModelBrandKey(topLevelProvider: topLevelProvider, providerKey: providerKey),
    reasoningEfforts: model.reasoningEfforts ?? [],
    serviceTiers: model.serviceTiers ?? [],
    cursorAvailability: model.cursorAvailability,
    isAvailable: model.isAvailable
  )
}

private func workCuratedModelLookup(from groups: [WorkModelCatalogGroup]) -> [String: WorkModelOption] {
  var lookup: [String: WorkModelOption] = [:]
  for group in groups {
    for provider in group.providers {
      for model in provider.models {
        for key in workModelLookupKeys(model.id) {
          lookup[key] = model
        }
      }
    }
  }
  return lookup
}

private func workCuratedModelLookupMatch(
  for model: AgentChatModelInfo,
  in lookup: [String: WorkModelOption]
) -> WorkModelOption? {
  for key in workModelLookupKeys(model.id) {
    if let match = lookup[key] { return match }
  }
  if let canonical = model.modelId {
    for key in workModelLookupKeys(canonical) {
      if let match = lookup[key] { return match }
    }
  }
  return nil
}

private func workModelLookupKeys(_ raw: String?) -> [String] {
  let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !trimmed.isEmpty else { return [] }

  var keys: [String] = []
  func append(_ value: String) {
    let key = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if !key.isEmpty && !keys.contains(key) {
      keys.append(key)
    }
  }

  append(trimmed)
  if let registryId = workCanonicalClaudeRegistryId(for: trimmed) {
    append(registryId)
  }
  if let registryId = workCanonicalCodexRegistryId(for: trimmed) {
    append(registryId)
  }
  if let runtimeId = workClaudeRuntimeModelId(for: trimmed) {
    append(runtimeId)
  }
  if let runtimeId = workCodexRuntimeModelId(for: trimmed) {
    append(runtimeId)
  }
  if trimmed.lowercased().hasPrefix("openai/") {
    append(String(trimmed.dropFirst("openai/".count)))
  }
  if trimmed.lowercased().hasPrefix("anthropic/") {
    append(String(trimmed.dropFirst("anthropic/".count)))
  }

  return keys
}

private func workCanonicalClaudeRegistryId(for raw: String) -> String? {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "fable", "claude-fable-5", "anthropic/claude-fable-5", "anthropic/claude-fable-5-api":
    return "anthropic/claude-fable-5"
  case "claude-opus-4-8", "anthropic/claude-opus-4-8",
       "opus-4.8", "opus-4-8", "opus-4.8-1m", "opus-4.8[1m]", "opus-4-8-1m",
       "claude-opus-4-8-1m", "claude-opus-4-8[1m]", "anthropic/claude-opus-4-8-1m":
    return "anthropic/claude-opus-4-8"
  case "opus", "claude-opus-4-7", "anthropic/claude-opus-4-7":
    return "anthropic/claude-opus-4-7"
  case "opus[1m]", "opus-1m", "claude-opus-4-7-1m", "claude-opus-4-7[1m]", "anthropic/claude-opus-4-7-1m":
    return "anthropic/claude-opus-4-7-1m"
  case "sonnet", "claude-sonnet-4-6", "anthropic/claude-sonnet-4-6":
    return "anthropic/claude-sonnet-4-6"
  case "haiku", "claude-haiku-4-5", "anthropic/claude-haiku-4-5":
    return "anthropic/claude-haiku-4-5"
  default:
    return nil
  }
}

private func workClaudeRuntimeModelId(for raw: String) -> String? {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "fable", "claude-fable-5", "anthropic/claude-fable-5", "anthropic/claude-fable-5-api":
    return "claude-fable-5"
  case "claude-opus-4-8", "anthropic/claude-opus-4-8",
       "opus-4.8", "opus-4-8", "opus-4.8-1m", "opus-4.8[1m]", "opus-4-8-1m",
       "claude-opus-4-8-1m", "claude-opus-4-8[1m]", "anthropic/claude-opus-4-8-1m":
    return "claude-opus-4-8"
  case "opus", "claude-opus-4-7", "anthropic/claude-opus-4-7":
    return "claude-opus-4-7"
  case "opus[1m]", "opus-1m", "claude-opus-4-7-1m", "claude-opus-4-7[1m]", "anthropic/claude-opus-4-7-1m":
    return "claude-opus-4-7[1m]"
  case "sonnet", "claude-sonnet-4-6", "anthropic/claude-sonnet-4-6":
    return "sonnet"
  case "haiku", "claude-haiku-4-5", "anthropic/claude-haiku-4-5":
    return "haiku"
  default:
    return nil
  }
}

private func workCanonicalCodexRegistryId(for raw: String) -> String? {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "gpt-5.5", "gpt-5.5-codex", "openai/gpt-5.5", "openai/gpt-5.5-codex":
    return "openai/gpt-5.5"
  case "gpt-5.4", "gpt-5.4-codex", "openai/gpt-5.4", "openai/gpt-5.4-codex":
    return "openai/gpt-5.4"
  case "gpt-5.4-mini", "gpt-5.4-mini-codex", "openai/gpt-5.4-mini", "openai/gpt-5.4-mini-codex":
    return "openai/gpt-5.4-mini"
  case "gpt-5.3-codex", "openai/gpt-5.3-codex":
    return "openai/gpt-5.3-codex"
  case "gpt-5.3", "gpt-5.3-codex-spark", "gpt-5.3-spark", "codex-spark", "spark", "openai/gpt-5.3-codex-spark":
    return "openai/gpt-5.3-codex-spark"
  case "gpt-5.2", "gpt-5.2-codex", "openai/gpt-5.2", "openai/gpt-5.2-codex":
    return "openai/gpt-5.2"
  default:
    return nil
  }
}

private func workCodexRuntimeModelId(for raw: String) -> String? {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "gpt-5.5", "gpt-5.5-codex", "openai/gpt-5.5", "openai/gpt-5.5-codex":
    return "gpt-5.5"
  case "gpt-5.4", "gpt-5.4-codex", "openai/gpt-5.4", "openai/gpt-5.4-codex":
    return "gpt-5.4"
  case "gpt-5.4-mini", "gpt-5.4-mini-codex", "openai/gpt-5.4-mini", "openai/gpt-5.4-mini-codex":
    return "gpt-5.4-mini"
  case "gpt-5.3", "gpt-5.3-codex", "openai/gpt-5.3-codex":
    return "gpt-5.3-codex"
  case "gpt-5.3-codex-spark", "gpt-5.3-spark", "codex-spark", "spark", "openai/gpt-5.3-codex-spark":
    return "gpt-5.3-codex-spark"
  case "gpt-5.2", "gpt-5.2-codex", "openai/gpt-5.2", "openai/gpt-5.2-codex":
    return "gpt-5.2"
  default:
    return nil
  }
}

func workModelIdsEquivalent(_ lhs: String?, _ rhs: String?) -> Bool {
  let lhsKeys = Set(workModelLookupKeys(lhs))
  let rhsKeys = Set(workModelLookupKeys(rhs))
  return !lhsKeys.isDisjoint(with: rhsKeys)
}

func workKnownModelDisplayName(_ raw: String?) -> String? {
  switch raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "" {
  case "fable", "anthropic/claude-fable-5", "claude-fable-5", "opencode/anthropic/claude-fable-5":
    return "Claude Fable 5"
  case "anthropic/claude-opus-4-8", "claude-opus-4-8",
       "opus-4.8", "opus-4-8", "opus-4.8-1m", "opus-4.8[1m]", "opus-4-8-1m",
       "anthropic/claude-opus-4-8-1m", "claude-opus-4-8-1m", "claude-opus-4-8[1m]":
    return "Claude Opus 4.8 1M"
  case "opus", "anthropic/claude-opus-4-7", "claude-opus-4-7":
    return "Claude Opus 4.7"
  case "opus[1m]", "opus-1m", "anthropic/claude-opus-4-7-1m", "claude-opus-4-7-1m", "claude-opus-4-7[1m]":
    return "Claude Opus 4.7 1M"
  case "sonnet", "anthropic/claude-sonnet-4-6", "claude-sonnet-4-6":
    return "Claude Sonnet 4.6"
  case "haiku", "anthropic/claude-haiku-4-5", "claude-haiku-4-5":
    return "Claude Haiku 4.5"
  case "gpt-5.5", "gpt-5.5-codex", "openai/gpt-5.5", "openai/gpt-5.5-codex":
    return "GPT-5.5"
  case "gpt-5.4", "gpt-5.4-codex", "openai/gpt-5.4", "openai/gpt-5.4-codex":
    return "GPT-5.4"
  case "gpt-5.4-mini", "gpt-5.4-mini-codex", "openai/gpt-5.4-mini", "openai/gpt-5.4-mini-codex":
    return "GPT 5.4 Mini"
  case "gpt-5.3-codex", "openai/gpt-5.3-codex":
    return "GPT-5.3-Codex"
  case "gpt-5.3-codex-spark", "gpt-5.3-spark", "codex-spark", "spark", "openai/gpt-5.3-codex-spark":
    return "GPT-5.3-Codex-Spark"
  case "gpt-5.2", "gpt-5.2-codex", "openai/gpt-5.2", "openai/gpt-5.2-codex":
    return "GPT-5.2"
  default:
    return nil
  }
}

private func workProviderDisplayName(
  groupKey: String,
  providerKey: String,
  curatedGroups: [WorkModelCatalogGroup]
) -> String {
  if let curated = curatedGroups
    .first(where: { $0.key == groupKey })?
    .providers
    .first(where: { $0.key == providerKey }) {
    return curated.displayName
  }

  switch providerKey {
  case "anthropic": return "Anthropic"
  case "openai": return "OpenAI"
  case "google": return "Google"
  case "xai": return "xAI"
  case "deepseek": return "DeepSeek"
  case "lmstudio": return "LM Studio"
  case "openrouter": return "OpenRouter"
  case "groq": return "Groq"
  case "ollama": return "Ollama"
  case "together": return "Together"
  case "cursor": return "Cursor"
  case "factory": return "Droid Core"
  default: return providerKey.capitalized
  }
}

private func workProviderSortOrder(
  groupKey: String,
  providerKey: String,
  curatedGroups: [WorkModelCatalogGroup]
) -> Int {
  guard let group = curatedGroups.first(where: { $0.key == groupKey }) else {
    return Int.max
  }
  return group.providers.firstIndex(where: { $0.key == providerKey }) ?? Int.max - 1
}

private func workModelSortOrder(
  groupKey: String,
  providerKey: String,
  modelId: String,
  curatedGroups: [WorkModelCatalogGroup]
) -> Int {
  guard let group = curatedGroups.first(where: { $0.key == groupKey }),
        let provider = group.providers.first(where: { $0.key == providerKey }) else {
    return Int.max
  }
  return provider.models.firstIndex(where: { workModelIdsEquivalent($0.id, modelId) }) ?? Int.max - 1
}

private func workModelProviderKey(for model: AgentChatModelInfo, topLevelProvider: String) -> String {
  let normalizedId = model.id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let normalizedFamily = model.family?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""

  switch topLevelProvider {
  case "claude":
    return "anthropic"
  case "codex":
    return "openai"
  case "droid":
    // Prefer the explicit `family` field over ID substring matches so an
    // Anthropic model whose ID happens to contain "codex" (or similar) is
    // still routed to the right bucket.
    switch normalizedFamily {
    case "anthropic": return "anthropic"
    case "openai": return "openai"
    case "google": return "google"
    case "factory": return "factory"
    default: break
    }
    if normalizedId.hasPrefix("glm-") || normalizedId.hasPrefix("kimi-") || normalizedId.hasPrefix("minimax-") || normalizedId.hasPrefix("custom:") {
      return "factory"
    }
    if normalizedId.contains("claude") || normalizedId.contains("fable") || normalizedId.contains("sonnet") || normalizedId.contains("opus") || normalizedId.contains("haiku") {
      return "anthropic"
    }
    if normalizedId.contains("gpt") || normalizedId.contains("codex") {
      return "openai"
    }
    if normalizedId.contains("gemini") {
      return "google"
    }
    return normalizedFamily.isEmpty ? "factory" : normalizedFamily
  case "opencode":
    if normalizedId.hasPrefix("opencode/") {
      let parts = normalizedId.split(separator: "/", omittingEmptySubsequences: true)
      if parts.count >= 3 {
        return String(parts[1])
      }
    }
    return normalizedFamily.isEmpty ? "opencode" : normalizedFamily
  case "cursor":
    if normalizedId == "auto" || normalizedId.hasPrefix("cursor/") || normalizedId.contains("composer") {
      return "cursor"
    }
    if normalizedFamily == "cursor" {
      return "cursor"
    }
    if normalizedFamily == "anthropic" || normalizedId.contains("claude") || normalizedId.contains("fable") || normalizedId.contains("sonnet") || normalizedId.contains("opus") || normalizedId.contains("haiku") {
      return "anthropic"
    }
    if normalizedFamily == "openai" || normalizedFamily == "codex" || normalizedId.contains("gpt") || normalizedId.contains("codex") {
      return "openai"
    }
    if normalizedFamily == "google" || normalizedId.contains("gemini") {
      return "google"
    }
    if normalizedFamily == "xai" || normalizedId.contains("grok") {
      return "xai"
    }
    return normalizedFamily.isEmpty ? "cursor" : normalizedFamily
  default:
    return topLevelProvider
  }
}

private func workModelBrandKey(topLevelProvider: String, providerKey: String) -> String {
  if topLevelProvider == "claude" { return "claude" }
  if topLevelProvider == "codex" { return "codex" }

  switch providerKey {
  case "anthropic": return "claude"
  case "openai": return "codex"
  default: return providerKey
  }
}

private func workDynamicModelOption(
  from model: AgentChatModelInfo,
  topLevelProvider: String,
  providerKey: String,
  curated: WorkModelOption?
) -> WorkModelOption {
  let displayName = model.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    ? (curated?.displayName ?? model.id)
    : model.displayName
  let trimmedDescription = model.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let tagline: String
  if let curated {
    tagline = curated.tagline
  } else if !trimmedDescription.isEmpty, trimmedDescription.localizedCaseInsensitiveCompare(displayName) != .orderedSame {
    tagline = trimmedDescription
  } else {
    var parts: [String] = []
    if model.isDefault {
      parts.append("Default on the paired machine")
    }
    if model.supportsReasoning == true {
      parts.append("Reasoning")
    }
    if model.supportsTools == true {
      parts.append("Tools")
    }
    tagline = parts.isEmpty ? "Available on the paired machine" : parts.joined(separator: " · ")
  }

  return WorkModelOption(
    id: model.id,
    displayName: displayName,
    tier: workDynamicModelTier(for: model.id, curated: curated),
    tagline: tagline,
    provider: curated?.provider ?? workModelBrandKey(topLevelProvider: topLevelProvider, providerKey: providerKey),
    reasoningEfforts: model.reasoningEfforts ?? [],
    serviceTiers: model.serviceTiers ?? [],
    cursorAvailability: model.cursorAvailability
  )
}

private func workDynamicModelTier(for modelId: String, curated: WorkModelOption? = nil) -> WorkModelOption.Tier {
  if let curated { return curated.tier }
  let normalized = modelId.lowercased()
  if normalized.contains("thinking") {
    return .reasoning
  }
  if normalized.contains("mini") || normalized.contains("spark") || normalized.contains("flash") || normalized == "auto" || normalized.contains("haiku") {
    return .fast
  }
  if normalized.contains("fable") || normalized.contains("opus") || normalized.contains("gpt-5.5") || normalized == "gpt-5" {
    return .flagship
  }
  return .balanced
}

private func workDeduplicatedModelOptions(_ models: [WorkModelOption]) -> [WorkModelOption] {
  var seen = Set<String>()
  var deduplicated: [WorkModelOption] = []
  for model in models {
    if seen.insert(workModelEquivalenceKey(model.id)).inserted {
      deduplicated.append(model)
    }
  }
  return deduplicated
}

private func workModelEquivalenceKey(_ raw: String?) -> String {
  let keys = workModelLookupKeys(raw)
  return keys.first(where: { !$0.contains("/") })
    ?? keys.first
    ?? raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    ?? ""
}

private func injectCurrentWorkModelIfNeeded(
  into initialGroups: [WorkModelCatalogGroup],
  currentModelId: String,
  currentProvider: String
) -> [WorkModelCatalogGroup] {
  var groups = initialGroups

  // Ensure the live host model surfaces even when it isn't in the curated
  // or currently available list — fold it into the first provider of the
  // matching group, or append a lightweight "Other" group when no group matches.
  if !currentModelId.isEmpty {
    let alreadyPresent = groups.contains { g in
      g.providers.contains { p in p.models.contains { workModelIdsEquivalent($0.id, currentModelId) } }
    }
    if !alreadyPresent {
      let providerLower = currentProvider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let targetGroupKey = workModelCatalogGroupKey(for: currentModelId, currentProvider: currentProvider)
      let providerKey = providerLower.isEmpty ? "other" : providerLower
      let injected = WorkModelOption(
        id: currentModelId,
        displayName: currentModelId,
        tier: .balanced,
        tagline: "In use on the paired machine",
        provider: workModelBrandKey(topLevelProvider: targetGroupKey, providerKey: providerKey)
      )
      if let groupIndex = groups.firstIndex(where: { $0.key == targetGroupKey }) {
        let providers = groups[groupIndex].providers
        let providerIndex = providers.firstIndex(where: { $0.key == providerKey }) ?? providers.startIndex
        if !providers.isEmpty {
          var rebuilt = providers
          let targetProvider = rebuilt[providerIndex]
          rebuilt[providerIndex] = WorkModelProvider(
            key: targetProvider.key,
            displayName: targetProvider.displayName,
            models: [injected] + targetProvider.models
          )
          groups[groupIndex] = WorkModelCatalogGroup(
            key: groups[groupIndex].key,
            displayName: groups[groupIndex].displayName,
            providers: rebuilt
          )
        }
      } else {
        groups.append(WorkModelCatalogGroup(
          key: targetGroupKey,
          displayName: currentProvider.isEmpty ? "Other" : providerLabel(currentProvider),
          providers: [
            WorkModelProvider(
              key: providerKey,
              displayName: currentProvider.isEmpty ? "Other" : workProviderDisplayName(groupKey: targetGroupKey, providerKey: providerKey, curatedGroups: workCuratedModelCatalogGroups()),
              models: [injected]
            )
          ]
        ))
      }
    }
  }

  return groups
}

func workModelCatalogGroupKey(for currentModelId: String, currentProvider: String) -> String {
  let provider = currentProvider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let modelId = currentModelId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

  if provider == "lmstudio" || modelId.hasPrefix("opencode/lmstudio/") {
    return "lmstudio"
  }
  if provider == "ollama" || modelId.hasPrefix("opencode/ollama/") {
    return "ollama"
  }
  if provider == "droid" || provider == "factory" || modelId.hasPrefix("droid/") {
    return "droid"
  }
  if provider == "cursor" || modelId.contains("cursor/") || modelId.contains("cursor-") || modelId.contains("composer") {
    return "cursor"
  }
  if modelId.hasPrefix("opencode/") || provider == "opencode" {
    return "opencode"
  }
  if provider == "anthropic" || provider == "claude" || modelId.hasPrefix("anthropic/") || modelId.contains("claude") || modelId.contains("fable") || modelId.contains("sonnet") || modelId.contains("opus") || modelId.contains("haiku") {
    return "claude"
  }
  if provider == "openai" || provider == "codex" || modelId.hasPrefix("openai/") || modelId.contains("gpt") || modelId.contains("codex") {
    return "codex"
  }
  if ["google", "xai", "deepseek"].contains(provider) {
    return "opencode"
  }
  return provider.isEmpty ? "claude" : provider
}

/// The runtime/access provider to persist for a model id. Coerces OpenCode-routed
/// local groups (lmstudio / ollama) back to `opencode`, because New Chat and the
/// in-session controls only wire access options for the canonical providers — a
/// persisted "last used" provider of `lmstudio`/`ollama` would restore an
/// unsupported provider and silently drop the user's access settings. Mirrors the
/// coercion in `WorkModelPickerSheet.runtimeProvider(for:)`.
func workComposerRuntimeProvider(forModelId modelId: String, currentProvider: String) -> String {
  let group = workModelCatalogGroupKey(for: modelId, currentProvider: currentProvider)
  return (group == "lmstudio" || group == "ollama") ? "opencode" : group
}

func workModelTierLabel(_ tier: WorkModelOption.Tier) -> String {
  switch tier {
  case .fast: return "FAST"
  case .balanced: return "BALANCED"
  case .flagship: return "FLAGSHIP"
  case .reasoning: return "REASONING"
  }
}

func workModelTierTint(_ tier: WorkModelOption.Tier) -> Color {
  switch tier {
  case .fast: return ADEColor.success
  case .balanced: return ADEColor.accent
  case .flagship: return ADEColor.warning
  case .reasoning: return ADEColor.purpleAccent
  }
}
