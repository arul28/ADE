import Foundation
import SwiftUI

/// A single model entry that can be displayed in the mobile model picker.
/// Mirrors a subset of the desktop `ModelDescriptor` — the mobile picker
/// doesn't need pricing/tier/reasoning metadata yet, just enough to render a
/// branded row (logo + display name + tier hint) and send a `modelId` to
/// `SyncService.updateChatSession`.
struct WorkModelOption: Identifiable, Hashable {
  /// Stable sync-contract id the host accepts (e.g. "claude-opus-4-7").
  let id: String
  let displayName: String
  let tier: Tier
  /// Short one-line pitch — "Fastest · cheapest" / "Best for deep reasoning".
  let tagline: String
  /// Provider family key that maps to a `providerAssetName` logo + tint
  /// (e.g. "claude" for the CLAUDE brand avatar). For OpenCode-routed
  /// models this is still the upstream family so the logo stays brand-true.
  let provider: String
}

extension WorkModelOption {
  enum Tier: String { case fast, balanced, flagship, reasoning }
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

private let workModelGroupOrder = ["claude", "codex", "cursor", "opencode"]

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
          WorkModelOption(id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tier: .flagship, tagline: "Flagship · best for complex reasoning", provider: "claude"),
          WorkModelOption(id: "claude-opus-4-7-1m", displayName: "Claude Opus 4.7 1M", tier: .flagship, tagline: "1M-token context window", provider: "claude"),
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
          WorkModelOption(id: "gpt-5.5-codex", displayName: "GPT-5.5", tier: .flagship, tagline: "Flagship · 400K context", provider: "codex"),
          WorkModelOption(id: "gpt-5.4-codex", displayName: "GPT-5.4", tier: .flagship, tagline: "Flagship · 400K context", provider: "codex"),
          WorkModelOption(id: "gpt-5.4-mini-codex", displayName: "GPT-5.4-Mini", tier: .fast, tagline: "Cheaper 1M-context variant", provider: "codex"),
          WorkModelOption(id: "gpt-5.3-codex", displayName: "GPT-5.3-Codex", tier: .balanced, tagline: "Tuned for code edits", provider: "codex"),
          WorkModelOption(id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", tier: .balanced, tagline: "Faster Codex variant", provider: "codex"),
          WorkModelOption(id: "gpt-5.2-codex", displayName: "GPT-5.2-Codex", tier: .balanced, tagline: "Prior-gen Codex", provider: "codex"),
          WorkModelOption(id: "gpt-5.1-codex-max", displayName: "GPT-5.1-Codex-Max", tier: .flagship, tagline: "Long-running Codex turns", provider: "codex"),
          WorkModelOption(id: "gpt-5.1-codex-mini", displayName: "GPT-5.1-Codex-Mini", tier: .fast, tagline: "Lowest-cost Codex", provider: "codex"),
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
    key: "opencode",
    displayName: "OpenCode",
    providers: [
      WorkModelProvider(
        key: "anthropic",
        displayName: "Anthropic",
        models: [
          WorkModelOption(id: "opencode/anthropic/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", tier: .balanced, tagline: "Balanced coder", provider: "claude"),
          WorkModelOption(id: "opencode/anthropic/claude-opus-4-7", displayName: "Claude Opus 4.7", tier: .flagship, tagline: "Flagship reasoning", provider: "claude"),
          WorkModelOption(id: "opencode/anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5", tier: .fast, tagline: "Fastest Anthropic", provider: "claude"),
        ]
      ),
      WorkModelProvider(
        key: "openai",
        displayName: "OpenAI",
        models: [
          WorkModelOption(id: "opencode/openai/gpt-5.4", displayName: "GPT-5.4", tier: .flagship, tagline: "OpenAI flagship", provider: "codex"),
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
      ),
      WorkModelProvider(
        key: "lmstudio",
        displayName: "LM Studio",
        models: [
          WorkModelOption(id: "opencode/lmstudio/auto", displayName: "LM Studio · Auto", tier: .fast, tagline: "Local LM Studio runtime", provider: "lmstudio"),
        ]
      ),
      WorkModelProvider(
        key: "ollama",
        displayName: "Ollama",
        models: [
          WorkModelOption(id: "opencode/ollama/auto", displayName: "Ollama · Auto", tier: .fast, tagline: "Local Ollama runtime", provider: "ollama"),
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

/// Live host-driven catalog used by the mobile Work picker. This mirrors the
/// desktop wiring more closely: the host decides which models are currently
/// available per runtime, while the curated catalog only fills in friendly
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
      let option = workDynamicModelOption(
        from: model,
        topLevelProvider: groupKey,
        providerKey: providerKey,
        curated: curatedModelLookup[model.id]
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

private func workCuratedModelLookup(from groups: [WorkModelCatalogGroup]) -> [String: WorkModelOption] {
  var lookup: [String: WorkModelOption] = [:]
  for group in groups {
    for provider in group.providers {
      for model in provider.models {
        lookup[model.id] = model
      }
    }
  }
  return lookup
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
  return provider.models.firstIndex(where: { $0.id == modelId }) ?? Int.max - 1
}

private func workModelProviderKey(for model: AgentChatModelInfo, topLevelProvider: String) -> String {
  let normalizedId = model.id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let normalizedFamily = model.family?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""

  switch topLevelProvider {
  case "claude":
    return "anthropic"
  case "codex":
    return "openai"
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
    if normalizedFamily == "anthropic" || normalizedId.contains("claude") || normalizedId.contains("sonnet") || normalizedId.contains("opus") || normalizedId.contains("haiku") {
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
      parts.append("Default on the paired host")
    }
    if model.supportsReasoning == true {
      parts.append("Reasoning")
    }
    if model.supportsTools == true {
      parts.append("Tools")
    }
    tagline = parts.isEmpty ? "Available on the paired host" : parts.joined(separator: " · ")
  }

  let tier: WorkModelOption.Tier
  if let curated {
    tier = curated.tier
  } else {
    let normalized = model.id.lowercased()
    if normalized.contains("thinking") {
      tier = .reasoning
    } else if normalized.contains("mini") || normalized.contains("flash") || normalized == "auto" || normalized.contains("haiku") {
      tier = .fast
    } else if normalized.contains("opus") || normalized.contains("gpt-5.5") || normalized == "gpt-5" {
      tier = .flagship
    } else {
      tier = .balanced
    }
  }

  return WorkModelOption(
    id: model.id,
    displayName: displayName,
    tier: tier,
    tagline: tagline,
    provider: curated?.provider ?? workModelBrandKey(topLevelProvider: topLevelProvider, providerKey: providerKey)
  )
}

private func workDeduplicatedModelOptions(_ models: [WorkModelOption]) -> [WorkModelOption] {
  var seen = Set<String>()
  var deduplicated: [WorkModelOption] = []
  for model in models {
    if seen.insert(model.id).inserted {
      deduplicated.append(model)
    }
  }
  return deduplicated
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
      g.providers.contains { p in p.models.contains { $0.id == currentModelId } }
    }
    if !alreadyPresent {
      let providerLower = currentProvider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let targetGroupKey = workModelCatalogGroupKey(for: currentModelId, currentProvider: currentProvider)
      let providerKey = providerLower.isEmpty ? "other" : providerLower
      let injected = WorkModelOption(
        id: currentModelId,
        displayName: currentModelId,
        tier: .balanced,
        tagline: "In use on the paired host",
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

  if modelId.hasPrefix("opencode/") || provider == "opencode" {
    return "opencode"
  }
  if provider == "cursor" || modelId.contains("cursor/") || modelId.contains("cursor-") || modelId.contains("composer") {
    return "cursor"
  }
  if provider == "anthropic" || provider == "claude" || modelId.hasPrefix("anthropic/") || modelId.contains("claude") || modelId.contains("sonnet") || modelId.contains("opus") || modelId.contains("haiku") {
    return "claude"
  }
  if provider == "openai" || provider == "codex" || modelId.hasPrefix("openai/") || modelId.contains("gpt") || modelId.contains("codex") {
    return "codex"
  }
  if ["google", "xai", "deepseek", "lmstudio", "ollama"].contains(provider) {
    return "opencode"
  }
  return provider.isEmpty ? "claude" : provider
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
