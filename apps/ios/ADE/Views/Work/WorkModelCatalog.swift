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
/// The `currentModelId` + `currentProvider` hints ensure a freshly released
/// host model that isn't in the curated list still surfaces in the list.
func workModelCatalogGroups(currentModelId: String, currentProvider: String) -> [WorkModelCatalogGroup] {
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

  // Ensure the live host model surfaces even when it isn't in the curated
  // list — fold it into the first provider of the matching group, or
  // append a lightweight "Other" group when no group matches.
  if !currentModelId.isEmpty {
    let alreadyPresent = groups.contains { g in
      g.providers.contains { p in p.models.contains { $0.id == currentModelId } }
    }
    if !alreadyPresent {
      let providerLower = currentProvider.lowercased()
      let injected = WorkModelOption(
        id: currentModelId,
        displayName: currentModelId,
        tier: .balanced,
        tagline: "In use on the paired host",
        provider: providerLower.isEmpty ? "other" : providerLower
      )
      if let groupIndex = groups.firstIndex(where: { $0.key == providerLower }),
         var firstProvider = groups[groupIndex].providers.first {
        firstProvider = WorkModelProvider(
          key: firstProvider.key,
          displayName: firstProvider.displayName,
          models: [injected] + firstProvider.models
        )
        var rebuilt = groups[groupIndex].providers
        rebuilt[0] = firstProvider
        groups[groupIndex] = WorkModelCatalogGroup(
          key: groups[groupIndex].key,
          displayName: groups[groupIndex].displayName,
          providers: rebuilt
        )
      } else {
        groups.append(WorkModelCatalogGroup(
          key: providerLower.isEmpty ? "other" : providerLower,
          displayName: currentProvider.isEmpty ? "Other" : providerLabel(currentProvider),
          providers: [
            WorkModelProvider(
              key: providerLower.isEmpty ? "other" : providerLower,
              displayName: currentProvider.isEmpty ? "Other" : providerLabel(currentProvider),
              models: [injected]
            )
          ]
        ))
      }
    }
  }

  return groups
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
